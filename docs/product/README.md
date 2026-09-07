# ProChat Workbench Local Documentation

This index covers the generated public Workbench Local snapshot.

The current public beta is `1.3.14-beta`. It adds bounded local source/provider
health diagnostics and exact owner-approved reconciliation proposals while
keeping automatic cleanup disabled and ambiguous registrations blocked.

## Start here

1. [`public-scope.md`](./public-scope.md) — the free, self-hosted product boundary.
2. [`local/feature-scope.md`](./local/feature-scope.md) — supported local capabilities.
3. [`chatgpt-first-workflow.md`](./chatgpt-first-workflow.md) — how ChatGPT and Workbench divide responsibility.
4. [`agent-mode.md`](./agent-mode.md) — bounded persistent execution and packet behavior.
5. [`../openapi.chatgpt/README.md`](../openapi.chatgpt/README.md) — Custom GPT action setup.
6. [`../CUSTOM_GPT_INSTRUCTIONS.md`](../CUSTOM_GPT_INSTRUCTIONS.md) — public Custom GPT instructions.

The current release also documents bounded direct `rg` search, exact command evidence, strict source locking, placeholder rejection, confirmation-gated operations, bounded doctor diagnostics, owner-approved reconciliation, and the fixed read-only Brain workflow export. These capabilities remain constrained by the five-action public surface.

## Public boundary

The public repository contains Workbench Local only. Managed services, customer operations, billing systems, private modules, internal release controls, and commercial planning are not part of the generated snapshot.

Public source is licensed under `AGPL-3.0-only`. Separate commercial or OEM licensing may be available as described in the repository root.
