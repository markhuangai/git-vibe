#!/usr/bin/env node

import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const executable = resolveClaudeCodeExecutable();
if (!executable) process.exit(1);

console.log(executable);

function resolveClaudeCodeExecutable() {
  const configured = process.env.GITVIBE_CLAUDE_CODE_PATH;
  if (configured) {
    if (!isExecutable(configured)) {
      throw new Error(`GITVIBE_CLAUDE_CODE_PATH is not executable: ${configured}`);
    }
    return configured;
  }

  const packageName = nativePackageName();
  if (!packageName) return undefined;

  try {
    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkRequire = createRequire(sdkEntry);
    const packageJson = sdkRequire.resolve(`${packageName}/package.json`);
    const binary = join(dirname(packageJson), "claude");
    if (!isExecutable(binary)) {
      throw new Error(`resolved Claude Code executable is not executable: ${binary}`);
    }
    return binary;
  } catch (error) {
    throw new Error(`Failed to resolve Claude Code executable from ${packageName}: ${error}`);
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

function nativePackageName() {
  const os = nativeOs();
  const arch = nativeArch();
  if (!os || !arch) return undefined;
  const libc = os === "linux" && isMuslLinux() ? "-musl" : "";
  return `@anthropic-ai/claude-agent-sdk-${os}-${arch}${libc}`;
}

function nativeOs() {
  if (process.platform === "darwin" || process.platform === "linux") return process.platform;
  return undefined;
}

function nativeArch() {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch;
  return undefined;
}

function isMuslLinux() {
  const report = /** @type {{ header?: { glibcVersionRuntime?: string } } | undefined} */ (
    process.report?.getReport?.()
  );
  return process.platform === "linux" && !report?.header?.glibcVersionRuntime;
}
