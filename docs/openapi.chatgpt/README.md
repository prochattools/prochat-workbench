# ProChat Workbench Custom GPT Action Imports

Use this guide to connect a Custom GPT to your own ProChat Workbench endpoint.

Workbench is designed for two kinds of interaction:

- **Quick mode** for focused questions and small edits.
- **Goal mode** for substantial local development work built from persistent state and multiple bounded action cycles.

For the lowest-latency local repository work, use the native Workbench New Goal
surface. It reuses the same durable run and packet architecture without the
Custom GPT Action-ingress boundary. Custom GPT remains the supported
conversation-first path for remote planning, explanation, oversight, and
handoff; the five-Action public contract is unchanged.

The GPT-facing API remains short and fail-fast. Larger goals must be implemented through durable run state, bounded work packets, asynchronous local execution where supported, compact status retrieval, and resume checkpoints—not one indefinitely open request.

## Canonical schema sources

- schema file: `docs/openapi.chatgpt.json`
- owner-local native ingress for inspection: `http://127.0.0.1:3154/api/openapi`
- hosted endpoint: `https://workbench.prochat.tools/api/openapi`
- another HTTPS endpoint you control: `https://<your-domain-or-tunnel>/api/openapi`

For actual ChatGPT Actions, the server URL in the imported schema must be reachable by ChatGPT over HTTPS. A localhost server URL is suitable for local generation and inspection, not for ChatGPT-hosted runtime calls.

## Current action surface

The current stable schema exposes five operations:

- `getWorkbenchStatus`
- `readWorkbenchContext`
- `applyWorkbenchFileChange`
- `commitWorkbenchChanges`
- `runWorkbenchCommand`

These operations are the stable quick-mode foundation and the control surface for the first goal-mode phases.

Current route deadlines:

- status: 4 seconds
- read context: 8 seconds
- apply file change: 8 seconds
- commit changes: 10 seconds
- run command: 12 seconds

Routing and source-lock contract:

- `getWorkbenchStatus` is for health, explicit source discovery, and resume/current-state checks; it is not a generic content preflight.
- `readWorkbenchContext` owns repository files, symbols, and bounded task context. When the source is known, call it directly without a status round trip.
- `Workbench Private` resolves exactly to `prochattools-workbench`; never substitute Brain or another configured source.
- `runWorkbenchCommand` is reserved for explicit command, validation, or evidence operations. Do not use `git_status_short` as a generic repository/content preflight.

Public responses use the compact projection required by the GPT byte budget. Native macOS callers use the private full-source projection when path and index metadata are required; the projections are intentionally separate.

If an operation cannot finish safely, Workbench should return structured timeout, unavailable, confirmation, or narrower-scope guidance before the external action timeout.

### Durable validation results

`runWorkbenchCommand` keeps the existing five-operation public surface while allowing `validationJobOperation` to be `submit`, `status`, or `cancel`. A validation submit is acknowledged with the existing persisted `validationJobId`, also returned as `resultRef`. If the HTTP response is lost, retry the same `idempotencyKey` or query the result reference; do not submit a new job.

For `status`, omit `resultStream` for compact job state, or select `stdout`/`stderr` and request a bounded UTF-8 window with `resultPageBytes`. The response includes `resultPage.nextCursor` when more stored output exists. Pass that opaque cursor back with the same source and result reference. Pages are retry-stable, source-authorized, secret-redacted by the command runner, and retained only while the terminal job record is retained. `cancel` is a separate control request and must be reconciled by status. The public contract does not advertise heartbeat or SSE because support was not established by a real Custom GPT client.

In a fresh conversation, bootstrap the strict command session with one bounded `readWorkbenchContext` call using the already-known exact `sourceId` (for example `mode: "list_files", limit: 1`). Use the returned `workbenchRun.sessionId` exactly in the v2 `runWorkbenchCommand` envelope: `{ "version": 2, "sessionId": "<returned sessionId>", "command": { "sourceId": "<exact sourceId>", "commandKind": "<allowlisted command>" } }`. This is a read-only session bootstrap, not a status preflight; never invent or derive a session ID. If a read-only command returns `session_invalid`, bootstrap once again and retry only that same read-only command once. Correct strict-validation failures before retrying; never automatically retry mutations.

## Goal-mode behavior

The five-operation schema supports persistent goal-mode workflows through the existing bounded action surface described in:

- `docs/product/philosophy.md`
- `docs/product/strategy.md`
- `docs/product/roadmap.md`
- `docs/product/plans/agentic-work-packets.md`

The implemented model is:

```text
Custom GPT accepts a high-level goal
  -> loads or creates persistent run state
  -> verifies exact repository context
  -> compiles or reserves a bounded work packet
  -> submits through a short action
  -> Workbench executes locally
  -> GPT retrieves compact persisted evidence
  -> GPT continues only when continuation state permits it
```

The public contract remains five bounded operations. Persistent behavior is exposed through the existing action surface and verified change types rather than by importing legacy job routes directly into the Custom GPT schema.

Goal-mode safety requirements remain:

