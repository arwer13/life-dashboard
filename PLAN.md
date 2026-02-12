# Life Dashboard Improvement Plan (Next Iterations)

This plan captures the remaining high-impact improvements after completing items 4, 5, and 8.

## Iteration 1 (Data Integrity)

1. Make time-log schema lossless
- Problem: tracked intervals are rounded/truncated to minute precision.
- Scope:
  - Replace minute-token persistence with second/ms-accurate storage.
  - Keep backward compatibility via migration from existing schema.
  - Preserve ordering and overlap validation in the new format.
- Files:
  - `src/services/time-log-store.ts`
  - `src/settings.ts`
  - `README.md`
- Success criteria:
  - No data loss when tracking short sessions.
  - Existing logs migrate automatically and safely.

2. Prevent accidental log wipe on malformed JSON
- Problem: malformed log files currently normalize to empty data.
- Scope:
  - Detect parse failures and stop destructive writes.
  - Write a backup copy before any migration/repair write.
  - Show clear user-facing notice with next action.
- Files:
  - `src/services/time-log-store.ts`
- Success criteria:
  - Parse errors never overwrite user data.
  - Backup and message are reliably produced.

## Iteration 2 (Release & Performance)

3. Preserve `versions.json` history on deploy
- Problem: deploy currently rewrites `versions.json` with only latest version.
- Scope:
  - Load existing `versions.json`, merge new version mapping, write merged output.
  - Keep stable formatting and deterministic key order.
- Files:
  - `scripts/sync-plugin.mjs`
- Success criteria:
  - Previous compatibility mappings remain after each deploy.

4. Reduce full rescans/full rerenders
- Problem: current event handling frequently rebuilds whole task list/tree and view.
- Scope:
  - Debounce event-triggered refreshes.
  - Introduce cache/index for filtered tasks and/or tree inputs.
  - Recompute only affected parts after vault/metadata events when possible.
- Files:
  - `src/plugin.ts`
  - `src/services/task-filter-service.ts`
  - `src/ui/life-dashboard-view.ts`
- Success criteria:
  - Improved responsiveness on large vaults.
  - Lower CPU churn during active note editing/renames.

## Iteration 3 (Quality & Distribution)

5. Add automated tests and CI checks
- Problem: no tests currently cover core logic.
- Scope:
  - Add unit tests for time-log parsing/migration/normalization.
  - Add tests for tracking start/stop lifecycle.
  - Add tests for outline/task filtering behavior.
  - Run tests + `npm run check` in CI.
- Files:
  - `src/services/time-log-store.ts`
  - `src/services/tracking-service.ts`
  - `src/ui/life-dashboard-view.ts`
  - CI workflow files
- Success criteria:
  - Core data logic is regression-protected.
  - CI blocks merges when type-check/tests fail.

6. Align manifest description with current feature set
- Problem: plugin metadata under-describes current capabilities.
- Scope:
  - Update `manifest.json` description to reflect time tracking + concern outline.
  - Keep README and manifest messaging consistent.
- Files:
  - `manifest.json`
  - `README.md`
- Success criteria:
  - Store metadata clearly communicates actual functionality.
