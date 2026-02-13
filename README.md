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
- `src/ui/life-dashboard-view.ts` custom timer + outline view UIs
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
- `Open Life Dashboard` opens two separate right-side tabs: `Life Timer` and `Concerns Outline`
- `Change task...` opens filtered task selector
- while tracking, round timer shows tracking start time as `HH:mm` (small text above elapsed timer)
- while tracking, round timer shows a compact `+5m` button next to start time
- `+5m` shifts timer start earlier by up to 5 minutes without overlapping existing saved entries (all concerns)
- if no safe extension is available, `+5m` is disabled
- timer side summary shows cumulative `This week` and `Yesterday`
- timer side list heading shows `Today (<duration>):`, followed by today's entries as `HH:mm Xm`
- timer alerts (from notification rules) use system notification + native desktop beep
- summary and today's entries refresh after startup and after stopping a tracking session
- if timer is idle and active note matches task filters, it auto-selects
- when first tracking a note, plugin ensures frontmatter `id` exists (UUID) and uses that stable ID in log entries
- per-note arrays are sorted by start time ascending
- intervals for one note are validated to prevent overlap
- outline has a range selector (`today`, `this week`, `this month`, `all time`) that scopes cumulative time badges
- optional outline checkbox `Show only tracked this period` hides concerns with under 1 minute in selected range
- period labels/buttons include tooltips showing the exact date-time window used

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
- `Week starts on` (`Monday` or `Sunday`, used by `This week` totals and range filtering)
- `Timer notifications` (multiline rules, one per line)

Timer notification rule format:

- `<duration> "message"`
- examples:
  - `30m "Hey, the time is up!"`
  - `35m "You don't wanna miss the opportunity!"`
- supported duration units: `s`, `m`, `h`
- when a threshold is reached, plugin sends a system notification and plays a native desktop beep

## Manual plugin install (fallback)

Copy these files to:
`<Vault>/.obsidian/plugins/life-dashboard/`

- `manifest.json`
- `main.js`
- `styles.css`
- `versions.json`

Then enable the plugin in **Settings → Community plugins**.
