#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("dist/actions", { recursive: true });

for (const action of [
  "mark-blocked",
  "mcp-gateway",
  "plan-stage",
  "run-action",
  "security-review",
]) {
  const launcherFile = `dist/actions/${action}.js`;
  const bundleFile = `dist/actions/${action}.mjs`;

  await build({
    banner: {
      js: 'import { createRequire as __gitVibeCreateRequire } from "node:module"; const require = __gitVibeCreateRequire(import.meta.url);',
    },
    bundle: true,
    entryPoints: [`src/runner/actions/${action}.ts`],
    format: "esm",
    logLevel: "info",
    minify: false,
    outfile: bundleFile,
    platform: "node",
    sourcemap: false,
    target: "node22",
  });

  const bundled = readFileSync(bundleFile, "utf8").replace(/^(?:#![^\n]*\n)+/, "");
  writeFileSync(bundleFile, bundled.replace(/[ \t]+$/gm, ""));
  writeFileSync(launcherFile, `#!/usr/bin/env node\nimport "./${action}.mjs";\n`);
}
