# ProChat Workbench

A review-first local workbench for safely applying AI-assisted workflows to
repositories and project documentation.

## Maintainer

Created and maintained by
[Steve Westhoek](https://github.com/stevewesthoek)
under the [ProChat organization](https://github.com/prochattools).

**ProChat Workbench lets ChatGPT work safely with your real local projects.**

Connect a Custom GPT to your own computer and use ChatGPT as the reasoning interface for local repositories, documentation, plans, notes, and knowledge folders. Workbench provides exact source context, guarded file operations, bounded local execution, validation, checkpoints, and explicit-path Git workflows.

ProChat Workbench is free, self-hosted, and local-first. It is designed for developers, QA engineers, technical consultants, and documentation-heavy teams who want AI assistance without moving project knowledge into a hosted coding-agent platform.

```text
Public product name: ProChat Workbench
Technical compatibility name: BuildFlow
```

Use **ProChat Workbench** in public documentation, GitHub descriptions, CV links, interviews, and beta onboarding. The BuildFlow name remains only where older package names, scripts, config paths, source IDs, or API compatibility surfaces still require it.

If this project helps you, please **star it, fork it, try it on a real repo, open issues, request features, and share what you build with it.**

```mermaid
flowchart LR
  You["You in ChatGPT"] --> GPT["Custom GPT"]
  GPT --> Endpoint["Public Workbench endpoint"]
  Endpoint --> Tunnel["HTTPS / optional tunnel"]
  Tunnel --> Ingress["Native ingress<br/>127.0.0.1:3154"]
  Ingress --> Core["Portable Workbench core"]
  Core --> Sources["Connected repositories"]
  Core --> Writes["Verified writes"]
  Core --> Commands["Allowlisted commands"]
  GPT --> Assistant["Quick mode or Goal mode"]
  Assistant --> Flow["Plan · execute packets · validate · checkpoint · continue"]

  classDef dark fill:#0f172a,stroke:#2563eb,color:#f8fafc;
  classDef local fill:#ecfeff,stroke:#0891b2,color:#0f172a;
  classDef safe fill:#f0fdf4,stroke:#16a34a,color:#0f172a;

  class You,GPT,Endpoint,Tunnel,Ingress,Core,Assistant,Flow dark;
  class Sources local;
  class Writes,Commands safe;
```

## Why ProChat Workbench exists

AI coding tools are powerful, but they often work in the wrong place.

A remote model may not see your local repo. A browser chat may not be able to run your local tests. A CLI agent may have strong execution but weak long-term planning context. Copying files back and forth wastes time and breaks flow.

ProChat Workbench bridges that gap with a native macOS supervisor, a portable
local core, and a bounded HTTPS/API adapter.

It keeps ChatGPT as the main interface while your own machine remains the source of truth. Your Custom GPT can ask Workbench for exact repo context, read the files it needs, write verified changes back to disk, run allowlisted validation commands, and keep a progress trail.

The result is a ChatGPT-first workflow for real local projects.

## What you can build with it

ProChat Workbench is useful for much more than asking questions about a codebase.

You can use it to:

- build a new app feature from a single high-level goal
- refactor an existing app across multiple files
- fix failing endpoints or broken tests
- create and update project documentation
- generate implementation plans, specs, runbooks, and task lists
- improve your personal knowledge repo, brain repo, or notes system
- maintain prompt libraries, skill folders, and project docs
- search across multiple projects from ChatGPT
- review repo structure before starting work
- safely apply code edits with verified file operations
- validate JSON files, type checks, tests, and package scripts
- run named security scans over changed files
- prepare clean git diffs, staged file lists, commits, and push flows with guardrails
- create handoff prompts for Codex, Claude Code, your IDE, or another local tool
- continue planning or reviewing from your phone while your local machine hosts the repo connector

## The value in one sentence

**ProChat Workbench lets you use ChatGPT as the reasoning layer and your local computer as the execution layer.**

That means you can brainstorm, inspect, plan, edit, validate, and iterate on real local projects without turning every task into a separate hosted API workflow.

## Key features

### ChatGPT-first local repo access

ProChat Workbench exposes a Custom GPT action schema so ChatGPT can talk to your local Workbench endpoint.

Your GPT can:

- check Workbench status
- list connected sources
- lock an explicit `sourceId` for the chat
- inspect file trees
- search indexed local files
- prepare focused task context with a deterministic exact read plan
- read exact files
- create planning artifacts
- apply safe file changes
- run allowlisted validation commands
- complete small, explicit repo-assistant tasks without autonomous loops

### Local source management

Add repos, notes, docs, skills, or business folders as Workbench sources.

Workbench supports:

- one or multiple active sources
- Git branch metadata for configured repositories (`branchName`, available branch count, and worktree flag)
- branch-aware activation for configured linked Git worktrees that share the same Git common directory
- local indexing and search
- recursive repo discovery from a root folder
- auto-generated source IDs and labels
- account-style grouping by folder
- manual reindexing
- optional per-source auto-index settings
- searchable status reporting for ChatGPT and the dashboard
- bounded source/provider health diagnostics through `workbench doctor`
- owner-approved reconciliation proposals for stale or missing registrations;
  ambiguous, active, dirty, and managed cases remain blocked
- exact reviewed-set recovery for already-reviewed safe registrations, with
  independent revalidation and explicit partial results

Every repo action carries an explicit source lock. Start with `getWorkbenchStatus?include=sources`, then reuse one exact enabled `sourceId` for the conversation. The placeholders `default`, `workspace`, `current`, and `repo` are rejected; Workbench never maps them to an implicit or environment-specific source.

Branch-aware activation works on configured checkouts and worktrees. When a repo has multiple configured branch worktrees, enabling/disabling or activating one configured branch expands to the configured siblings in the same repo group. Workbench does not silently check out every Git branch inside one working tree; create linked Git worktrees and add/discover them as sources when you want simultaneous branch access.

### Verified file writes

Workbench can write files, but it does not blindly mutate your machine.

It supports:

- create
- append
- overwrite
- patch
- move
- rename
- mkdir
- rmdir
- delete file
- delete directory where policy allows
- dry-run / preflight checks
- confirmation-required operations
- verified write results with `verified:true`

The connected-repository policy is intentionally practical for engineering
work. It permits normal files anywhere inside an explicitly connected source;
the centralized deny policy blocks secrets, credentials, Git internals,
protected security material, generated/runtime output, and paths outside the
source. Folder allowlists are not the authorization model.

A write is not considered successful unless Workbench verifies it on disk.

### Safe command runner

Workbench can run repo-local commands through a strict allowlist.

Supported command families include:

- git status, diff, branch, and log checks
- cached git diff checks
- explicit `git add -- <paths>` only
- commit flows after validation, plus push flows only when explicitly requested, with safe path, message, remote, branch, and force-push checks
- JSON validation with `python3 -m json.tool`
- package type checks and tests
- safe package scripts by name, including scripts from the repo root
- marker-based test runs where supported
- named security scans
- Workbench verification scripts

Direct `rg` execution is read-only and structured. Regex alternation such as `capture/inbox|capture/failed|router/` remains one argv element, execution always uses `shell:false`, and shell operators, subprocess/preprocessor options, traversal, prohibited paths, writes, and network access remain blocked. A no-match exit is reported as completed evidence rather than a failed command.

Command responses project verified evidence from the runner, including the executable, exact `args`, `shell`, match status, resolved repository root, changed paths, protected-path changes, bounded output, and exit status. These fields are evidence, not synthesized success claims.

Confirmation-gated operations return `needs_confirmation` and a backend-issued token. Do not retry with guessed tokens or bypass the gate. The fixed `n8n_workflow_export` capability is limited to the Brain source, one approved workflow, one credential-abstracting wrapper invocation, and one rollback artifact; it does not update, activate, delete, invoke, or deploy workflows.

Workbench does **not** expose arbitrary shell execution. More command capability should be added as named, source-relative command kinds instead of unrestricted terminal access.

Named security scans use syntax-aware handling for JavaScript and TypeScript: inert comments, strings, fixtures, and source-inspection assertions are ignored, while executable `fetch` calls, prohibited clients/imports, and high-confidence network behavior remain findings. Results are projected into bounded, redacted evidence.

### Quick and Goal modes

Workbench supports Quick mode for focused work and Goal mode for substantial
work built from persistent state and bounded packets.

ChatGPT remains the reasoning layer. Workbench provides exact local context,
guarded file writes, targeted validation, persistent run state, bounded packet
execution, compact evidence, and explicit Git operations. Workbench does not
become an unrestricted autonomous agent runtime.

Use this default flow:

```text
Question -> minimal exact read -> answer
Small edit -> exact read -> patch -> smallest validation -> optional commit -> stop
Large goal -> persist plan -> bounded packet -> validate -> checkpoint -> continue when permitted
```

Recommended task budget:

```text
Default: one bounded task or packet
Clear small batch: tightly related tasks with explicit acceptance
Action requests remain bounded by the public route deadlines and payload budgets
Push: only when explicitly requested
```

This keeps ChatGPT powerful while avoiding the main latency failure mode: long chains of model reasoning plus action calls.

Open-ended reasoning remains with ChatGPT. Workbench may persist goals, runs,
packets, checkpoints, validation evidence, and bounded continuation state so
deterministic local work can resume safely without turning the public action
surface into a long-running request.

### Persistent resume and handoff

For larger work, use a repo-local progress document or handoff file. A new Custom GPT conversation can read it, verify source scope and git status, and continue from the next unchecked task.

The Custom GPT should update the handoff after each meaningful chunk with completed work, next task, validation evidence, blockers, rollback notes, and resume instructions.

That means a later conversation can say:

```text
Resume Workbench work on <repository name> from the progress document.
```

Workbench can then read the handoff document, verify source scope and git status, and continue from the next unchecked task.

### OpenAI Custom GPT interface limits

Workbench cannot directly rename ChatGPT’s native conversation titles, batch names, or input placeholder. Those UI elements are controlled by OpenAI’s ChatGPT interface, not by the Workbench action schema.

The practical workaround is to use one source per conversation, start prompts with the source name, and rely on persistent repo-local handoff documents. If your ChatGPT client supports manually renaming a conversation, rename it to the repo or goal.

## Effective Workbench prompts

Use this pattern for serious work:

```text
Activate <repository name>.

Goal:
<describe the feature, fix, refactor, or app you want built>

Work mode:
- Read only the exact context needed.
- Make the smallest safe change or create a concise plan.
- Run the smallest relevant validation after code/config/schema changes.
- Commit explicit changed paths when validation is clean or the change is docs-only.
- Stop with a concise result and the next concrete action.

Validation:
Use targeted type checks, tests, JSON validation, security scans, or git status checks only when they add useful evidence.

Git:
Commit only explicit paths. Push only if I explicitly ask.
```

### Example: build a feature

```text
Activate tradebot.

Goal:
Implement the missing failing endpoint fixes and make the API test suite pass.

Inspect the repo, make a concise implementation plan, complete the first safe slice, run targeted validation, and stop with the next concrete action.

Do not ask for intermediate approval unless Workbench requires confirmation. Commit explicit validated paths when appropriate.
```

### Example: build a module

```text
Activate my-app.

Goal:
Build a complete project intake module with pages, API routes, validation, tests, and documentation.

Use repo-local conventions. Inspect before writing. Complete the first safe slice, validate only what is relevant, commit explicit paths when appropriate, and report the next task.
```

### Example: refactor safely

```text
Activate prochat.

Goal:
Refactor the account settings flow into a cleaner service/module structure without changing external behavior.

Document the current structure and risks, plan the refactor, complete the first safe task, run targeted validation, and stop with a resume point.
```

### Example: improve a knowledge repo

```text
Activate brain.

Goal:
Clean up my AI skills folder, improve naming consistency, add README files where useful, and create an index of the most important skills.

Complete a bounded batch, but stop if Workbench blocks access to private or secret folders.
```

### Example: prepare a commit

```text
Activate workbench.

Goal:
Improve the dashboard source picker onboarding flow.

Validate the change, commit it with a clear message, and stop before pushing unless I ask.
```

## What ProChat Workbench can do today

ProChat Workbench currently includes:

- native macOS GUI, helper, and bundled portable core
- native API ingress on loopback `127.0.0.1:3154`
- public HTTPS deployment at `https://workbench.prochat.tools`
- compatibility HTTP stack only for explicit rollback
- source management for repos, notes, docs, skills, and local folders
- recursive repository discovery from a root folder
- local indexing and search
- active source context selection
- multi-source context support
- read batching for large files and large response budgets
- safe write mode controls
- dry-run and preflight write checks
- full read/write scope inside explicitly connected repositories, with a centralized protected-resource deny policy
- confirmation-gated sensitive writes
- verified file operations
- local activity feedback for Custom GPT actions
- dashboard activity overview
- local plans and tasks
- local plan import/export
- dynamic handoff prompts for Codex and Claude Code
- safe command runner for validation and git workflow checks
- fast repo-assistant workflow for small explicit tasks
- repo-local handoff docs with resume instructions
- conversation source-locking guidance for multiple simultaneous GPT chats
- first-run setup checklist
- user-owned Custom GPT OpenAPI endpoint setup

## Safety, benefits, and risks

Workbench is powerful because it connects ChatGPT to your local workspace. That also means it needs clear boundaries.

### Benefits

- ChatGPT can work with real files instead of pasted snippets.
- Your local repos remain the source of truth.
- Short implementation batches can be planned, executed, reviewed, validated, and committed in one ChatGPT workflow.
- Writes are policy-checked and verified.
- Commands are allowlisted instead of arbitrary.
- Routine repo-maintainer work can continue without constant confirmation stops.
- Sensitive paths require confirmation or remain blocked.
- You can keep project planning, implementation notes, and final reports together.
- Interrupted work can resume from repo-local handoff docs.

### Risks

- Any tool that can edit files can break code if given a vague or risky goal.
- A Custom GPT can misunderstand intent if the prompt is ambiguous.
- Long-running work can touch many files, so review diffs before committing.
- Command execution must stay allowlisted; unrestricted shell would be unsafe.
- Secrets and real environment values should not be exposed to ChatGPT.
- Push flows should run only when explicitly requested. Deployment flows should stay allowlisted rather than arbitrary shell.

### Important limitations

Workbench does not silently edit real `.env` files, expose secrets, run arbitrary shell commands, force-push, or deploy with unrestricted terminal access.

Routine app work is intentionally less interrupted now: package manifests, framework config, Docker files, scripts, migrations, and source-controlled assets can be edited under the repo-maintainer policy. The hard boundary is secrets, generated/runtime output, unsafe paths, and irreversible operations.

These actions are intentionally blocked or confirmation-gated:

- `.env` and `.env.*`
- private keys and credentials
- `.git/**`
- `node_modules/**`
- build outputs such as `.next/**`, `dist/**`, `build/**`, and `coverage/**`
- generated/runtime/log output
- path traversal and absolute paths outside a source
- binary writes unless explicitly supported
- lockfile changes
- GitHub workflow changes
- license changes
- destructive deletes
- deployment-like operations unless a future allowlisted command supports them

The goal is not to give a Custom GPT unlimited machine control. The goal is to give it enough structured local capability to build real software safely.

## Quick start

For the owner-local macOS runtime, use the supported lifecycle runbook rather
than starting compatibility services manually.

```bash
pnpm install
pnpm macos:doctor
```

Build, install, restart, and release verification are defined in
[`docs/operations/workbench-lifecycle-runbook.md`](docs/operations/workbench-lifecycle-runbook.md).
The Action Token remains owner-local and the public Custom GPT endpoint remains
the HTTPS service; the macOS application supplies the local connected-source
runtime but is not itself the Custom GPT server.

When running the native helper transport, use Settings → Installation &
Updates to review a prepared `workbench-macos-release.json` manifest. The GUI
shows the installed and candidate version/revision, requires one explicit
approval, and delegates staging, promotion, restart, health verification, and
rollback to the installed `workbenchctl` lifecycle controller. It does not
auto-update, copy bundles, edit release state, or hide restart/recovery.

For local operator inspection, the native GUI is the primary surface. The
native ingress is:

```text
http://127.0.0.1:3154
```

The dashboard guides you through setup:

1. confirm the GUI/helper/native host topology is healthy
2. confirm connected repositories are visible
3. verify the public OpenAPI endpoint when using Custom GPT Actions
4. activate a repository by its human-readable name
5. keep the returned source locked for the conversation

For terminal-based local diagnosis after building the CLI, use the bounded
doctor command. It reports registration, index, provider, and runtime health
without automatically disabling or removing registrations:

```bash
pnpm --dir packages/cli build
node packages/cli/dist/bin/workbench.js doctor --json
```

## Connect a Custom GPT

In the Custom GPT editor, import the Workbench action schema from your own endpoint.

Use the checked-in schema for inspection, and use the deployed HTTPS schema
for Custom GPT import:

```text
Local reference file:
docs/openapi.chatgpt.json

Owner-local inspection endpoint:
http://127.0.0.1:3154/api/openapi

Canonical Custom GPT endpoint:
https://workbench.prochat.tools/api/openapi
```

Another deployment may use its own HTTPS domain or tunnel. A Custom GPT must
not import a localhost or native-port server URL.

Then add the instructions from:

```text
docs/CUSTOM_GPT_INSTRUCTIONS.md
```

After changing the schema or instructions, re-import the action definition in the GPT editor, save the GPT, and start a new chat so ChatGPT uses the updated actions.

## Practical recommendation

For everyday questions, just ask normally:

```text
What does this repo do?
Find where the auth flow is implemented.
Read the README and suggest improvements.
```

For implementation work, be explicit:

```text
Activate Workbench, select the intended repository by name, and complete one
bounded task. Validate and commit only the explicit paths, then stop unless I
ask you to continue.
```

For protected work, add boundaries:

```text
Do not change dependencies, edit migrations, touch deployment files, or run destructive cleanup unless I explicitly confirm.
```

## How the workflow feels

```mermaid
flowchart TD
  Idea["High-level goal"] --> Chat["Custom GPT"]
  Chat --> Job["Start bounded batch"]
  Job --> Inspect["Inspect repo"]
  Inspect --> Doc["Document goal and tasks"]
  Doc --> Task["Execute next task"]
  Task --> Review["Review changed files"]
  Review --> Validate["Run validation"]
  Validate --> Repair{"Pass?"}
  Repair -->|No| Task
  Repair -->|Yes| Update["Update progress docs"]
  Update --> Done{"Goal complete?"}
  Done -->|No| Task
  Done -->|Yes| Report["Final report"]
```

## Custom GPT actions

ProChat Workbench exposes exactly five Custom GPT actions:

- `getWorkbenchStatus`
- `readWorkbenchContext`
- `applyWorkbenchFileChange`
- `commitWorkbenchChanges`
- `runWorkbenchCommand`

These actions let ChatGPT inspect, read, write, validate, commit, and continue
bounded Quick or Goal mode work without pretending it has unrestricted local
access.

There is no Custom GPT action for changing dashboard active context. The GPT locks a `sourceId` conversationally after `getWorkbenchStatus?include=sources` and passes that explicit `sourceId` on every repo action. Legacy `/api/actions/agent/*` polling routes are retired and must not be imported into the GPT schema.

## Who ProChat Workbench is for

ProChat Workbench is for:

- indie hackers building apps with ChatGPT
- developers who want local-first AI workflows
- teams experimenting with Custom GPTs over internal repos
- people maintaining large note, brain, or skill folders
- consultants who want repeatable AI-assisted implementation workflows
- builders who want the planning quality of ChatGPT with the grounding of local files
- anyone who wants to reduce copy-paste between chat, repo, docs, and terminal

## What ProChat Workbench is not

ProChat Workbench is not a hosted backend, not an unrestricted terminal bridge, and not a replacement for reviewing your own code.

It is the local context, safety, and execution layer between ChatGPT and your workspace.

Use it to reason, plan, inspect, read, write verified changes, run safe validation, and work through implementation goals with guardrails.

## Product docs

Useful docs:

- [`docs/product/README.md`](docs/product/README.md) — product index
- [`docs/product/philosophy.md`](docs/product/philosophy.md) — Workbench philosophy
- [`docs/product/strategy.md`](docs/product/strategy.md) — current architecture and operating modes
- [`docs/product/chatgpt-first-workflow.md`](docs/product/chatgpt-first-workflow.md) — ChatGPT-first strategy
- [`docs/product/public-scope.md`](docs/product/public-scope.md) — public Workbench scope
- [`docs/product/local/feature-scope.md`](docs/product/local/feature-scope.md) — Local feature scope
- [`docs/openapi.chatgpt/README.md`](docs/openapi.chatgpt/README.md) — Custom GPT action import guide
- [`docs/CUSTOM_GPT_INSTRUCTIONS.md`](docs/CUSTOM_GPT_INSTRUCTIONS.md) — GPT instructions

## Roadmap ideas

ProChat Workbench Local is moving toward a more complete ChatGPT-first local repository workspace.

Public areas worth exploring include:

- richer activity history;
- better dashboard progress views;
- clearer handoff and resume persistence;
- more repository-agnostic command recipes;
- safer local command profiles;
- better diff previews;
- improved setup for non-technical users;
- reusable local skill packages.

Open an issue if you have a local-first workflow Workbench should support.

## Licensing

The generated public Workbench Local repository is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`) as the Workbench Local product-specific exception recorded in Mind. See [`LICENSE`](LICENSE).

That exception applies only to ProChat Workbench Local public snapshot files. It does not apply to ProChat Memory, ProChat Memory for QA, future products, managed services, private modules, customer operations, or internal commercial systems.

A separate commercial or OEM license may be requested by organizations that need proprietary embedding, redistribution, or modified hosted use. Public documentation does not grant commercial or OEM rights; commercial rights require a separate written agreement. See [`COMMERCIAL-LICENSING.md`](COMMERCIAL-LICENSING.md). ProChat trademarks are governed separately by [`TRADEMARKS.md`](TRADEMARKS.md).

The private engineering repository is the authoritative implementation source for Workbench code and release mechanics. Mind remains authoritative for company-level strategy and the Workbench Local licensing exception. Public releases are deterministic, reviewed snapshots generated from exact private commits. Managed services, private modules, customer operations, and internal commercial material are not part of the public snapshot.

The dashboard includes a source-code link. Operators of modified network-accessible versions must provide the corresponding source required by the AGPL.

## Contributing

ProChat Workbench Local is free, self-hosted, and open source.

- Star or fork the public repository.
- Try it on a repository you control.
- Share feedback, issues, and feature requests.
- Do not include secrets, private logs, or customer data.
- Review [`CONTRIBUTING.md`](CONTRIBUTING.md) before submitting code.

```text
github.com/prochattools/workbench
```

External code contributions require contributor terms that preserve ProChat's ability to distribute accepted work under both AGPL and separate commercial licenses. Issues and design feedback do not require a contributor agreement.

Workbench is still early, but it is already useful. The best way to improve it is to use it on real work and explain where the workflow still feels slow, risky, or magical in the wrong way.
