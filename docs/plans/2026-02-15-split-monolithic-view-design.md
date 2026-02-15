# Design: Split monolithic life-dashboard-view.ts

## Problem

`src/ui/life-dashboard-view.ts` is 2,427 lines (44% of codebase). It contains 6 classes and ~15 type definitions. The 5 concrete view classes are completely independent — they share no mutable state and communicate only through the plugin instance. The abstract base class conflates pure computation (tree-building, filtering, sorting) with UI view scaffolding.

## Approach

### 1. Extract pure computation into services

Move tree-building, filtering, sorting, and priority logic out of the abstract base view into standalone service modules. These become unit-testable without Obsidian runtime.

- `src/services/task-tree-builder.ts` — `buildTaskTree`, `computeSubtreeLatestStartMs`, `computeCumulative`, priority comparison, parent resolution
- `src/services/outline-filter.ts` — `parseFilterTokens`, `filterTasksByQuery`, `matchesFrontmatterFilter`

### 2. Extract types into dedicated modules

- Shared view types (`TaskTreeData`, `OutlineFilterToken`, `OutlineSortMode`, etc.) go to `src/models/types.ts`
- Canvas-specific types (`CanvasTreeDraft`, `PersistedCanvasDraftState`) go with the canvas view
- Constants (`OUTLINE_RANGE_OPTIONS`, `OUTLINE_SORT_OPTIONS`, `MIN_TRACKED_SECONDS_PER_PERIOD`) go to a shared location importable by multiple views

### 3. Split views into individual files

Each view becomes its own file under `src/ui/views/`:

```
src/ui/views/
  base-view.ts              (~30 lines - thin abstract ItemView, delegates to services)
  timer-view.ts             (~310 lines)
  outline-view.ts           (~510 lines)
  canvas-view.ts            (~520 lines)
  calendar-view.ts          (~470 lines)
  time-log-view.ts          (~165 lines)
  index.ts                  (re-exports all view types and classes)
```

### 4. Formalize render contract

Replace duck-typing in `DashboardViewController` (`"render" in leaf.view`) with a proper interface:

```typescript
interface RenderableView {
  render(): Promise<void>;
}
```

### 5. Fix deprecated API usage

Replace `getRightLeaf(split)` with modern equivalent.

## Non-goals

- No behavioral changes — purely structural refactoring
- No new features or UI changes
- No test infrastructure (separate effort)
