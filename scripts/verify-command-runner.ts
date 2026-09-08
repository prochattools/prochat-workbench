import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getAllowedCommandKinds, runSafeCommand } from '../packages/cli/src/agent/command-runner'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-command-runner-'))
const run = (cmd: string, args: string[], cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'pipe' })
const write = (rel: string, content: string) => {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}
const expectReject = async (label: string, fn: () => Promise<unknown>) => {
  let rejected = false
  try {
    await fn()
  } catch {
    rejected = true
  }
  assert.equal(rejected, true, label)
}

async function verifyStaticAssetGitPaths() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-static-assets-git-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' })
  const put = (rel: string, content: string | Buffer) => {
    const full = path.join(repo, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  const cachedPaths = () => git(['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean).sort()
  const commandBase = { sourceId: 'static-asset-test', sourceRoot: repo }

  try {
    git(['init'])
    git(['config', 'user.email', 'buildflow@example.test'])
    git(['config', 'user.name', 'BuildFlow Test'])
    put('src/app/prochat-memory/page.tsx', 'export default function Page() { return null }\n')
    put('README.md', '# seed\n')
    put('public/package.json', '{"name":"public-template","version":"1.0.0"}\n')
    git(['add', '--', 'src/app/prochat-memory/page.tsx', 'README.md', 'public/package.json'])
    git(['commit', '-m', 'test: seed static asset repo'])

    put('src/app/prochat-memory/page.tsx', 'export default function Page() { return <main>Memory</main> }\n')
    put('public/package.json', '{"name":"public-template","version":"1.0.1"}\n')
    let result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['public/package.json'] })
    assert.equal(result.status, 'completed')
    assert.deepEqual(cachedPaths(), ['public/package.json'])
    result = await runSafeCommand({ ...commandBase, commandKind: 'git_commit', paths: ['public/package.json'], message: 'test: commit tracked public source' })
    assert.equal(result.status, 'completed')
    assert.deepEqual(git(['show', '--pretty=format:', '--name-only', 'HEAD']).trim().split('\n').filter(Boolean), ['public/package.json'])

    put('public/prochat-memory/assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>Logo</title></svg>\n')
    put('public/prochat-memory/assets/hero.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>Hero</title></svg>\n')
    put('public/other-assets/raw.bin', Buffer.from([0, 1, 2, 3]))
    put('docs/unrelated.md', 'unrelated change\n')

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['public/prochat-memory/assets/logo.svg'] })
    assert.equal(result.status, 'needs_confirmation')
    assert.equal(result.requiresConfirmation, true)
    assert.equal(result.reason, 'stage_existing_static_asset')
    assert.equal(typeof result.confirmationToken, 'string')
    assert.deepEqual((result.details as { approvalRequirements?: Array<{ reason: string; paths: string[] }> })?.approvalRequirements, [
      { reason: 'stage_existing_static_asset', paths: ['public/prochat-memory/assets/logo.svg'] }
    ])
    assert.deepEqual(cachedPaths(), [])

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['public/prochat-memory/assets/logo.svg'], confirmationToken: result.confirmationToken })
    assert.equal(result.status, 'completed')
    assert.equal(result.reason, 'stage_existing_static_asset')
    let details = result.details as {
      requestedPaths: string[]
      stagedPaths: string[]
      staticAssets?: Array<{ path: string; bytes: number; sha256: string; textLike: boolean; validation: string }>
      exactMatch: boolean
    }
    assert.equal(details.exactMatch, true)
    assert.deepEqual(details.requestedPaths, ['public/prochat-memory/assets/logo.svg'])
    assert.deepEqual(details.stagedPaths, ['public/prochat-memory/assets/logo.svg'])
    assert.equal(details.staticAssets?.length, 1)
    assert.equal(details.staticAssets?.[0]?.path, 'public/prochat-memory/assets/logo.svg')
    assert.equal(details.staticAssets?.[0]?.textLike, true)
    assert.equal(details.staticAssets?.[0]?.validation, 'text_secret_scan_passed')
    assert.equal(typeof details.staticAssets?.[0]?.sha256, 'string')
    git(['reset', '--', 'public/prochat-memory/assets/logo.svg'])

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['public/prochat-memory/assets/*.svg'], confirmedByUser: true })
    assert.equal(result.status, 'completed')
    details = result.details as typeof details & { expandedPathScopes?: Array<{ input: string; directory: string; files: string[] }> }
    assert.equal(details.exactMatch, true)
    assert.deepEqual(details.expandedPathScopes?.[0], {
      input: 'public/prochat-memory/assets/*.svg',
      directory: 'public/prochat-memory/assets',
      files: ['public/prochat-memory/assets/hero.svg', 'public/prochat-memory/assets/logo.svg']
    })
    assert.deepEqual(cachedPaths(), ['public/prochat-memory/assets/hero.svg', 'public/prochat-memory/assets/logo.svg'])
    git(['reset', '--', 'public/prochat-memory/assets/hero.svg', 'public/prochat-memory/assets/logo.svg'])

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['src/app/prochat-memory/page.tsx', 'public/prochat-memory/**'], confirmedByUser: true })
    assert.equal(result.status, 'completed')
    details = result.details as typeof details & { expandedPathScopes?: Array<{ input: string; directory: string; files: string[] }> }
    assert.equal(details.exactMatch, true)
    assert.deepEqual([...details.stagedPaths].sort(), [
      'public/prochat-memory/assets/hero.svg',
      'public/prochat-memory/assets/logo.svg',
      'src/app/prochat-memory/page.tsx'
    ])
    assert.deepEqual(details.expandedPathScopes?.[0], {
      input: 'public/prochat-memory/**',
      directory: 'public/prochat-memory',
      files: ['public/prochat-memory/assets/hero.svg', 'public/prochat-memory/assets/logo.svg']
    })
    assert(!cachedPaths().includes('docs/unrelated.md'))
    assert(!cachedPaths().includes('public/other-assets/raw.bin'))

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_commit', paths: ['src/app/prochat-memory/page.tsx', 'public/prochat-memory/**'], message: 'test: commit approved static assets', confirmedByUser: true })
    assert.equal(result.status, 'completed')
    const committedPaths = git(['show', '--pretty=format:', '--name-only', 'HEAD']).trim().split('\n').filter(Boolean).sort()
    assert.deepEqual(committedPaths, [
      'public/prochat-memory/assets/hero.svg',
      'public/prochat-memory/assets/logo.svg',
      'src/app/prochat-memory/page.tsx'
    ])
    const unrelatedStatus = git(['status', '--short', '--', 'docs/unrelated.md', 'public/other-assets/raw.bin'])
    assert(unrelatedStatus.includes('docs/unrelated.md'))
    assert(unrelatedStatus.includes('public/other-assets/raw.bin'))

    put('public/prochat-memory/assets/raw.bin', Buffer.from([0, 1, 2, 3]))
    await expectReject('git_add_paths blocks broad static asset directory scopes', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['public/**'], confirmedByUser: true }))
    await expectReject('git_add_paths blocks unsupported static asset extensions by exact path', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['public/prochat-memory/assets/raw.bin'], confirmedByUser: true }))
    await expectReject('git_add_paths blocks approved directory scopes containing unsupported assets atomically', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['public/prochat-memory/**'], confirmedByUser: true }))
    assert(!cachedPaths().includes('public/prochat-memory/assets/raw.bin'))

    console.log('✓ static asset staging and commit policy checks passed')
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
}

async function verifyExtensionlessGitPaths() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-extensionless-git-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-extensionless-outside-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' })
  const put = (rel: string, content: string) => {
    const full = path.join(repo, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  const cachedPaths = () => git(['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean).sort()
  const extensionlessPaths = Array.from({ length: 10 }, (_, index) => `docs/example/channel/scripts/${String(index + 1).padStart(3, '0')}`)
  const requestedPaths = [
    'docs/example/README.md',
    'docs/example/channel/README.md',
    ...extensionlessPaths
  ]
  const modifiedExtensionless = [extensionlessPaths[0], extensionlessPaths[1], extensionlessPaths[3], extensionlessPaths[4], extensionlessPaths[8]]
  const deletedExtensionless = [extensionlessPaths[2], extensionlessPaths[5], extensionlessPaths[6], extensionlessPaths[7], extensionlessPaths[9]]
  const binaryExtensionless = 'docs/example/channel/scripts/binary'
  const commandBase = { sourceId: 'extensionless-test', sourceRoot: repo }

  try {
    git(['init'])
    git(['config', 'user.email', 'buildflow@example.test'])
    git(['config', 'user.name', 'BuildFlow Test'])
    put(requestedPaths[0], '# Initial channel\n')
    put(requestedPaths[1], '# Initial scripts\n')
    extensionlessPaths.forEach((rel, index) => put(rel, `initial ${index + 1}\n`))
    put('LICENSE', 'initial license\n')
    fs.writeFileSync(path.join(repo, binaryExtensionless), Buffer.from([0, 1, 2, 3]))
    put('notes/unrelated.md', 'initial unrelated\n')
    git(['add', '--', ...requestedPaths, 'LICENSE', binaryExtensionless, 'notes/unrelated.md'])
    git(['commit', '-m', 'test: seed extensionless fixtures'])

    put('LICENSE', 'updated license\n')
    let result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['LICENSE'] })
    assert.equal(result.status, 'needs_confirmation')
    assert.equal(result.reason, 'confirmation_required_path')
    assert.equal(typeof result.confirmationToken, 'string')
    const addLicenseToken = result.confirmationToken
    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['LICENSE'], confirmationToken: 'confirm:invalid' })
    assert.equal(result.status, 'needs_confirmation')
    assert.equal(result.reason, 'confirmation_required_path')
    assert.deepEqual(cachedPaths(), [])
    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['LICENSE'], confirmationToken: addLicenseToken })
    assert.equal(result.status, 'completed')
    assert.equal(result.reason, 'confirmation_required_path')
    result = await runSafeCommand({ ...commandBase, commandKind: 'git_commit', paths: ['LICENSE'], message: 'test: update license' })
    assert.equal(result.status, 'needs_confirmation')
    assert.equal(result.reason, 'confirmation_required_path')
    assert.equal(typeof result.confirmationToken, 'string')
    const commitLicenseToken = result.confirmationToken
    result = await runSafeCommand({ ...commandBase, commandKind: 'git_commit', paths: ['LICENSE'], message: 'test: update license', confirmationToken: 'confirm:invalid' })
    assert.equal(result.status, 'needs_confirmation')
    assert.equal(result.reason, 'confirmation_required_path')
    result = await runSafeCommand({ ...commandBase, commandKind: 'git_commit', paths: ['LICENSE'], message: 'test: update license', confirmationToken: commitLicenseToken })
    assert.equal(result.status, 'completed')
    assert.equal(result.reason, 'confirmation_required_path')

    fs.rmSync(path.join(repo, binaryExtensionless))
    await expectReject('git_add_paths rejects a deleted extensionless binary even with confirmation', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: [binaryExtensionless], confirmedByUser: true }))
    assert.deepEqual(cachedPaths(), [])
    git(['checkout', '--', binaryExtensionless])

    put(requestedPaths[0], '# Updated channel\n')
    put(requestedPaths[1], '# Updated scripts\n')
    modifiedExtensionless.forEach((rel, index) => put(rel, `modified ${index + 1}\n`))
    deletedExtensionless.forEach(rel => fs.rmSync(path.join(repo, rel)))
    put('notes/unrelated.md', 'changed but unstaged\n')
    put('kanban.md', 'untracked and unrelated\n')

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: requestedPaths })
    assert.equal(result.status, 'completed')
    const exactDetails = result.details as {
      requestedPaths: string[]
      stagedPaths: string[]
      stagedStatuses: Array<{ status: string; path: string }>
      unrelatedStagedPaths: string[]
      missingStagedPaths: string[]
      exactMatch: boolean
    }
    assert.equal(exactDetails.exactMatch, true)
    assert.deepEqual([...exactDetails.requestedPaths].sort(), [...requestedPaths].sort())
    assert.deepEqual([...exactDetails.stagedPaths].sort(), [...requestedPaths].sort())
    assert.deepEqual(exactDetails.unrelatedStagedPaths, [])
    assert.deepEqual(exactDetails.missingStagedPaths, [])
    assert.deepEqual(cachedPaths(), [...requestedPaths].sort())
    for (const rel of deletedExtensionless) {
      assert(exactDetails.stagedStatuses.some(item => item.path === rel && item.status.startsWith('D')), `${rel} must be staged as deleted`)
    }
    assert(!cachedPaths().includes('notes/unrelated.md'))
    assert(!cachedPaths().includes('kanban.md'))

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: requestedPaths })
    assert.equal(result.status, 'completed')
    assert.equal((result.details as { exactMatch?: boolean }).exactMatch, true)
    assert.deepEqual(cachedPaths(), [...requestedPaths].sort())

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_commit', paths: requestedPaths, message: 'test: commit exact extensionless set' })
    assert.equal(result.status, 'completed')
    const committedPaths = git(['show', '--pretty=format:', '--name-only', 'HEAD']).trim().split('\n').filter(Boolean).sort()
    assert.deepEqual(committedPaths, [...requestedPaths].sort())
    const unrelatedStatus = git(['status', '--short', '--', 'notes/unrelated.md', 'kanban.md'])
    assert(unrelatedStatus.includes('notes/unrelated.md'))
    assert(unrelatedStatus.includes('kanban.md'))

    put('scripts/untracked-command', 'untracked extensionless text\n')
    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['scripts/untracked-command', 'scripts/untracked-command'] })
    assert.equal(result.status, 'completed')
    const dedupedDetails = result.details as { exactMatch?: boolean; requestedPaths?: string[] }
    assert.equal(dedupedDetails.exactMatch, true)
    assert.deepEqual(dedupedDetails.requestedPaths, ['scripts/untracked-command'])
    git(['reset', '--', 'scripts/untracked-command'])
    fs.rmSync(path.join(repo, 'scripts/untracked-command'))

    const disallowedUntracked = 'wiki/example/channel/scripts/untracked'
    put(disallowedUntracked, 'outside ordinary write roots\n')
    await expectReject('git_add_paths rejects untracked extensionless files outside ordinary write roots', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: [disallowedUntracked] }))
    fs.rmSync(path.join(repo, disallowedUntracked))

    const webUntracked = 'apps/web/src/app/verify-command-runner-untracked'
    put(webUntracked, 'apps web extensionless source\\n')
    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: [webUntracked] })
    assert.equal(result.status, 'completed')
    git(['reset', '--', webUntracked])
    fs.rmSync(path.join(repo, webUntracked))

    fs.mkdirSync(path.join(repo, 'scripts/directory'), { recursive: true })
    await expectReject('git_add_paths rejects explicit directories', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['scripts/directory'] }))
    fs.rmSync(path.join(repo, 'scripts/directory'), { recursive: true })

    fs.writeFileSync(path.join(repo, 'scripts/oversized-command'), Buffer.alloc(1_000_001, 65))
    await expectReject('git_add_paths rejects oversized extensionless files consistently', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['scripts/oversized-command'] }))
    fs.rmSync(path.join(repo, 'scripts/oversized-command'))
    await expectReject('git_add_paths rejects control characters in paths', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['scripts/bad\nname'] }))

    if (process.platform !== 'win32') {
      put('scripts/*', 'literal wildcard filename\n')
      put('scripts/pathspec-neighbor', 'must remain untracked\n')
      result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['scripts/*'] })
      assert.equal(result.status, 'completed')
      const literalDetails = result.details as { exactMatch?: boolean; stagedPaths?: string[] }
      assert.equal(literalDetails.exactMatch, true)
      assert.deepEqual(literalDetails.stagedPaths, ['scripts/*'])
      assert(!cachedPaths().includes('scripts/pathspec-neighbor'))
      git(['reset', '--', 'scripts/*'])
      fs.rmSync(path.join(repo, 'scripts/*'))
      fs.rmSync(path.join(repo, 'scripts/pathspec-neighbor'))
    }

    put(extensionlessPaths[0], 'valid change before atomic rejection\n')
    const cachedBeforeRejectedRequest = cachedPaths()
    await expectReject('git_add_paths rejects an atomic set containing .git/config', () => runSafeCommand({
      ...commandBase,
      commandKind: 'git_add_paths',
      paths: [extensionlessPaths[0], '.git/config']
    }))
    assert.deepEqual(cachedPaths(), cachedBeforeRejectedRequest)
    await expectReject('git_add_paths rejects traversal for extensionless paths', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['../outside-file'] }))
    await expectReject('git_add_paths rejects absolute extensionless paths', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: [path.join(repo, extensionlessPaths[0])] }))
    await expectReject('git_add_paths rejects prohibited .git/config', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['.git/config'] }))

    if (process.platform !== 'win32') {
      const outsideFile = path.join(outside, 'outside-file')
      fs.writeFileSync(outsideFile, 'outside\n')
      const symlinkPath = path.join(repo, 'scripts', 'escape')
      fs.mkdirSync(path.dirname(symlinkPath), { recursive: true })
      fs.symlinkSync(outsideFile, symlinkPath)
      await expectReject('git_add_paths rejects symlink escapes', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['scripts/escape'] }))
      fs.rmSync(symlinkPath)
    }

    put('notes/unrelated.md', 'pre-staged unrelated change\n')
    git(['add', '--', 'notes/unrelated.md'])
    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: [extensionlessPaths[0]] })
    assert.equal(result.status, 'completed')
    assert.equal((result.details as { exactMatch?: boolean }).exactMatch, false)
    assert((result.details as { unrelatedStagedPaths: string[] }).unrelatedStagedPaths.includes('notes/unrelated.md'))

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_commit', paths: [extensionlessPaths[0]], message: 'test: must not commit mismatched set' })
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'staged_path_set_mismatch')
    const mismatchDetails = result.details as { exactMatch: boolean; unrelatedStagedPaths: string[] }
    assert.equal(mismatchDetails.exactMatch, false)
    assert(mismatchDetails.unrelatedStagedPaths.includes('notes/unrelated.md'))
    assert.equal(git(['log', '-1', '--pretty=%s']).trim(), 'test: commit exact extensionless set')
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
}

async function main() {
await verifyStaticAssetGitPaths()
await verifyExtensionlessGitPaths()
run('git', ['init'])
run('git', ['config', 'user.email', 'buildflow@example.test'])
run('git', ['config', 'user.name', 'BuildFlow Test'])
write('src/a.ts', 'export const a = 1\n')
write('src/config.json', '{"ok":true}\n')
write('src/not-json.ts', 'export {}\n')
write('.env.example', 'EXAMPLE_PLACEHOLDER=<token>\n')
write('pkg/package.json', JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } }, null, 2))
write('src/scan.ts', `const value = "${'g' + 'hp_FAKE_TOKEN_FOR_REDACTION_ONLY'}"\n`)
write('src/network-safe.test.ts', [
  "import assert from 'node:assert/strict'",
  "const source = 'export function preview() { return null }'",
  "assert.equal(source.includes('fetch('), false)",
  "const networkMarker = ['fetch', '('].join('')",
  "const fixture = `fetch('/api/data')`",
  "// This module must not call fetch.",
  "it('does not use fetch', () => { assert.equal(source.includes(networkMarker), false) })",
  ''
].join('\n'))
write('src/network-unsafe.test.ts', [
  "import fetchClient from 'node-fetch'",
  "import axios from 'axios'",
  "void fetchClient",
  "void axios",
  "fetch('/api/data')",
  "globalThis.fetch('/api/global')",
  "window.fetch('/api/window')",
  "self.fetch('/api/self')",
  "axios.get('/api/axios')",
  "it('still detects real calls in tests', async () => { await fetch('/api/test') })",
  ''
].join('\n'))
write('docs/network-example.md', "fetch('/api/data')\n")

const base = { sourceId: 'test', sourceRoot: root }
const kinds = getAllowedCommandKinds()
assert(kinds.includes('git_diff_cached_stat'))
assert(kinds.includes('git_diff_cached_name_only'))
assert(kinds.includes('git_add_paths'))
assert(kinds.includes('git_commit'))
assert(kinds.includes('git_push'))
assert(kinds.includes('validate_json_files'))
assert(kinds.includes('run_package_script'))
assert(kinds.includes('run_package_test'))
assert(kinds.includes('run_package_test_marker'))
assert(kinds.includes('security_scan_paths'))
assert(kinds.includes('n8n_workflow_export'))

await expectReject('git_add_paths rejects dot', () => runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['.'] }))
await expectReject('git_add_paths rejects -A', () => runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['-A'] }))
await expectReject('git_add_paths rejects traversal', () => runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['../outside.ts'] }))
await expectReject('git_commit requires staged changes', () => runSafeCommand({ ...base, commandKind: 'git_commit', message: 'test commit', confirmedByUser: true }))

await expectReject('git_add_paths rejects environment template paths under the connected-repository security boundary', () => runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['src/a.ts', '.env.example'] }))
let result = await runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['src/a.ts'] })
assert.equal(result.status, 'completed')
result = await runSafeCommand({ ...base, commandKind: 'git_diff_cached_name_only' })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('src/a.ts'))
await expectReject('git_commit rejects secret-looking message', () => runSafeCommand({ ...base, commandKind: 'git_commit', message: 'leak ' + 's' + 'k_live_fake', confirmedByUser: true }))
result = await runSafeCommand({ ...base, commandKind: 'git_commit', message: 'test: add fixture', confirmedByUser: true })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('test: add fixture'))

write('public/assets/file.pdf', 'fake pdf\n')
run('git', ['add', '--', 'public/assets/file.pdf'])
run('git', ['commit', '-m', 'test: add tracked asset'])
fs.rmSync(path.join(root, 'public/assets/file.pdf'))
result = await runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['public/assets/file.pdf'] })
assert.equal(result.status, 'needs_confirmation')
assert.equal(result.reason, 'binary_delete_confirmation')
assert.equal(typeof result.confirmationToken, 'string')
const addTrackedBinaryDeleteToken = result.confirmationToken
result = await runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['public/assets/file.pdf'], confirmationToken: addTrackedBinaryDeleteToken })
assert.equal(result.status, 'completed')
assert.equal(result.reason, 'binary_delete_confirmation')
result = await runSafeCommand({ ...base, commandKind: 'git_diff_cached_name_only' })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('public/assets/file.pdf'))
result = await runSafeCommand({ ...base, commandKind: 'git_commit', message: 'test: delete tracked asset' })
assert.equal(result.status, 'needs_confirmation')
assert.equal(result.reason, 'binary_delete_confirmation')
assert.equal(typeof result.confirmationToken, 'string')
const commitTrackedBinaryDeleteToken = result.confirmationToken
result = await runSafeCommand({ ...base, commandKind: 'git_commit', message: 'test: delete tracked asset', confirmationToken: commitTrackedBinaryDeleteToken })
assert.equal(result.status, 'completed')
assert.equal(result.reason, 'binary_delete_confirmation')
assert(result.stdout.includes('test: delete tracked asset'))
write('public/assets/tracked.png', 'tracked asset v1\n')
run('git', ['add', '--', 'public/assets/tracked.png'])
run('git', ['commit', '-m', 'test: add tracked binary asset'])
write('public/assets/tracked.png', 'tracked asset v2\n')
await expectReject('git_add_paths rejects tracked binary asset modification even with confirmation', () => runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['public/assets/tracked.png'], confirmedByUser: true }))
run('git', ['checkout', '--', 'public/assets/tracked.png'])

write('public/prochat-memory/assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>Logo</title></svg>\n')
result = await runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['public/prochat-memory/assets/logo.svg'] })
assert.equal(result.status, 'needs_confirmation')
assert.equal(result.reason, 'stage_existing_static_asset')
assert.equal(typeof result.confirmationToken, 'string')
const staticSvgToken = result.confirmationToken
result = await runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['public/prochat-memory/assets/logo.svg'], confirmationToken: staticSvgToken })
assert.equal(result.status, 'completed')
assert.equal(result.reason, 'stage_existing_static_asset')
const svgDetails = result.details as { exactMatch?: boolean; stagedPaths?: string[]; staticAssets?: Array<{ path: string; bytes: number; sha256: string; textLike: boolean; validation: string }> }
assert.equal(svgDetails.exactMatch, true)
assert.deepEqual(svgDetails.stagedPaths, ['public/prochat-memory/assets/logo.svg'])
assert.equal(svgDetails.staticAssets?.[0]?.path, 'public/prochat-memory/assets/logo.svg')
assert.equal(svgDetails.staticAssets?.[0]?.textLike, true)
assert.equal(typeof svgDetails.staticAssets?.[0]?.sha256, 'string')
result = await runSafeCommand({ ...base, commandKind: 'git_commit', paths: ['public/prochat-memory/assets/logo.svg'], message: 'test: commit approved svg asset', confirmedByUser: true })
assert.equal(result.status, 'completed')

write('public/prochat-memory/assets/hero.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>Hero</title></svg>\n')
write('public/prochat-memory/assets/card.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>Card</title></svg>\n')
write('notes/unrelated-static.md', 'must remain untracked\n')
await expectReject('git_add_paths rejects broad public directory scopes', () => runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['public/**'], confirmedByUser: true }))
result = await runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['public/prochat-memory/**'], confirmedByUser: true })
assert.equal(result.status, 'completed')
const scopeDetails = result.details as { exactMatch?: boolean; stagedPaths?: string[]; expandedPathScopes?: Array<{ input: string; directory: string; files: string[] }>; staticAssets?: Array<{ path: string; bytes: number; sha256: string; textLike: boolean; validation: string }> }
assert.equal(scopeDetails.exactMatch, true)
assert.deepEqual(scopeDetails.expandedPathScopes?.[0]?.files, ['public/prochat-memory/assets/card.svg', 'public/prochat-memory/assets/hero.svg'])
assert.deepEqual(scopeDetails.stagedPaths, ['public/prochat-memory/assets/card.svg', 'public/prochat-memory/assets/hero.svg'])
assert.equal(scopeDetails.staticAssets?.length, 2)
const scopedCachedPaths = run('git', ['diff', '--cached', '--name-only']).toString().trim().split('\n').filter(Boolean)
assert(!scopedCachedPaths.includes('notes/unrelated-static.md'))
result = await runSafeCommand({ ...base, commandKind: 'git_commit', paths: ['public/prochat-memory/**'], message: 'test: commit approved svg directory scope', confirmedByUser: true })
assert.equal(result.status, 'completed')
const scopedCommittedPaths = run('git', ['show', '--pretty=format:', '--name-only', 'HEAD']).toString().trim().split('\n').filter(Boolean).sort()
assert.deepEqual(scopedCommittedPaths, ['public/prochat-memory/assets/card.svg', 'public/prochat-memory/assets/hero.svg'])
assert(run('git', ['status', '--short', '--', 'notes/unrelated-static.md']).toString().includes('notes/unrelated-static.md'))

await expectReject('git_push rejects force flag branch', () => runSafeCommand({ ...base, commandKind: 'git_push', branch: '--force', confirmedByUser: true }))
await expectReject('git_push rejects refspec branch', () => runSafeCommand({ ...base, commandKind: 'git_push', branch: 'main:evil', confirmedByUser: true }))

result = await runSafeCommand({ ...base, commandKind: 'validate_json_files', paths: ['src/config.json'] })
assert.equal(result.status, 'completed')
await expectReject('validate_json_files rejects non-json', () => runSafeCommand({ ...base, commandKind: 'validate_json_files', paths: ['src/not-json.ts'] }))
await expectReject('run_package_script rejects unsafe scriptName', () => runSafeCommand({ ...base, commandKind: 'run_package_script', packageDir: 'pkg', scriptName: 'test;rm' }))
result = await runSafeCommand({ ...base, commandKind: 'run_package_script', packageDir: 'pkg', scriptName: 'typecheck' })
assert.equal(result.status, 'completed')
result = await runSafeCommand({ ...base, commandKind: 'run_package_test', packageDir: 'pkg' })
assert.equal(result.status, 'completed')
await expectReject('run_package_test_marker rejects shell metacharacters', () => runSafeCommand({ ...base, commandKind: 'run_package_test_marker', packageDir: 'pkg', marker: 'ok; rm -rf .' }))
await expectReject('security_scan_paths rejects unknown pattern set', () => runSafeCommand({ ...base, commandKind: 'security_scan_paths', paths: ['src/scan.ts'], patternSet: 'custom_regex' as any }))
result = await runSafeCommand({ ...base, commandKind: 'security_scan_paths', paths: ['src/scan.ts'], patternSet: 'forbidden_secret_material' })
assert.equal(result.status, 'failed')
assert(result.stdout.includes('[REDACTED]'))
assert(!result.stdout.includes('FAKE_TOKEN_FOR_REDACTION_ONLY'))

result = await runSafeCommand({ ...base, commandKind: 'security_scan_paths', paths: ['src/network-safe.test.ts'], patternSet: 'forbidden_upload_network' })
assert.equal(result.status, 'completed')
assert.deepEqual((result.details as { findings: unknown[] }).findings, [])
result = await runSafeCommand({ ...base, commandKind: 'security_scan_paths', paths: ['src/network-safe.test.ts'], patternSet: 'forbidden_all_high_risk' })
assert.equal(result.status, 'completed')
assert.deepEqual((result.details as { findings: unknown[] }).findings, [])

result = await runSafeCommand({ ...base, commandKind: 'security_scan_paths', paths: ['src/network-unsafe.test.ts'], patternSet: 'forbidden_upload_network' })
assert.equal(result.status, 'failed')
const networkFindings = (result.details as { findings: Array<{ id: string; ruleId: string; path: string; line: number; syntaxCategory: string; confidence: string; executable: boolean }> }).findings
assert(networkFindings.some(finding => finding.ruleId === 'forbidden_upload_network.node_fetch_import' && finding.line === 1 && finding.syntaxCategory === 'ImportDeclaration'))
assert(networkFindings.some(finding => finding.ruleId === 'forbidden_upload_network.axios_import' && finding.line === 2 && finding.syntaxCategory === 'ImportDeclaration'))
assert(networkFindings.some(finding => finding.ruleId === 'forbidden_upload_network.fetch_call' && finding.line === 5))
assert(networkFindings.some(finding => finding.ruleId === 'forbidden_upload_network.fetch_member_call' && finding.line === 6))
assert(networkFindings.some(finding => finding.ruleId === 'forbidden_upload_network.fetch_member_call' && finding.line === 7))
assert(networkFindings.some(finding => finding.ruleId === 'forbidden_upload_network.fetch_member_call' && finding.line === 8))
assert(networkFindings.some(finding => finding.ruleId === 'forbidden_upload_network.axios_member_call' && finding.line === 9))
assert(networkFindings.some(finding => finding.ruleId === 'forbidden_upload_network.fetch_call' && finding.line === 10))
assert(networkFindings.every(finding => finding.path === 'src/network-unsafe.test.ts' && finding.confidence === 'high' && finding.executable === true && /^[a-f0-9]{16}$/.test(finding.id)))
const firstNetworkFindingSnapshot = networkFindings.map(finding => ({ id: finding.id, ruleId: finding.ruleId, line: finding.line }))
result = await runSafeCommand({ ...base, commandKind: 'security_scan_paths', paths: ['src/network-unsafe.test.ts'], patternSet: 'forbidden_upload_network' })
assert.deepEqual((result.details as { findings: Array<{ id: string; ruleId: string; line: number }> }).findings.map(finding => ({ id: finding.id, ruleId: finding.ruleId, line: finding.line })), firstNetworkFindingSnapshot)

result = await runSafeCommand({ ...base, commandKind: 'security_scan_paths', paths: ['docs/network-example.md'], patternSet: 'forbidden_upload_network' })
assert.equal(result.status, 'failed')
const fallbackFinding = (result.details as { findings: Array<{ syntaxCategory: string; confidence: string }> }).findings[0]
assert.equal(fallbackFinding.syntaxCategory, 'LexicalFallback')
assert.equal(fallbackFinding.confidence, 'medium')

assert(kinds.includes('run_exact_command'))

write('package.json', JSON.stringify({
  scripts: {
    valid: 'node -e "console.log(process.version)"',
    redact: 'node -e "console.log(\'DATABASE_URL=postgres://user:password@example.test/db\')"',
    mutate: 'node -e "require(\'fs\').writeFileSync(\'protected.txt\', \'changed\')"',
    generatevendor: 'node -e "require(\'fs\').mkdirSync(\'node_modules/generated\', { recursive: true }); require(\'fs\').writeFileSync(\'node_modules/generated/output.txt\', \'generated\')"',
    timeout: 'node -e "setInterval(() => {}, 1000)"',
    database: 'payload migrate',
    migration: 'prisma migrate deploy',
    deployment: 'docker push example/image:latest',
    network: 'curl https://example.test',
    envcheck: 'node -e "console.log(process.env.DATABASE_URL || \'missing\')"'
  }
}, null, 2))
write('protected.txt', 'original\n')
run('git', ['add', '--', 'package.json', 'protected.txt'])
run('git', ['commit', '-m', 'test: add exact command fixtures'])
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()
const exactBase = {
  ...base,
  commandKind: 'run_exact_command' as const,
  nodeVersion: '20' as const,
  packageDir: '.',
  requiredBranch: branch,
  protectedPaths: ['protected.txt'],
  networkAccess: false as const,
  policy: { denyDatabaseCommands: true, denyMigrationCommands: true, denyDeploymentCommands: true, denyNetworkCommands: true }
}

await expectReject('inline Node rejects source over 12000 characters', () => runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', 'x'.repeat(12_001)] }))
await expectReject('exact command rejects absolute escape', () => runSafeCommand({ ...exactBase, executable: 'node', args: [path.resolve(root, '..', 'outside.js')] }))
await expectReject('exact command rejects traversal', () => runSafeCommand({ ...exactBase, executable: 'node', args: ['../outside.js'] }))
await expectReject('exact command rejects nonexistent script', () => runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['missing-script'] }))
await expectReject('exact command blocks database script', () => runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['database'] }))
await expectReject('exact command blocks migration script', () => runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['migration'] }))
await expectReject('exact command blocks deployment script', () => runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['deployment'] }))
await expectReject('exact command blocks network script', () => runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['network'] }))

result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['--version'], requiredBranch: 'definitely-not-current' })
assert.equal(result.status, 'blocked')
assert.equal(result.reason, 'branch_mismatch')
assert.equal(result.actualBranch, branch)

const siblingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-command-sibling-'))
await expectReject('exact command cannot access sibling repository', () => runSafeCommand({ ...exactBase, executable: 'node', args: [path.join(siblingRoot, 'file.js')] }))
fs.rmSync(siblingRoot, { recursive: true, force: true })

const rgRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-rg-command-'))
const rgGit = (args: string[]) => execFileSync('git', args, { cwd: rgRepo, stdio: 'pipe', encoding: 'utf8' })
try {
  const rgExecutable = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/rg', '/usr/local/bin/rg'].find(candidate => fs.existsSync(candidate)) || 'rg'
    : 'rg'
  execFileSync(rgExecutable, ['--version'], { stdio: 'pipe' })
  rgGit(['init'])
  rgGit(['config', 'user.email', 'buildflow@example.test'])
  rgGit(['config', 'user.name', 'BuildFlow Test'])
  fs.mkdirSync(path.join(rgRepo, 'system/agent-context'), { recursive: true })
  fs.writeFileSync(path.join(rgRepo, 'system/agent-context/routes.md'), 'capture/inbox\ncapture/failed\nrouter/queue\n')
  fs.writeFileSync(path.join(rgRepo, 'protected.txt'), 'unchanged\n')
  fs.writeFileSync(path.join(rgRepo, '.env'), 'capture/inbox=secret\n')
  rgGit(['add', '--', 'system/agent-context/routes.md', 'protected.txt', '.env'])
  rgGit(['commit', '-m', 'test: seed direct ripgrep repository'])
  const rgBranch = rgGit(['branch', '--show-current']).trim()
  const rgBase = {
    sourceId: 'rg-test',
    sourceRoot: rgRepo,
    commandKind: 'run_exact_command' as const,
    executable: 'rg' as const,
    packageDir: '.',
    requiredBranch: rgBranch,
    protectedPaths: ['protected.txt'],
    networkAccess: false as const,
    timeoutMs: 8_000
  }
  const alternation = 'capture/inbox|capture/failed|router/'
  if (process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/rg')) {
    const originalPath = process.env.PATH
    try {
      process.env.PATH = '/usr/bin:/bin'
      result = await runSafeCommand({ ...rgBase, args: ['-n', alternation, 'system/agent-context'] })
      assert.equal(result.status, 'completed')
      assert.equal(result.matchStatus, 'matches_found')
      assert(result.runtime?.rgVersion?.startsWith('ripgrep '))
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  }

  result = await runSafeCommand({ ...rgBase, args: ['-n', alternation, 'system/agent-context'] })
  assert.equal(result.status, 'completed')
  assert.equal(result.matchStatus, 'matches_found')
  assert.equal(result.exitCode, 0)
  assert.equal(result.executable, 'rg')
  assert.equal(result.shell, false)
  assert.equal(result.resolvedRepositoryRoot, fs.realpathSync(rgRepo))
  assert.equal(result.filesChanged, false)
  assert.deepEqual(result.changedPaths, [])
  assert.deepEqual(result.protectedPathsChanged, [])
  assert.equal(result.args?.filter(arg => arg === alternation).length, 1)
  assert(result.stdout.includes('capture/inbox'))
  assert(result.stdout.includes('capture/failed'))
  assert(result.stdout.includes('router/queue'))
  assert(result.runtime?.rgVersion?.startsWith('ripgrep '))
  assert.deepEqual((result.details as { exactInvocation: { executable: string; args: string[]; shell: boolean } }).exactInvocation, {
    executable: 'rg',
    args: result.args,
    shell: false
  })
  assert.equal(fs.readFileSync(path.join(rgRepo, 'protected.txt'), 'utf8'), 'unchanged\n')

  result = await runSafeCommand({ ...rgBase, args: ['-m', '5', '--max-columns', '200', '-n', alternation, 'system/agent-context'] })
  assert.equal(result.status, 'completed')
  assert.equal(result.matchStatus, 'matches_found')
  assert.equal(result.args?.includes('--max-count'), false)
  assert.equal(result.args?.includes('-m'), true)
  assert.equal(result.args?.includes('--max-columns'), true)

  result = await runSafeCommand({ ...rgBase, args: ['-n', 'a-pattern-that-does-not-exist', 'system/agent-context'] })
  assert.equal(result.status, 'completed')
  assert.equal(result.matchStatus, 'no_matches')
  assert.equal(result.exitCode, 1)
  assert.equal(result.filesChanged, false)

  result = await runSafeCommand({ ...rgBase, args: ['-n', '-e', 'capture/inbox', '-e', 'capture/failed', '-e', 'router/', 'system/agent-context'] })
  assert.equal(result.status, 'completed')
  assert.equal(result.matchStatus, 'matches_found')

  result = await runSafeCommand({ ...rgBase, args: ['--hidden', '-n', 'capture/inbox', '.'] })
  assert.equal(result.status, 'completed')
  assert(!result.stdout.includes('.env'))

  await expectReject('direct rg rejects standalone pipeline token', () => runSafeCommand({ ...rgBase, args: ['pattern', '.', '|', 'another-command'] }))
  await expectReject('direct rg rejects standalone command chaining token', () => runSafeCommand({ ...rgBase, args: ['pattern', '.', '&&', 'another-command'] }))
  await expectReject('direct rg rejects standalone redirect token', () => runSafeCommand({ ...rgBase, args: ['pattern', '.', '>', 'output.txt'] }))
  await expectReject('direct rg rejects command substitution', () => runSafeCommand({ ...rgBase, args: ['$(command)', '.'] }))
  await expectReject('direct rg rejects backtick substitution', () => runSafeCommand({ ...rgBase, args: ['`command`', '.'] }))
  await expectReject('direct rg rejects preprocessor option', () => runSafeCommand({ ...rgBase, args: ['--pre', 'some-command', 'pattern', '.'] }))
  await expectReject('direct rg rejects preprocessor glob option', () => runSafeCommand({ ...rgBase, args: ['--pre-glob', '*.md', 'pattern', '.'] }))
  await expectReject('direct rg rejects repository traversal', () => runSafeCommand({ ...rgBase, args: ['pattern', '../../'] }))
  await expectReject('direct rg rejects absolute paths', () => runSafeCommand({ ...rgBase, args: ['pattern', rgRepo] }))
  await expectReject('direct rg rejects git metadata paths', () => runSafeCommand({ ...rgBase, args: ['pattern', '.git'] }))
  await expectReject('direct rg rejects vendor paths', () => runSafeCommand({ ...rgBase, args: ['pattern', 'node_modules'] }))
  await expectReject('shell executables remain unavailable', () => runSafeCommand({ ...rgBase, executable: 'bash' as any, args: ['-lc', 'rg pattern . | another-command'] }))
} finally {
  fs.rmSync(rgRepo, { recursive: true, force: true })
}

let node20Available = process.version.startsWith('v20.')
const nvmDirs = Array.from(new Set([
  process.env.NVM_DIR,
  process.env.HOME ? path.join(process.env.HOME, '.nvm') : undefined
].filter((value): value is string => typeof value === 'string' && value.length > 0)))
for (const nvmDir of nvmDirs) {
  if (node20Available) break
  const versions = path.join(nvmDir, 'versions', 'node')
  node20Available = fs.existsSync(versions) && fs.readdirSync(versions).some(name => /^v20\./.test(name))
}
if (node20Available) {
  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['--version'] })
  assert.equal(result.status, 'completed')
  assert.equal(result.runtime?.nodeMajorVersion, 20)
  assert.match(result.runtime?.nodeVersion || '', /^v20\./)

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['--version'] })
  assert.equal(result.status, 'completed')
  assert(result.runtime?.pnpmVersion)

  if (process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/pnpm')) {
    const originalPath = process.env.PATH
    try {
      process.env.PATH = '/usr/bin:/bin'
      result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['--version'] })
      assert.equal(result.status, 'completed')
      assert(result.runtime?.pnpmVersion)
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  }

  write('scan/one.txt', 'deprecated-package\n')
  write('scan/nested/two.md', 'safe\ndeprecated-package\n')
  write('node_modules/example-cli/index.js', "#!/usr/bin/env node\nif (process.argv.includes('--help')) console.log('example-cli help')\n")
  fs.chmodSync(path.join(root, 'node_modules/example-cli/index.js'), 0o755)
  fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true })
  fs.symlinkSync('../example-cli/index.js', path.join(root, 'node_modules/.bin/example-cli'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "const pkg=JSON.parse(require('node:fs').readFileSync('package.json','utf8')); console.log(pkg.scripts.valid)"] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('process.version'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "console.log('small-output')"] })
  assert.equal(result.status, 'completed')
  assert.equal(result.outputTruncated, false)
  assert(result.stdout.includes('small-output'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "process.stdout.write('x'.repeat(70_000))"] })
  assert.equal(result.status, 'failed')
  assert.equal(result.outputTruncated, true)
  assert.equal(result.reason, 'output_limit_exceeded')

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "process.stderr.write('x'.repeat(70_000))"] })
  assert.equal(result.status, 'failed')
  assert.equal(result.outputTruncated, true)
  assert.equal(result.reason, 'output_limit_exceeded')

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "process.stdout.write('x'.repeat(35_000)); process.stderr.write('y'.repeat(35_000))"] })
  assert.equal(result.status, 'failed')
  assert.equal(result.outputTruncated, true)
  assert.equal(result.reason, 'output_limit_exceeded')

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:os')"] })
  assert.equal(result.status, 'failed')
  assert.match(result.stderr, /module node:os is not allowlisted/)

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "console.log(JSON.stringify({platform:process.platform,arch:process.arch}))"] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes(process.platform))
  assert(result.stdout.includes(process.arch))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:child_process')"] })
  assert.equal(result.status, 'failed')
  assert.match(result.stderr, /module node:child_process is not allowlisted/)

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:fs').readdirSync('.', { recursive: true })"] })
  assert.equal(result.status, 'failed')
  assert.match(result.stderr, /recursive readdir is not allowed/)

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:fs\/promises').readdir('.', { recursive: true })"] })
  assert.equal(result.status, 'failed')
  assert.match(result.stderr, /recursive readdir is not allowed/)

  const recursiveSearchSource = "const fs=require('node:fs'); const path=require('node:path'); const hits=[]; const walk=dir=>{ for(const entry of fs.readdirSync(dir,{withFileTypes:true})){ const file=path.join(dir,entry.name); if(entry.isDirectory()) walk(file); else if(fs.readFileSync(file,'utf8').includes('deprecated-package')) hits.push(file); } }; walk('scan'); console.log(JSON.stringify(hits));"
  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', recursiveSearchSource] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('scan/one.txt'))
  assert(result.stdout.includes('scan/nested/two.md'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "const name='Workbench'; console.log(`hello ${name}`)"] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('hello Workbench'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "const value='deprecated-package'; console.log(/deprecated-[a-z]+/.test(value))"] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('true'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "const fs=require('node:fs'); const target=fs.realpathSync('node_modules/.bin/example-cli'); const mode=fs.statSync('node_modules/.bin/example-cli').mode; console.log(JSON.stringify({target,mode}))"] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('example-cli/index.js'))
  assert.match(result.stdout, /\"mode\":\d+/)

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:fs').readFileSync('../outside.txt','utf8')"] })
  assert.equal(result.status, 'failed')
  assert(result.stderr.includes('path traversal'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:https')"] })
  assert.equal(result.status, 'failed')
  assert(result.stderr.includes('not allowlisted'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:child_process').spawnSync('sh',['-c','echo bad'],{encoding:'utf8',shell:false})"] })
  assert.equal(result.status, 'failed')
  assert(result.stderr.includes('blocked'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:child_process').spawnSync('npm',['install'],{encoding:'utf8',shell:false})"] })
  assert.equal(result.status, 'failed')
  assert(result.stderr.includes('blocked'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:fs').writeFileSync('protected.txt','changed')"] })
  assert.equal(result.status, 'failed')
  assert(result.stderr.includes('not allowed'))
  assert.equal(fs.readFileSync(path.join(root, 'protected.txt'), 'utf8'), 'original\n')

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['valid'] })
  assert.equal(result.status, 'completed')
  assert.equal((result.details as { resolvedScriptName?: string } | undefined)?.resolvedScriptName, 'valid')

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['generatevendor'] })
  assert.equal(result.status, 'completed')
  assert.equal(result.protectedPathsChanged?.length, 0)
  assert(fs.existsSync(path.join(root, 'node_modules/generated/output.txt')))

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['redact'] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('[REDACTED]'))
  assert(!result.stdout.includes('password@example.test'))

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['envcheck'] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('missing'))

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['mutate'] })
  assert.equal(result.status, 'blocked')
  assert.deepEqual(result.protectedPathsChanged, ['protected.txt'])

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['timeout'], timeoutMs: 1000 })
  assert.equal(result.status, 'timed_out')
  assert(result.durationMs < 4000)
} else {
  await expectReject('exact command reports unavailable Node 20', () => runSafeCommand({ ...exactBase, executable: 'node', args: ['--version'] }))
}

write('diff/one.txt', 'one base\n')
write('diff/two.txt', 'two base\n')
run('git', ['add', '--', 'diff/one.txt', 'diff/two.txt'])
run('git', ['commit', '-m', 'test: add diff fixtures'])
write('diff/one.txt', 'one changed\n')
write('diff/two.txt', 'two changed\n')
write('diff/new.txt', 'new untracked\n')
write('unrelated-untracked.txt', 'unrelated\n')

result = await runSafeCommand({ ...base, commandKind: 'git_diff', paths: ['diff/one.txt'] })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('diff/one.txt'))
assert(!result.stdout.includes('diff/two.txt'))
assert(!result.stdout.includes('unrelated-untracked.txt'))

result = await runSafeCommand({ ...base, commandKind: 'git_diff_name_only', paths: ['diff/one.txt', 'diff/two.txt', 'diff/new.txt'] })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('diff/one.txt'))
assert(result.stdout.includes('diff/two.txt'))
assert(result.stdout.includes('Untracked path evidence:'))
assert(result.stdout.includes('?? diff/new.txt'))
assert(!result.stdout.includes('unrelated-untracked.txt'))

result = await runSafeCommand({ ...base, commandKind: 'git_diff_stat', paths: ['diff/one.txt', 'diff/two.txt'] })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('diff/one.txt'))
assert(result.stdout.includes('diff/two.txt'))

await expectReject('git_diff rejects option-like pathspec', () => runSafeCommand({ ...base, commandKind: 'git_diff', paths: ['-bad'] }))
await expectReject('git_diff rejects traversal pathspec', () => runSafeCommand({ ...base, commandKind: 'git_diff', paths: ['../outside.txt'] }))

result = await runSafeCommand({ ...base, commandKind: 'git_diff' })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('diff/one.txt'))
assert(result.stdout.includes('diff/two.txt'))
assert(!result.stdout.includes('Untracked path evidence:'))

const n8nRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-n8n-export-'))
const n8nGit = (args: string[]) => execFileSync('git', args, { cwd: n8nRepo, stdio: 'pipe', encoding: 'utf8' })
const n8nWrapperPath = path.join(n8nRepo, 'tools/n8n-api.sh')
const n8nWriteWrapper = (stdout: string, exitCode = 0) => {
  fs.mkdirSync(path.dirname(n8nWrapperPath), { recursive: true })
  fs.writeFileSync(n8nWrapperPath, `#!/usr/bin/env bash\nprintf '%s' '${stdout.replace(/'/g, `'\\''`)}'\nexit ${exitCode}\n`)
  fs.chmodSync(n8nWrapperPath, 0o755)
}
try {
  n8nGit(['init'])
  n8nGit(['config', 'user.email', 'buildflow@example.test'])
  n8nGit(['config', 'user.name', 'BuildFlow Test'])
  n8nWriteWrapper(JSON.stringify({ id: 'FwP5INe9qoo1OwGC', versionId: 'v1', updatedAt: '2026-07-10T00:00:00.000Z', nodes: [] }))
  n8nGit(['add', '--', 'tools/n8n-api.sh'])
  n8nGit(['commit', '-m', 'test: seed n8n export wrapper'])
  const n8nBase = {
    sourceId: 'brain',
    sourceRoot: n8nRepo,
    commandKind: 'n8n_workflow_export' as const,
    workflowId: 'FwP5INe9qoo1OwGC',
    outputPath: 'operations/reports/artifacts/b1-0a-live-workflow-rollback.json',
    networkAccess: true,
    protectedPaths: ['tools/n8n-api.sh'],
    timeoutMs: 8_000
  }

  result = await runSafeCommand(n8nBase)
  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.requiresConfirmation, true)
  assert.equal(typeof result.confirmationToken, 'string')

  result = await runSafeCommand({ ...n8nBase, confirmedByUser: true })
  assert.equal(result.status, 'completed')
  assert.equal(result.reason, 'confirmation_required_for_brain_n8n_workflow_export')
  assert.equal(result.executable, 'tools/n8n-api.sh')
  assert.deepEqual(result.args, ['get-workflow', 'FwP5INe9qoo1OwGC'])
  assert.equal(result.shell, false)
  assert.equal(result.artifactPath, 'operations/reports/artifacts/b1-0a-live-workflow-rollback.json')
  assert.match(result.artifactSha256 || '', /^[a-f0-9]{64}$/)
  assert.equal(result.workflowId, 'FwP5INe9qoo1OwGC')
  assert.equal(result.workflowVersion, 'v1')
  assert.equal(result.workflowUpdatedAt, '2026-07-10T00:00:00.000Z')
  assert.equal(result.networkWriteRequested, false)
  assert(result.changedPaths.includes('operations/reports/artifacts/b1-0a-live-workflow-rollback.json'))
  assert.deepEqual(result.protectedPathsChanged, [])
  const artifact = JSON.parse(fs.readFileSync(path.join(n8nRepo, result.artifactPath!), 'utf8'))
  assert.equal(artifact.id, 'FwP5INe9qoo1OwGC')

  await expectReject('n8n export rejects wrong source', () => runSafeCommand({ ...n8nBase, sourceId: 'other', confirmedByUser: true }))
  await expectReject('n8n export rejects wrong workflow', () => runSafeCommand({ ...n8nBase, workflowId: 'other', confirmedByUser: true }))
  await expectReject('n8n export rejects wrong artifact path', () => runSafeCommand({ ...n8nBase, outputPath: 'operations/reports/artifacts/other.json', confirmedByUser: true }))
  await expectReject('n8n export rejects extra argv', () => runSafeCommand({ ...n8nBase, args: ['|', 'curl'], confirmedByUser: true }))
  await expectReject('n8n export rejects alternate argv property', () => runSafeCommand({ ...n8nBase, argv: ['get-workflow', 'other'], confirmedByUser: true } as any))
  await expectReject('n8n export rejects executable override', () => runSafeCommand({ ...n8nBase, executable: 'rg', confirmedByUser: true }))
  await expectReject('n8n export rejects shell override', () => runSafeCommand({ ...n8nBase, shell: true, confirmedByUser: true } as any))
  await expectReject('n8n export rejects env override', () => runSafeCommand({ ...n8nBase, env: { N8N_API_URL: 'https://example.test' }, confirmedByUser: true } as any))
  await expectReject('n8n export rejects environment override', () => runSafeCommand({ ...n8nBase, environment: { N8N_API_URL: 'https://example.test' }, confirmedByUser: true } as any))
  await expectReject('n8n export rejects network disabled', () => runSafeCommand({ ...n8nBase, networkAccess: false, confirmedByUser: true }))

  n8nWriteWrapper('{malformed')
  await expectReject('n8n export rejects malformed JSON', () => runSafeCommand({ ...n8nBase, confirmedByUser: true }))
  n8nWriteWrapper(JSON.stringify({ id: 'wrong-workflow', nodes: [] }))
  await expectReject('n8n export rejects mismatched workflow JSON', () => runSafeCommand({ ...n8nBase, confirmedByUser: true }))
  n8nWriteWrapper(JSON.stringify({ id: 'FwP5INe9qoo1OwGC', [['api', 'Key'].join('')]: 'credential-like-value' }))
  await expectReject('n8n export rejects credential-like output', () => runSafeCommand({ ...n8nBase, confirmedByUser: true }))
  n8nWriteWrapper(JSON.stringify({ id: 'FwP5INe9qoo1OwGC', data: 'x'.repeat(500_100) }))
  await expectReject('n8n export rejects oversized output', () => runSafeCommand({ ...n8nBase, confirmedByUser: true }))
} finally {
  fs.rmSync(n8nRepo, { recursive: true, force: true })
}

const openapiRoute = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/app/api/openapi/route.ts'), 'utf8')
const canonicalOpenApiSchema = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/lib/openapi-chatgpt.json'), 'utf8')
assert(openapiRoute.includes("canonicalOpenApiSchema"), 'OpenAPI route must serve the canonical schema')
for (const token of ['git_add_paths', 'git_commit', 'validate_json_files', 'run_package_script', 'run_package_test', 'run_package_test_marker', 'security_scan_paths', 'run_exact_command', 'run_repo_shell', 'n8n_workflow_export', 'workflowId', 'outputPath', 'executable', 'args', 'command', 'nodeVersion', 'policy', 'protectedPaths', 'requiredBranch', 'networkAccess', 'packageDir', 'scriptName', 'patternSet', 'confirmationToken']) {
  assert(canonicalOpenApiSchema.includes(token), `Canonical OpenAPI schema missing ${token}`)
}
assert(canonicalOpenApiSchema.includes('"enum":["node","pnpm","rg"]'), 'OpenAPI exact-command executable enum must include direct rg')
const gptActions = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/lib/actions/gpt.ts'), 'utf8')
assert(gptActions.includes('sessionAwareRunWorkbenchCommandRequestSchema'), 'GPT command dispatcher must import the shared session-aware strict parser')
assert(gptActions.includes('sessionAwareRunWorkbenchCommandRequestSchema.safeParse(body)'), 'GPT command dispatcher must use the shared session-aware strict parser')
assert(gptActions.includes("executeAction('/api/commands/run', requestBody"), 'GPT command dispatcher must forward the parsed request body')

const commandRunnerSource = fs.readFileSync(path.join(process.cwd(), 'packages/cli/src/agent/command-runner.ts'), 'utf8')
const n8nExportAdapterSource = fs.readFileSync(path.join(process.cwd(), 'packages/cli/src/agent/n8n-workflow-export.ts'), 'utf8')
assert(commandRunnerSource.includes("import { runN8nWorkflowExportCapability } from './n8n-workflow-export'"), 'command runner must import the dedicated n8n export adapter')
assert(commandRunnerSource.includes('return runN8nWorkflowExportCapability(request, n8nWorkflowExportDependencies)'), 'command runner must dispatch n8n export through the dedicated adapter')
assert(!commandRunnerSource.includes('const N8N_EXPORT_WORKFLOW_ID'), 'command runner must not retain the legacy n8n export constants')
assert(!commandRunnerSource.includes('async function runN8nWorkflowExport('), 'command runner must not retain a duplicate n8n export implementation')
assert(n8nExportAdapterSource.includes("spawn(wrapperPath, ['get-workflow', N8N_EXPORT_WORKFLOW_ID]"), 'n8n export adapter must use fixed get-workflow argv')
assert(n8nExportAdapterSource.includes('shell: false'), 'n8n export adapter must disable shell execution')
assert(n8nExportAdapterSource.includes('const N8N_EXPORT_MAX_BYTES = 500_000'), 'n8n export adapter must retain its bounded output limit')
assert(n8nExportAdapterSource.includes('Math.min(30_000, Math.max(1_000'), 'n8n export adapter must retain its bounded timeout')
assert(n8nExportAdapterSource.includes('fs.renameSync(tempPath, artifactPath)'), 'n8n export adapter must retain atomic artifact replacement')
for (const [label, pattern] of [
  ['Next.js', /(?:from\s+|import\s*)['"]next(?:\/[^'"]*)?['"]/],
  ['React', /(?:from\s+|import\s*)['"]react(?:\/[^'"]*)?['"]/],
  ['Fastify', /(?:from\s+|import\s*)['"]fastify(?:\/[^'"]*)?['"]/],
  ['apps/web', /(?:from\s+|import\s*)['"][^'"]*apps\/web[^'"]*['"]/],
  ['relay code', /(?:from\s+|import\s*)['"][^'"]*relay[^'"]*['"]/]
] as const) {
  assert(!pattern.test(n8nExportAdapterSource), `n8n export adapter must not depend on ${label}`)
}

const runCommandRoute = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/app/api/actions/run-command/route.ts'), 'utf8')
assert(runCommandRoute.includes("import { sessionAwareRunWorkbenchCommandRequestSchema } from '@workbench/shared'"), 'run-command route must import the shared session-aware strict parser')
assert(runCommandRoute.includes('sessionAwareRunWorkbenchCommandRequestSchema.safeParse(rawBody)'), 'run-command route must use the shared session-aware strict parser')
assert(
  runCommandRoute.includes("if (clean.status === 'timed_out' && validationJobOperation === undefined)"),
  'run-command route must normalize only synchronous timed_out results'
)
assert(runCommandRoute.includes("status: 'timeout'"), 'run-command route missing timeout status')
for (const token of ['sourceId', 'executable', 'args', 'packageDir', 'requiredBranch', 'actualBranch', 'runtime', 'changedPaths', 'protectedPathsChanged', 'riskLevel', 'requiresConfirmation', 'signal', 'durationMs', 'outputTruncated', 'stdout', 'stderr', 'exitCode', 'artifactPath', 'artifactSha256', 'workflowId', 'workflowVersion', 'workflowUpdatedAt', 'networkWriteRequested']) {
  assert(runCommandRoute.includes(`${token}:`), `run-command response projection missing ${token}`)
}
for (const token of ['artifactPath: clean.artifactPath', 'artifactSha256: clean.artifactSha256', 'workflowId: clean.workflowId', 'workflowVersion: clean.workflowVersion', 'workflowUpdatedAt: clean.workflowUpdatedAt', 'networkWriteRequested: clean.networkWriteRequested']) {
  assert(runCommandRoute.includes(token), `run-command timeout projection missing ${token}`)
}
for (const token of ['artifactPath: clean.artifactPath ?? job?.artifactPath', 'artifactSha256: clean.artifactSha256 ?? job?.artifactSha256', 'workflowId: clean.workflowId ?? job?.workflowId', 'workflowVersion: clean.workflowVersion ?? job?.workflowVersion', 'workflowUpdatedAt: clean.workflowUpdatedAt ?? job?.workflowUpdatedAt', 'networkWriteRequested: clean.networkWriteRequested ?? job?.networkWriteRequested']) {
  assert(runCommandRoute.includes(token), `run-command success projection missing ${token}`)
}

fs.rmSync(root, { recursive: true, force: true })
console.log('command runner checks passed')
}

main().catch(error => {
  fs.rmSync(root, { recursive: true, force: true })
  console.error(error)
  process.exit(1)
})
