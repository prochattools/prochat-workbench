#!/usr/bin/env node

import { Command } from 'commander'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { initCommand } from './commands/init'
import { loginCommand } from './commands/login'
import { connectCommand } from './commands/connect'
import { indexCommand } from './commands/index'
import { serveCommand } from './commands/serve'
import { statusCommand } from './commands/status'
import { workspaceListCommand } from './commands/workspace'
import { treeCommand } from './commands/tree'
import { grepCommand } from './commands/grep'
import { contextCommand } from './commands/context'
import { diagnosticRedactionCommand } from './commands/diagnose-redaction'
import { doctorCommand } from './commands/doctor'

function getVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(resolve(__dirname, '../package.json'), 'utf-8')
    )
    return packageJson.version || '0.1.0'
  } catch {
    return '0.1.0'
  }
}

export function main(invocationName: string) {
  const program = new Command()

  // Emit deprecation warning to stderr for buildflow alias (unless JSON/machine-readable output)
  const isDeprecatedAlias = invocationName === 'buildflow'
  if (isDeprecatedAlias && !process.env.WORKBENCH_JSON && !process.argv.includes('--json')) {
    const deprecationWarning = `⚠ WARNING: 'buildflow' command is deprecated. Use 'workbench' instead.\n`
    process.stderr.write(deprecationWarning)
  }

  program.name('workbench').description('Workbench: execute ideas into action').version(getVersion())

  program
    .command('init')
    .description('Initialize Workbench')
    .action(() => initCommand())

  program
    .command('login <apiKey>')
    .description('Login with API key')
    .action((apiKey) => loginCommand(apiKey))

  program
    .command('connect <folder>')
    .description('Connect a local vault folder')
    .action((folder) => connectCommand(folder))

  program
    .command('index')
    .description('Rebuild the search index')
    .action(() => indexCommand())

  program
    .command('serve')
    .description('Start the local agent server')
    .action(() => serveCommand())

  program
    .command('status')
    .description('Show Workbench status')
    .action(() => statusCommand())

  program
    .command('doctor')
    .description('Show internal Context Intelligence diagnostics')
    .option('--json', 'Emit bounded machine-readable JSON')
    .option('--approve-reconciliation <proposalId>', 'Apply one exact owner-local reconciliation proposal')
    .option('--action <disable|remove>', 'Exact reconciliation action to approve')
    .option('--canonical-path <path>', 'Exact canonical path to bind the approval')
    .option('--reason-code <code>', 'Exact reconciliation reason code to bind the approval')
    .action(async (options) => {
      process.exitCode = await doctorCommand(Boolean(options.json), { approveReconciliation: options.approveReconciliation, action: options.action, canonicalPath: options.canonicalPath, reasonCode: options.reasonCode })
    })

  program
    .command('workspace <action>')
    .description('Manage workspaces')
    .action((action) => {
      if (action === 'list') {
        workspaceListCommand()
      } else {
        console.error(`Unknown action: ${action}`)
      }
    })

  program
    .command('tree <workspace> [path]')
    .option('--depth <n>', 'Max depth', '3')
    .description('List workspace tree')
    .action((workspace, path, options) => {
      treeCommand(workspace, path || '', parseInt(options.depth, 10))
    })

  program
    .command('grep <workspace> <pattern>')
    .option('--max <n>', 'Max results', '50')
    .description('Search workspace')
    .action((workspace, pattern, options) => {
      grepCommand(workspace, pattern, parseInt(options.max, 10))
    })

  program
    .command('context <workspace> [query]')
    .option('--depth <n>', 'Max depth', '2')
    .description('Assemble workspace context')
    .action((workspace, query, options) => {
      contextCommand(workspace, query || '', parseInt(options.depth, 10))
    })

  program.addCommand(diagnosticRedactionCommand())

  program.parse()
}
