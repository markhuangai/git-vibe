#!/usr/bin/env node

import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** @type {Record<string, { packageName: string, targetTriple: string }>} */
const nativePackages = {
  "darwin:arm64": {
    packageName: "@openai/codex-darwin-arm64",
    targetTriple: "aarch64-apple-darwin",
  },
  "darwin:x64": {
    packageName: "@openai/codex-darwin-x64",
    targetTriple: "x86_64-apple-darwin",
  },
  "linux:arm64": {
    packageName: "@openai/codex-linux-arm64",
    targetTriple: "aarch64-unknown-linux-musl",
  },
  "linux:x64": {
    packageName: "@openai/codex-linux-x64",
    targetTriple: "x86_64-unknown-linux-musl",
  },
};

const executable = resolveCodexExecutable();
if (!executable) process.exit(1);

console.log(executable);

function resolveCodexExecutable() {
  const configured = process.env.GITVIBE_CODEX_PATH;
  if (configured) return isExecutable(configured) ? configured : undefined;

  const native = nativePackage();
  if (!native) return undefined;

  try {
    const sdkEntry = import.meta.resolve("@openai/codex-sdk");
    const sdkRequire = createRequire(sdkEntry);
    const codexPackageJson = sdkRequire.resolve("@openai/codex/package.json");
    const codexRequire = createRequire(codexPackageJson);
    const packageJson = codexRequire.resolve(`${native.packageName}/package.json`);
    const binary = join(dirname(packageJson), "vendor", native.targetTriple, "bin", "codex");
    return isExecutable(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function nativePackage() {
  return nativePackages[`${process.platform}:${process.arch}`];
}
