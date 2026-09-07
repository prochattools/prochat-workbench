import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import fs from 'node:fs'
import type { Readable } from 'node:stream'
import {
  validateCliCapabilityManifest,
  type CapabilityManifestValidationIssue,
  type CliCapabilityArgumentTemplate,
  type CliCapabilityManifest
} from '@workbench/shared'
import { redactCapabilityText, type CapabilityAuthorizedExecutionContext } from './capability-runtime-enforcement.js'
import type { CapabilityJobHandler, CapabilityJobHandlerContext, CapabilityJobHandlerResult } from './capability-execution-coordinator.js'

/**
 * R18.3 deliberately admits one fixed writer shape. The broker supplies the
 * absolute artifact path; callers supply only bounded file content. There is
 * no script path, shell, environment expansion, or caller-selected root.
 */
export const ISOLATED_OUTPUT_CLI_EXECUTABLES = ['node'] as const
export const ISOLATED_OUTPUT_CLI_WRITER_SCRIPT = "await import('node:fs').then(function(x){x.writeFileSync(process.argv[1],process.argv[2],{encoding:'utf8',flag:'wx'})})"
export const ISOLATED_OUTPUT_CLI_MAX_CONTENT_BYTES = 48 * 1024
export const ISOLATED_OUTPUT_CLI_MAX_CAPTURE_BYTES = 16 * 1024

export type IsolatedOutputCliManifestValidationResult =
  | Readonly<{ ok: true; value: CliCapabilityManifest }>
  | Readonly<{ ok: false; issues: readonly CapabilityManifestValidationIssue[]; message: string }>

type RecordValue = Record<string, unknown>
type IsolatedChild = ChildProcessByStdio<null, null, Readable>

function record(value: unknown): value is RecordValue { return !!value && typeof value === 'object' && !Array.isArray(value) }
function issue(pathValue: string, code: string, message: string): CapabilityManifestValidationIssue { return { path: pathValue, code, message } }
function validationMessage(issues: readonly CapabilityManifestValidationIssue[]): string { return `Isolated-output CLI capability manifest invalid: ${issues.slice(0, 12).map(item => `${item.path} ${item.message}`).join(' ')}` }
function pathTemplates(argv: readonly CliCapabilityArgumentTemplate[]): Extract<CliCapabilityArgumentTemplate, { kind: 'path' }>[] { return argv.filter((item): item is Extract<CliCapabilityArgumentTemplate, { kind: 'path' }> => item.kind === 'path') }
function inputTemplates(argv: readonly CliCapabilityArgumentTemplate[]): Extract<CliCapabilityArgumentTemplate, { kind: 'input' }>[] { return argv.filter((item): item is Extract<CliCapabilityArgumentTemplate, { kind: 'input' }> => item.kind === 'input') }

function exactObjectKeys(schema: unknown, keys: readonly string[], required: readonly string[]): boolean {
  if (!record(schema) || schema.type !== 'object' || schema.additionalProperties !== false || !record(schema.properties) || !Array.isArray(schema.required)) return false
  return JSON.stringify(Object.keys(schema.properties).sort()) === JSON.stringify([...keys].sort()) && JSON.stringify([...schema.required].sort()) === JSON.stringify([...required].sort())
}

