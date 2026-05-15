#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  blockingInstallPaths,
  buildInstallFiles,
  existingFilesError,
  installFiles,
} from "./install.js";
import { renderManualSetupInstructions } from "./instructions.js";
import { latestStableReleaseTag } from "./releases.js";

interface SetupCliRuntime {
  cwd?: string;
  error?: (message: string) => void;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  repositoryRoot?: string;
}

export async function runSetup(runtime: SetupCliRuntime = {}): Promise<void> {
  const cwd = runtime.cwd || process.cwd();
  const repositoryRoot = runtime.repositoryRoot || packageRoot();
  const releaseTag = await latestStableReleaseTag(runtime.fetchImpl || fetch);
  const files = buildInstallFiles({ cwd, releaseTag, repositoryRoot });
  const blockingPaths = blockingInstallPaths(files);

  if (blockingPaths.length > 0) throw existingFilesError(blockingPaths, cwd);

  installFiles(files);
  (runtime.log || console.log)(renderManualSetupInstructions(releaseTag));
}

export async function setupCli(runtime: SetupCliRuntime = {}): Promise<number> {
  try {
    await runSetup(runtime);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (runtime.error || console.error)(message);
    return 1;
  }
}

function packageRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

/* c8 ignore start */
if (isDirectRun(import.meta.url)) {
  const exitCode = await setupCli();
  process.exitCode = exitCode;
}
/* c8 ignore stop */

function isDirectRun(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  return Boolean(entrypoint && moduleUrl === pathToFileURL(resolve(entrypoint)).href);
}
