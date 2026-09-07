# ChatGPT-first ProChat Workbench Workflow

ProChat Workbench should stay ChatGPT-first.

The self-hosted Local product should keep the BuildFlow engine, source indexer, safety policy, verified writes, and fallback dashboard. The main user experience should stay in ChatGPT through Custom GPT actions, structured action responses, handoff links, and later optional embedded app surfaces outside the public Local repo.

## Current state

Workbench Local already provides:

- user-owned Custom GPT action schema
- local agent and dashboard
- source management
- local indexing and search
- bounded source/provider health diagnostics and owner-approved reconciliation
- dashboard active source context
- branch-aware grouping for configured Git checkouts/worktrees
- safe write modes
- dry-run and preflight checks
- confirmation-gated writes
- verified writes
- local activity metadata
- local dashboard activity view
- local plans and tasks
- local plan import and export
- dynamic handoff prompts
- first-run setup checklist
- auto-index settings per source
- five GPT-facing Workbench actions with short route deadlines
- retired Agent Mode routes for stale schemas

The current friction is that users still move between ChatGPT, the Workbench dashboard, and terminal tooling for validation or external execution.

## Product direction

Workbench Local should treat ChatGPT as the primary workspace.

The dashboard should stay lean and useful, but it should not become the only place to understand what is happening. Every important Workbench operation should return enough structured information for the Custom GPT to render a clean, useful response in ChatGPT.

The goal is:

```text
ChatGPT = primary interface for planning, approval, progress, and results
Workbench Local = local repo connector, safety engine, indexer, logs, and fallback dashboard
```

## What belongs in self-hosted Workbench Local

Self-hosted Workbench Local should remain full-featured for individual builders and local-first workflows.

It should include:

- local source indexing and search
- multi-source context
- dashboard active context selection
- branch-aware source management for configured Git worktrees
- safe write policy
- dry-run and preflight checks
- confirmation-required write flows
- verified file operations
- local activity/event history
- structured ChatGPT action responses
- text-mode activity cards in ChatGPT
- text-mode confirmation prompts in ChatGPT
- local plans and tasks
- prompt and command handoff generation
- local handoff objects and links
- optional local command runner with strict confirmation
- dashboard fallback for source management, settings, logs, plans, and handoffs
- CLI doctor output for bounded registration, index, provider, and runtime
  diagnosis without automatic cleanup
- public docs and contribution flow

Workbench Local should not be intentionally crippled. The open-source version should be useful enough to run real work end-to-end on a user's own machine.

Custom GPT actions must still use explicit `sourceId` values. Dashboard active context and branch-group activation are convenience features, not implicit GPT scope.

## What stays out of the public Local repo

Some product surfaces should not be planned or implemented here.

Keep out of this repo:

- private product infrastructure
- centrally hosted endpoints
- centrally hosted relays
- private go-to-market planning
- multi-user hosted operations
- private packaging, marketplace, or distribution strategy
- native ChatGPT app packaging that depends on platform approval or private operational infrastructure

If those surfaces are pursued, document and build them in the separate private repo.

## ChatGPT-first feature phases

### Phase 1: Structured action responses

Make every Workbench action easy for the Custom GPT to summarize.

Every action activity payload should expose safe, UI-ready fields:

```json
{
  "activity": {
    "actionLabel": "Read repo files",
    "userMessage": "Read 3 files from buildflow.",
    "safeInputSummary": "sourceId=buildflow; reads=README.md",
    "safeOutputSummary": "Read 1 file.; verified=true",
    "whatHappened": ["Read 1 file."],
    "whatRemains": ["Review the returned file contents."],
    "provenFacts": ["BuildFlow verified this result."],
    "nextActions": ["Review the returned file contents."]
  }
}
```

The GPT should render this as:

- what I am doing
- what happened
- what was proven
- what remains
- available next actions

The response must stay safe: summaries should mention paths, counts, statuses, and verification results, not raw secrets or hidden model reasoning.

### Phase 2: Persistent activity history

Add a local activity/event store for Workbench operations.

Each action should create a safe event with:

- event ID
- timestamp
- source ID
- action name
- status
- safe input summary
- safe output summary
- changed paths when relevant
- verification status when relevant
- user-facing message

This supports both the dashboard and richer ChatGPT responses.

### Phase 3: ChatGPT action menus

Teach the Custom GPT to return compact action menus after meaningful work.

Example:

```text
Next actions:
1. Inspect changed files
2. Generate validation prompt
3. Create Codex handoff
4. Stop here
```

This keeps the workflow inside ChatGPT without requiring custom UI buttons.

### Phase 4: Handoff objects and links

Create stable local handoff objects for prompts and commands.

A handoff can contain:

- tool target
- repo path
- prompt
- command preview
- validation checklist
- risk level
- created timestamp

ChatGPT can show a link to the handoff, while BuildFlow remains the local store and safety layer.

### Phase 5: Confirmed local runner

Add optional local execution for generated commands only after explicit user confirmation.

Rules:

- never auto-run from a ChatGPT link
- show the exact command first
- require confirmation in BuildFlow
- stream or capture stdout/stderr
- store the result as an activity event
- keep destructive commands blocked or separately confirmed

### Phase 6: Optional embedded app surface outside Local scope

A richer embedded ChatGPT app surface can eventually provide real buttons, cards, diffs, and approval UI inside ChatGPT.

This should be treated as a separate product surface outside the public Local repo unless the project intentionally brings an open implementation back into Local later.

## UI response standard for Custom GPT

The Custom GPT should prefer this format after tool work:

```text
Workbench result

What I checked:
- ...

What happened:
- ...

Proven facts:
- ...

Still needed:
- ...

Next actions:
1. ...
2. ...
```

Keep it concise, structured, and grounded in Workbench action results.

## Safety boundary

BuildFlow must not expose hidden model reasoning. It should expose operational trace only:

- actions called
- safe inputs
- safe outputs
- files read
- files changed
- blocked reasons
- confirmation requirements
- verification status
- generated handoff prompts
- external validation results

No secrets, raw env values, tokens, or sensitive local configuration should be displayed.

## Success criteria

This strategy is working when:

- most routine work can be followed from ChatGPT alone
- users rarely need to open the dashboard except for setup, source management, logs, or handoff review
- every write has a clear preflight, confirmation, and verified result
- every non-executable step becomes a clear handoff prompt or command card
- Workbench Local remains useful, self-hosted, and independent
