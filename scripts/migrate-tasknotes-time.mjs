import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ENV_PATH = path.resolve(".env");

function parseEnv(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const fm = m[1];
  const content = text.slice(m[0].length);
  return { fm, content };
}

function getScalar(fm, key) {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = fm.match(re);
  if (!m) return "";
  return m[1].trim().replace(/^['\"]|['\"]$/g, "");
}

function hasKey(fm, key) {
  const re = new RegExp(`^${key}:\\s*`, "m");
  return re.test(fm);
}

function parseTimeEntries(fm) {
  const m = fm.match(/^timeEntries:\s*\n((?:[ \t].*(?:\r?\n|$))*)/m);
  if (!m) return [];
  const block = m[1];
  const lines = block.split(/\r?\n/).filter(Boolean);
  const entries = [];
  let current = null;

  const assign = (obj, kv) => {
    const idx = kv.indexOf(":");
    if (idx < 0) return;
    const key = kv.slice(0, idx).trim();
    const value = kv.slice(idx + 1).trim().replace(/^['\"]|['\"]$/g, "");
    obj[key] = value;
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("- ")) {
      if (current) entries.push(current);
      current = {};
      assign(current, t.slice(2));
      continue;
    }
    if (current && t.includes(":")) {
      assign(current, t);
    }
  }

  if (current) entries.push(current);
  return entries;
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}-${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toDurationMinutes(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return { start: formatTimestamp(start), durationMinutes: Math.max(1, minutes) };
}

async function walkMdFiles(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMdFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

async function ensureDirFor(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function main() {
  const envRaw = await fs.readFile(ENV_PATH, "utf8");
  const env = parseEnv(envRaw);
  const vault = env.VAULT_PATH;
  if (!vault) throw new Error("VAULT_PATH missing in .env");

  const logPath = path.join(vault, "Data", "time", "time-tracked.json");
  await ensureDirFor(logPath);

  const existing = await loadJson(logPath, { version: 2, entries: [] });
  const existingEntries = Array.isArray(existing.entries) ? existing.entries : [];
  const dedupe = new Set(
    existingEntries
      .filter((e) => e && typeof e.noteId === "string")
      .map((e) => `${e.noteId}|${e.start}|${e.durationMinutes}`)
  );

  const mdFiles = await walkMdFiles(vault);
  let notesScanned = 0;
  let notesWithEntries = 0;
  let idsAdded = 0;
  let migrated = 0;

  const newEntries = [];

  for (const filePath of mdFiles) {
    notesScanned += 1;
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;

    const { fm, content } = parsed;
    const type = getScalar(fm, "type").toLowerCase();
    if (type !== "concern" && type !== "concen") continue;

    const entries = parseTimeEntries(fm);
    if (!entries.length) continue;
    notesWithEntries += 1;

    let noteId = getScalar(fm, "id");
    let nextFm = fm;

    if (!noteId) {
      noteId = crypto.randomUUID();
      if (!hasKey(nextFm, "id")) {
        nextFm = `${nextFm}\nid: ${noteId}`;
      } else {
        nextFm = nextFm.replace(/^id:\s*.*$/m, `id: ${noteId}`);
      }

      const nextText = `---\n${nextFm}\n---\n${content}`;
      await fs.writeFile(filePath, nextText, "utf8");
      idsAdded += 1;
    }

    for (const entry of entries) {
      const startIso = entry.startTime || "";
      const endIso = entry.endTime || "";
      const converted = toDurationMinutes(startIso, endIso);
      if (!converted) continue;

      const record = {
        noteId,
        start: converted.start,
        durationMinutes: converted.durationMinutes
      };

      const key = `${record.noteId}|${record.start}|${record.durationMinutes}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      newEntries.push(record);
      migrated += 1;
    }
  }

  const output = {
    version: 2,
    entries: [...existingEntries, ...newEntries]
  };

  await fs.writeFile(logPath, JSON.stringify(output, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({
    vault,
    logPath,
    notesScanned,
    notesWithEntries,
    idsAdded,
    migratedEntriesAdded: migrated,
    totalEntries: output.entries.length
  }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
