#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("dist/actions", { recursive: true });

for (const action of ["run-action", "run-develop", "setup-ai-cli"]) {
  const launcherFile = `dist/actions/${action}.js`;
  const bundleFile = `dist/actions/${action}.cjs`;

  await build({
    bundle: true,
    entryPoints: [`src/runner/actions/${action}.ts`],
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
  writeFileSync(launcherFile, `#!/usr/bin/env node\nimport "./${action}.cjs";\n`);
}
