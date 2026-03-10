import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, ".env");
const MANIFEST_PATH = path.join(ROOT, "manifest.json");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const VERSIONS_PATH = path.join(ROOT, "versions.json");
const VERSION_SOURCE_PATH = path.join(ROOT, "src", "version.ts");
const HOT_RELOAD_PATH = path.join(ROOT, ".hotreload");

const WATCH_MODE = process.argv.includes("--watch");
const RELEASE_MODE = process.argv.includes("--release");
const FILES_TO_SYNC = ["manifest.json", "main.js", "styles.css", "versions.json", ".hotreload"];

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Invalid version format: ${version}. Expected x.y.z`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function nextPatch(version) {
  const parsed = parseSemver(version);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function parseEnv(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }
  return result;
}

async function readConfig() {
  let envRaw;
  try {
    envRaw = await fsp.readFile(ENV_PATH, "utf8");
  } catch {
    throw new Error("Missing .env. Create .env with VAULT_PATH=/absolute/path/to/vault");
  }

  const env = parseEnv(envRaw);
  if (!env.VAULT_PATH) {
    throw new Error("VAULT_PATH is missing in .env");
  }

  const manifestRaw = await fsp.readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(manifestRaw);
  if (!manifest.id) {
    throw new Error("manifest.json is missing plugin id");
  }

  const targetDir = path.join(env.VAULT_PATH, ".obsidian", "plugins", manifest.id);
  return { targetDir, pluginId: manifest.id, minAppVersion: manifest.minAppVersion };
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function syncFile(fileName, targetDir) {
  const src = path.join(ROOT, fileName);
  const dest = path.join(targetDir, fileName);

  try {
    await fsp.access(src, fs.constants.R_OK);
  } catch {
    return;
  }

  await fsp.copyFile(src, dest);
  console.log(`[sync] ${fileName}`);
}

async function syncAll(targetDir) {
  await ensureDir(targetDir);
  for (const fileName of FILES_TO_SYNC) {
    await syncFile(fileName, targetDir);
  }
}

function watchFiles(targetDir) {
  const timers = new Map();

  for (const fileName of FILES_TO_SYNC) {
    const src = path.join(ROOT, fileName);
    if (!fs.existsSync(src)) continue;

    fs.watch(src, { persistent: true }, () => {
      clearTimeout(timers.get(fileName));
      const timer = setTimeout(async () => {
        try {
          await syncFile(fileName, targetDir);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[sync:error] ${fileName}: ${message}`);
        }
      }, 50);
      timers.set(fileName, timer);
    });
  }
}

function runBuildOnce() {
  execFileSync("node", ["esbuild.config.mjs", "production"], {
    cwd: ROOT,
    stdio: "inherit"
  });
}

function startBuildWatch() {
  const child = spawn("node", ["esbuild.config.mjs", "watch"], {
    cwd: ROOT,
    stdio: "inherit"
  });

  const stop = () => {
    if (!child.killed) child.kill();
  };

  process.on("exit", stop);
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
}

async function bumpProjectVersion(minAppVersion) {
  const [manifestRaw, packageRaw] = await Promise.all([
    fsp.readFile(MANIFEST_PATH, "utf8"),
    fsp.readFile(PACKAGE_PATH, "utf8")
  ]);

  const manifest = JSON.parse(manifestRaw);
  const pkg = JSON.parse(packageRaw);

  if (!manifest.version || !pkg.version) {
    throw new Error("Missing version field in manifest.json or package.json");
  }

  if (manifest.version !== pkg.version) {
    throw new Error(
      `Version mismatch: manifest.json=${manifest.version}, package.json=${pkg.version}`
    );
  }

  const bumped = nextPatch(manifest.version);
  manifest.version = bumped;
  pkg.version = bumped;

  let versions = {};
  try {
    versions = JSON.parse(await fsp.readFile(VERSIONS_PATH, "utf8"));
  } catch {
    // start fresh if missing or corrupt
  }
  versions[bumped] = minAppVersion;

  const versionSourceRaw = await fsp.readFile(VERSION_SOURCE_PATH, "utf8");
  const nextVersionSource = versionSourceRaw.replace(
    /export const DISPLAY_VERSION = "[^"]+";/,
    `export const DISPLAY_VERSION = "${bumped}";`
  );
  if (nextVersionSource === versionSourceRaw) {
    throw new Error("Could not update DISPLAY_VERSION in src/version.ts");
  }

  await Promise.all([
    fsp.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n"),
    fsp.writeFile(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + "\n"),
    fsp.writeFile(VERSIONS_PATH, JSON.stringify(versions, null, 2) + "\n"),
    fsp.writeFile(VERSION_SOURCE_PATH, nextVersionSource, "utf8")
  ]);

  console.log(`[version] bumped to ${bumped}`);
  return bumped;
}

async function touchHotReloadMarker() {
  const stamp = new Date().toISOString();
  await fsp.writeFile(HOT_RELOAD_PATH, `${stamp}\n`, "utf8");
  console.log("[hotreload] touched .hotreload");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gitExec(...args) {
  execFileSync("git", args, { cwd: ROOT, stdio: "inherit" });
}

function gitOutput(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function commitAndTag(version) {
  const versionFiles = [
    "manifest.json",
    "package.json",
    "versions.json",
    "src/version.ts"
  ];

  const status = gitOutput("status", "--porcelain", "--", ...versionFiles);
  if (!status) {
    throw new Error("No version file changes to commit. Was the version already bumped?");
  }

  gitExec("add", "--", ...versionFiles);
  gitExec("commit", "-m", `release: ${version}`);
  gitExec("tag", "-a", version, "-m", version);
  console.log(`[release] committed and tagged ${version}`);
  console.log(`[release] run 'git push --follow-tags' to trigger the release workflow`);
}

async function main() {
  const { targetDir, pluginId, minAppVersion } = await readConfig();

  let bumpedVersion;
  if (RELEASE_MODE) {
    bumpedVersion = await bumpProjectVersion(minAppVersion);
  }

  if (WATCH_MODE) {
    startBuildWatch();
    await sleep(800);
  } else {
    runBuildOnce();
  }

  await touchHotReloadMarker();
  await syncAll(targetDir);

  console.log(`[ready] plugin=${pluginId}`);
  console.log(`[ready] target=${targetDir}`);

  if (RELEASE_MODE) {
    commitAndTag(bumpedVersion);
    return;
  }

  if (!WATCH_MODE) return;

  watchFiles(targetDir);
  console.log("[watch] Watching plugin files for changes...");
  process.stdin.resume();
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[fatal] ${message}`);
  process.exit(1);
});