- bounded request and response sizes
- explicit `sourceId`
- idempotency
- stale-`HEAD` protection
- full packet preflight before writes
- exact changed paths
- compact status retrieval
- restart recovery
- confirmation, cancellation, and repair stop policies
- no unbounded host-terminal access, broad staging, hidden model runtime, or default push. `run_repo_shell` is owner-scoped to the selected source root, bounded, redacted, and denied only for the documented high-risk/system/secret boundary.

Quick mode remains available for focused questions and small edits. Goal mode should use durable run state, bounded packets, compact result review, exact resume state, and persisted continuation decisions without relying on arbitrary per-turn action counts. A goal scope may contain exact files or bounded repository-relative directory prefixes; every read and mutation must remain inside that declared scope.

## Context and navigation modes

`readWorkbenchContext` supports bounded navigation and exact reads:

- `graph_context` reads cached Graphify navigation metadata when present
- `grep_context` finds bounded matches in one file
- `read_range` returns a requested line range
- `read_symbol` returns a known TypeScript symbol block
- `read_paths` reads up to five exact files within byte limits
- `prepare_task_context` performs one bounded deterministic discovery pass

Use Graphify for unknown architecture, then verify exact source before editing. Graphify may be stale and must never be treated as source truth.

## Source behavior

- Every repo-specific action must pass an explicit `sourceId`.
- Dashboard active context is not implicit GPT scope.
- A conversation should lock one source until the user explicitly changes it.
- Configured Git worktrees may be grouped for dashboard use, but Workbench must not switch the GPT’s source silently.
- Call `getWorkbenchStatus?include=sources` before the first repo action and use one exact enabled returned ID.
- Reject `default`, `workspace`, `current`, and `repo`; Workbench returns an actionable source-selection response instead of dispatching them.

Natural activation is discovery-first: “Activate Workbench” lists the available
human-readable repository labels and their active state. “Activate
`<repository name>`” matches one unique enabled label/name after normalizing
case and common separators such as hyphens, underscores, and spaces. For
example, `workbench` matches `Workbench Private`. The GPT then uses the
returned ID internally to load bounded context and lock the conversation to that
source. Users do not need to know source IDs. Ambiguous names require a label
choice; the GPT must not guess or silently change the global dashboard context.

## Bounded command evidence

`runWorkbenchCommand` supports direct read-only `rg` execution with structured argv. Regex alternation remains one argument and the runner guarantees `shell:false`. The response can project the verified executable, exact arguments, match status, repository root, changed paths, protected-path changes, bounded output, and exit status. `rg` no-match exit `1` is a completed result.

The fixed `n8n_workflow_export` request is limited to the Brain source and approved workflow/artifact values. It requires an explicit backend-issued confirmation token and returns bounded artifact metadata. It cannot update, activate, delete, invoke, or deploy workflows. Confirmation-gated requests must stop until the user explicitly confirms.

Runtime validation is ordered: restart Workbench, verify unified health, regenerate the schema from the healthy endpoint, re-import it, refresh the GPT, lock an exact source, and test only through the confirmation boundary. A deployment-plan safety rejection is a successful safety result, not permission to bypass the boundary.

## Write and Git behavior

- Use guarded repo-relative paths only.
- Verify writes on disk.
- Use `dryRun` for unfamiliar sensitive paths.
- Never write secrets, `.env`, private keys, `.git/**`, vendor output, or generated build output.
- Stage explicit paths only.
- Never use broad automatic staging.
- Keep auto-push disabled by default.
- Push only with explicit user approval or a future reviewed source policy.

## Consequential operations

The schema should mark operations accurately for the Custom GPT platform.

- Reads and status checks are non-consequential.
- Writes, deletes, moves, commits, pushes, and protected maintenance operations require the appropriate consequential/confirmation behavior.
- A packet action must not hide consequential steps behind misleading metadata.

## Legacy compatibility

Use **ProChat Workbench** in public product language.

The identifier **BuildFlow** may remain in:

- repository and source IDs
- legacy CLI and script aliases
- environment variable fallbacks
- package internals
- historical releases and diagnostics

Legacy `/api/actions/agent/*` routes are retired from the current public GPT schema. If an old imported schema still calls them, reimport the current schema rather than treating those routes as supported goal-mode APIs.

## Import workflow

1. Start or deploy Workbench.
2. Open the `/api/openapi` endpoint.
3. Confirm the server URL is the HTTPS endpoint ChatGPT can reach.
4. Import the schema into the Custom GPT action editor.
5. Configure bearer authentication.
6. Apply the canonical instructions from `docs/CUSTOM_GPT_INSTRUCTIONS.md`.
7. Test status and source locking.
8. Test one exact read.
9. Test a write with `dryRun` before a real write.
10. Reimport the schema whenever operation contracts or descriptions change.

## Contract verification

Run:

```text
pnpm verify:gpt-actions
```

The verifier should continue checking:

- operation IDs and count
- schema and route alignment
- payload budgets
- OpenAI metadata description limits
- retired legacy routes
- source-lock requirements
- documentation alignment

As goal-mode operations are introduced, extend the verifier before exposing them publicly.
