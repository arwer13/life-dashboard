# Life Dashboard (Obsidian plugin)

An Obsidian plugin that shows a sidebar outline of notes filtered by a frontmatter property.

- Compatible with latest Obsidian Desktop public release only (`minAppVersion: 1.11.0`)
- Versioning starts at `0.1.0`; every `npm run build` increments patch (`z`) in `x.y.z`
- Task tracker panel with start/stop and task picker
- Filters task notes by frontmatter (default: `type=concen`)
- Optional second filter (property + value) configurable in settings
- Collapsible task tree using frontmatter `parent`
- Outline shows cumulative recursive tracked time for each task
- Click task note to open it

## Files in this plugin

- `manifest.json`
- `main.js`
- `styles.css`
- `versions.json` (optional for local use, standard for release metadata)
- `.env.example` (template for local env config)
- `.hotreload` (generated marker file for Hot-Reload plugin)
- `.env` (local vault path for dev sync)
- `scripts/sync-plugin.mjs` (sync script used by npm scripts)
- `package.json`

## Recommended dev workflow (fast iteration)

This repo is configured so `npm run dev` copies plugin files to your vault automatically.

1. Create `.env` from template:
   - `cp .env.example .env`
2. Edit `.env`:
   - `VAULT_PATH='/absolute/path/to/your/vault'`
3. Run:
   - `npm run dev`
4. In Obsidian:
   - Enable **Life Dashboard** once in **Settings -> Community plugins**
   - Enable **Hot-Reload** plugin for automatic refreshes

`npm run dev` watches and syncs these files into:
- `<VAULT_PATH>/.obsidian/plugins/life-dashboard/`
- `manifest.json`
- `main.js`
- `styles.css`
- `versions.json`
- `.hotreload`

One-time sync without watch:
- `npm run build` (bumps version: `x.y.z -> x.y.(z+1)`, updates top-bar version label, touches `.hotreload`, then syncs)

## Hot-Reload integration

If you install the community plugin [Hot-Reload](https://github.com/pjeby/hot-reload) in Obsidian:

1. Enable Hot-Reload in your vault.
2. Run `npm run build` after making changes.

Build updates `.hotreload` and copies it to your plugin folder, which gives Hot-Reload a guaranteed file change to react to.
The plugin also remembers whether its pane was open and restores it on startup/reload.

## Time tracking behavior

- Start/stop tracking from the top panel (`+` and `-` buttons).
- Start/stop tracking from the top panel (`Start` / `Stop` button).
- `Change task...` opens a selector limited to filtered task notes.
- `Clear task` clears selection (disabled while running).
- If tracking is not running and the active note matches task filters, it is auto-selected.
- Every stopped session is appended to JSON log file.
- If a tracked task note has no frontmatter `id`, plugin auto-creates one (UUID) and uses it for tracking records.

Default log file:
- `time-tracked.json` in vault root

Configurable in settings:
- `Time log file path` (vault-relative path)

Stored entry format:

```json
{
  "noteId": "2a6c0ec4-2c4f-471f-8b35-13fbe5f15932",
  "start": "2026.02.11-09:15",
  "durationMinutes": 50
}
```

Migration:
- Existing legacy entries (`notePath`, `finish`, `durationSeconds`) are migrated once to v2 (`noteId`, `durationMinutes`).
- After migration, plugin uses only v2 schema.

## Manual install (fallback)

1. Open your vault folder.
2. Create plugin directory:
   - `<Vault>/.obsidian/plugins/life-dashboard/`
3. Copy these files into that folder:
   - `manifest.json`
   - `main.js`
   - `styles.css`
   - `versions.json`
4. In Obsidian, open **Settings -> Community plugins**.
5. Turn off **Restricted mode** (if enabled).
6. In **Installed plugins**, enable **Life Dashboard**.

## Configure

1. Go to **Settings -> Life Dashboard**.
2. Set:
   - **Task property name** (default `type`)
   - **Task property value** (default `concen`)
   - **Additional filter property** (optional)
   - **Additional filter value** (optional)
   - **Case sensitive** toggle
   - **Time log file path** (default `time-tracked.json`)
   - Optional note hierarchy:
     - Set frontmatter `parent` on child note to parent note name/path/wiki-link

## Use

- Run command: **Open Life Dashboard**
- Or click the ribbon icon (tree list icon)
- The view opens in the right sidebar and auto-refreshes when notes/frontmatter change.

## Example frontmatter

```md
---
status: active
project: alpha
---
```

If plugin setting is:
- `Property name = status`
- `Property value = active`

Then this note will be included in the outline.

Example parent link:

```md
---
status: active
parent: "[[Projects]]"
---
```

## Notes

- This implementation is intentionally for latest Obsidian only (no backward compatibility shims).
- For Community Plugin Store publishing, you would additionally need a build/release pipeline and repository metadata.
