import esbuild from "esbuild";
import { builtinModules } from "module";

const production = process.argv[2] === "production";
const watch = process.argv[2] === "watch";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2018",
  treeShaking: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules.map((m) => `node:${m}`),
    ...builtinModules,
  ],
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  logLevel: "info",
});

if (watch) {
  await context.watch();
  console.log("[esbuild] watching...");
} else {
  await context.rebuild();
  await context.dispose();
}
