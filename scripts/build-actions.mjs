#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("dist/actions", { recursive: true });
const launcherFile = "dist/actions/run-action.js";
const bundleFile = "dist/actions/run-action.cjs";

await build({
  bundle: true,
  entryPoints: ["src/actions/run-action.ts"],
  format: "cjs",
  logLevel: "info",
  minify: false,
  outfile: bundleFile,
  platform: "node",
  sourcemap: false,
  target: "node22",
});

const bundled = readFileSync(bundleFile, "utf8").replace(/^(?:#![^\n]*\n)+/, "");
writeFileSync(bundleFile, bundled.replace(/[ \t]+$/gm, ""));
writeFileSync(launcherFile, '#!/usr/bin/env node\nimport "./run-action.cjs";\n');
