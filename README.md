# Life Dashboard (Obsidian plugin)

Life Dashboard is an Obsidian community plugin for:

- tracking time on task notes (default filter: `type=concen`)
- selecting/auto-selecting active task notes
- persisting tracked sessions to a vault-local JSON file
- showing a collapsible parent/child task tree (`parent` frontmatter)
- showing recursive cumulative tracked time in the outline

## Tech stack (sample-plugin style)

This project follows the Obsidian sample plugin best practices from `AGENTS.md`:

- TypeScript source in `src/`
- esbuild bundling to root `main.js`
- minimal entrypoint (`src/main.ts`) and feature modules split across files
- version mapping via `manifest.json` + `versions.json`

## Project structure

- `src/main.ts` plugin entrypoint
- `src/plugin.ts` plugin lifecycle and domain logic
- `src/settings.ts` settings/defaults
- `src/ui/life-dashboard-view.ts` custom view UI
- `src/ui/task-select-modal.ts` task selector modal
- `src/models/types.ts` shared types
- `src/version.ts` build-stamped UI version
- `esbuild.config.mjs` bundler config
- `scripts/sync-plugin.mjs` build/version/sync workflow

## Setup

1. Install dependencies:
   - `npm install`
2. Create local env file:
   - `cp .env.example .env`
3. Set your vault path in `.env`:
   - `VAULT_PATH='/absolute/path/to/your/vault'`

## Scripts

- `npm run dev`
  - runs esbuild watch and syncs plugin artifacts into your vault plugin folder
- `npm run build`
  - one-shot production build of `main.js` only (no version bump, no vault sync)
- `npm run deploy`
  - bumps patch version (`x.y.z -> x.y.(z+1)`)
  - updates `src/version.ts`, `manifest.json`, `package.json`, `versions.json`
  - builds `main.js`
  - touches `.hotreload`
  - syncs artifacts into your vault plugin folder
  - exits immediately (does not stay in watch/background mode)
- `npm run check`
  - TypeScript type-check (`tsc --noEmit`)

## Time tracking format

Default file is `Data/time/time-tracked.json` (vault-relative, configurable in settings).

Current schema:

```json
{
  "2a6c0ec4-2c4f-471f-8b35-13fbe5f15932": [
    "2026.01.26-17:11T21M",
    "2026.01.26-18:03T2M"
  ]
}
```

Behavior:

- `Start`/`Stop` in panel controls tracking
- `Change task...` opens filtered task selector
- timer panel shows today's entries for the current task as `HH:mm Xm` (start-time + duration)
- today's entries refresh after startup and after stopping a tracking session
- if timer is idle and active note matches task filters, it auto-selects
- when first tracking a note, plugin ensures frontmatter `id` exists (UUID) and uses that stable ID in log entries
- per-note arrays are sorted by start time ascending
- intervals for one note are validated to prevent overlap

## Reload debugging

- on load, plugin writes to console:
  - `[life-dashboard] loaded v<version> at <ISO timestamp>`
- hot-reload plugin reloads this plugin when `main.js` or `styles.css` changes and `.hotreload` exists in the plugin folder
- for one-shot distribution without background watchers, use `npm run deploy`

## Task filtering

Settings:

- `Task property name` (default `type`)
- `Task property value` (default `concen`)
- `Additional filter property` (optional)
- `Additional filter value` (optional)
- `Case sensitive`

## Manual plugin install (fallback)

Copy these files to:
`<Vault>/.obsidian/plugins/life-dashboard/`

- `manifest.json`
- `main.js`
- `styles.css`
- `versions.json`

Then enable the plugin in **Settings → Community plugins**.
