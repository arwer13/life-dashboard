import esbuild from "esbuild";

const production = process.argv[2] === "production";
const watch = process.argv[2] === "watch";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  external: ["obsidian", "@codemirror/state", "@codemirror/view"],
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  logLevel: "info"
});

if (watch) {
  await context.watch();
  console.log("[esbuild] watching...");
} else {
  await context.rebuild();
  await context.dispose();
}