export function validateIsolatedOutputCliCapabilityManifest(value: unknown): IsolatedOutputCliManifestValidationResult {
  const base = validateCliCapabilityManifest(value)
  if (!base.ok) return { ok: false, issues: base.issues, message: base.message }
  const manifest = base.value
  const issues: CapabilityManifestValidationIssue[] = []
  if (manifest.writePolicy.mode !== 'artifact-only') issues.push(issue('writePolicy.mode', 'artifact_only_required', 'must be artifact-only for isolated-output CLI execution.'))
  if (manifest.networkPolicy.mode !== 'denied') issues.push(issue('networkPolicy.mode', 'network_not_allowed', 'must be denied for isolated-output CLI execution.'))
  if (manifest.cli.shell !== false) issues.push(issue('cli.shell', 'shell_not_allowed', 'must be false for isolated-output CLI execution.'))
  if (manifest.cli.environment.mode !== 'minimal' || manifest.cli.environment.inheritedKeys.length !== 0) issues.push(issue('cli.environment', 'ambient_environment', 'must use minimal environment with no inherited keys.'))
  if (manifest.cli.executable.name !== 'node') issues.push(issue('cli.executable.name', 'executable_not_isolated_writer', 'must be node for the fixed isolated writer.'))
  if (manifest.cwdPolicy.mode !== 'source-root') issues.push(issue('cwdPolicy.mode', 'cwd_not_isolated', 'must be source-root; the artifact root is not caller-selectable cwd.'))
  if (manifest.pathPolicy.mode !== 'artifact-relative' || JSON.stringify(manifest.pathPolicy.allowedRoots) !== JSON.stringify(['output']) || manifest.pathPolicy.maxPaths !== 1) issues.push(issue('pathPolicy', 'artifact_scope_required', 'must declare exactly one artifact-relative path under output.'))
  if (JSON.stringify(manifest.writePolicy.allowedPaths) !== JSON.stringify(['output']) || manifest.writePolicy.maxFiles !== 1 || manifest.writePolicy.maxBytes > ISOLATED_OUTPUT_CLI_MAX_CONTENT_BYTES) issues.push(issue('writePolicy', 'bounded_output_scope_required', 'must allow one bounded output file under output.'))
  if (!exactObjectKeys(manifest.inputSchema, ['content', 'outputPath'], ['content', 'outputPath'])) issues.push(issue('inputSchema', 'closed_writer_input_required', 'must accept only content and outputPath; caller-provided roots are not allowed.'))
  const paths = pathTemplates(manifest.cli.argv)
  const inputs = inputTemplates(manifest.cli.argv)
  const expectedLiterals = ['--input-type=module', '-e', ISOLATED_OUTPUT_CLI_WRITER_SCRIPT]
  const validArgv = manifest.cli.argv.length === 5 && manifest.cli.argv.slice(0, 3).every((item, index) => item.kind === 'literal' && item.value === expectedLiterals[index]) && paths.length === 1 && paths[0]?.input === 'outputPath' && paths[0]?.pathMode === 'artifact-relative' && inputs.length === 1 && inputs[0]?.input === 'content' && inputs[0]?.valueType === 'string'
  if (!validArgv) issues.push(issue('cli.argv', 'fixed_writer_argv_required', 'must use the fixed node writer with exactly one authorized outputPath and one content input.'))
  return issues.length > 0 ? { ok: false, issues, message: validationMessage(issues) } : { ok: true, value: manifest }
}

function inputValue(input: unknown, name: string): unknown { return record(input) ? input[name] : undefined }
function boundedArgument(value: string, label: string, maxBytes: number): string {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) throw new Error(`${label} is empty, oversized, or contains a NUL byte.`)
  return value
}

function materialize(manifest: CliCapabilityManifest, input: unknown, authorized: CapabilityAuthorizedExecutionContext): { executable: string; args: string[]; display: string } {
  const outputPath = inputValue(input, 'outputPath')
  const content = inputValue(input, 'content')
  if (typeof outputPath !== 'string' || typeof content !== 'string') throw new Error('The bounded outputPath and content inputs are required.')
  const binding = authorized.writePaths.find(item => item.requested === outputPath)
  if (!binding || !authorized.artifactRoot || !binding.canonical.startsWith(`${authorized.artifactRoot}/`)) throw new Error('The output path was not authorized inside the broker-owned artifact root.')
  const executable = resolveNodeExecutable()
  const args = ['--input-type=module', '-e', ISOLATED_OUTPUT_CLI_WRITER_SCRIPT, boundedArgument(binding.canonical, 'Authorized output path', 4_096), boundedArgument(content, 'Output content', ISOLATED_OUTPUT_CLI_MAX_CONTENT_BYTES)]
  return { executable, args, display: `${manifest.cli.executable.name} --input-type=module <fixed-writer> <broker-output> <bounded-content>` }
}

const MINIMAL_NODE_ENV: NodeJS.ProcessEnv = Object.freeze({
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',
  HOME: '/var/empty',
  CI: '1',
  NO_COLOR: '1',
  NODE_NO_WARNINGS: '1'
})

function nodeCandidates(): readonly string[] {
  return [process.execPath, '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']
}

function resolveNodeExecutable(): string {
  for (const candidate of [...new Set(nodeCandidates())]) {
    try {
      if (!fs.statSync(candidate).isFile() || (fs.statSync(candidate).mode & 0o111) === 0) continue
      const version = spawnSync(candidate, ['--version'], { env: MINIMAL_NODE_ENV, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 }).stdout.toString('utf8').trim()
      if (version === 'v20.20.2') return candidate
    } catch { /* try the next fixed, supported Node location */ }
  }
  throw new Error('Node v20.20.2 is not installed in a supported fixed location.')
}

function appendBounded(parts: Buffer[], value: Buffer, state: { bytes: number; truncated: boolean }): void {
  if (state.bytes >= ISOLATED_OUTPUT_CLI_MAX_CAPTURE_BYTES) { state.truncated = true; return }
  const chunk = value.subarray(0, ISOLATED_OUTPUT_CLI_MAX_CAPTURE_BYTES - state.bytes)
  parts.push(chunk); state.bytes += chunk.byteLength; if (chunk.byteLength < value.byteLength) state.truncated = true
}

function terminate(child: IsolatedChild): void {
  const signalProcess = (signal: NodeJS.Signals): void => {
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, signal); return } catch { /* fall back to the direct child */ }
    }
    try { child.kill(signal) } catch { /* process already exited */ }
  }
  signalProcess('SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalProcess('SIGKILL')
  }, 100).unref?.()
}

function runWriter(executable: string, args: readonly string[], cwd: string, signal: AbortSignal): Promise<{ exitCode: number | null; stderr: string; truncated: boolean; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    let child: IsolatedChild
    try { child = spawn(executable, [...args], { cwd, shell: false, env: MINIMAL_NODE_ENV, detached: true, stdio: ['ignore', 'ignore', 'pipe'] }) } catch (error) { reject(error); return }
    const stderr: Buffer[] = []
    const state = { bytes: 0, truncated: false }
    let settled = false
    const finish = (callback: () => void): void => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); callback() }
    const onAbort = (): void => terminate(child)
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true })
    child.stderr.on('data', chunk => appendBounded(stderr, Buffer.from(chunk), state))
    child.once('error', error => finish(() => reject(error)))
    child.once('close', (exitCode) => finish(() => resolve({ exitCode, stderr: Buffer.concat(stderr).toString('utf8'), truncated: state.truncated, durationMs: Math.max(0, performance.now() - startedAt) })))
  })
}

function failure(context: CapabilityJobHandlerContext, code: string, message: string, retryable = false): CapabilityJobHandlerResult {
  return { status: 'failed', resultRef: `workbench://capability-jobs/${context.job.jobId}/result`, evidenceRef: context.job.evidenceRef, failure: { code, message: redactCapabilityText(message).slice(0, 1_000), retryable } }
}

export function createIsolatedOutputCliCapabilityHandler(manifest: CliCapabilityManifest): CapabilityJobHandler {
  const validation = validateIsolatedOutputCliCapabilityManifest(manifest)
  if (!validation.ok) throw new Error(validation.message)
  return async context => {
    if (context.signal.aborted) return { status: 'cancelled', failure: { code: 'cancelled', message: 'Isolated-output CLI job was cancelled before process start.', retryable: false } }
    if (!context.authorized.cwd || !context.authorized.artifactRoot) return failure(context, 'runtime_context_missing', 'Isolated-output CLI execution requires authorized source and artifact roots.')
    let command: { executable: string; args: string[]; display: string }
    try { command = materialize(manifest, context.input, context.authorized) } catch (error) { return failure(context, 'cli_argument_rejected', error instanceof Error ? `Isolated-output CLI arguments were rejected: ${error.message}` : 'Isolated-output CLI arguments were rejected.') }
    context.reportStep('running isolated output writer')
    let result: Awaited<ReturnType<typeof runWriter>>
    try { result = await runWriter(command.executable, command.args, context.authorized.cwd, context.signal) } catch (error) { return failure(context, 'cli_process_failed', `Isolated-output CLI process could not start: ${error instanceof Error ? error.message : 'unknown process error'}.`, true) }
    if (context.signal.aborted) return { status: 'cancelled', failure: { code: 'cancelled', message: 'Isolated-output CLI job was cancelled.', retryable: false } }
    if (result.truncated) return failure(context, 'cli_stderr_bounded', 'The isolated output writer exceeded its bounded diagnostic capture.', false)
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() ? ` ${redactCapabilityText(result.stderr).slice(0, 400)}` : ''
      return failure(context, 'cli_exit_nonzero', `Isolated-output CLI '${command.display}' exited with code ${String(result.exitCode)}.${detail}`)
    }
    const content = inputValue(context.input, 'content')
    return { status: 'succeeded', output: { written: true, bytes: typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : 0, command: 'node', durationMs: Math.round(result.durationMs) } }
  }
}

export const isolatedOutputCliRuntimeContract = Object.freeze({
  mode: 'isolated-output-cli',
  executable: 'node',
  fixedWriter: true,
  shell: false,
  inheritedEnvironment: false,
  network: 'denied',
  writeAuthority: 'broker-created-artifact-root-only',
  callerSelectableRoot: false,
  overflow: 'broker-evidence-reference'
})
