#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  blockingInstallPaths,
  buildInstallFiles,
  buildWorkflowUpdateFiles,
  existingFilesError,
  installFiles,
  unmanagedWorkflowUpdateError,
  unmanagedWorkflowUpdatePaths,
  updateFiles,
} from "./install.js";
import { renderManualSetupInstructions } from "./instructions.js";
import { latestStableReleaseTag } from "./releases.js";

interface SetupCliRuntime {
  argv?: string[];
  cwd?: string;
  error?: (message: string) => void;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  repositoryRoot?: string;
}

const usage = `Usage:
  git-vibe-setup setup
  git-vibe-setup update
  git-vibe-setup

Commands:
  setup   Install GitVibe starter files into the current repository.
  update  Update GitVibe workflow wrapper files in the current repository.

Options:
  -h, --help   Show this help message.`;

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

export async function runUpdate(runtime: SetupCliRuntime = {}): Promise<void> {
  const cwd = runtime.cwd || process.cwd();
  const repositoryRoot = runtime.repositoryRoot || packageRoot();
  const releaseTag = await latestStableReleaseTag(runtime.fetchImpl || fetch);
  const files = buildWorkflowUpdateFiles({ cwd, releaseTag, repositoryRoot });
  const unmanagedPaths = unmanagedWorkflowUpdatePaths(files);

  if (unmanagedPaths.length > 0) throw unmanagedWorkflowUpdateError(unmanagedPaths, cwd);

  updateFiles(files);
  (runtime.log || console.log)(
    `GitVibe workflow files updated with reusable workflows pinned to ${releaseTag}.`,
  );
}

export async function setupCli(runtime: SetupCliRuntime = {}): Promise<number> {
  const argv = runtime.argv || process.argv.slice(2);
  const command = argv[0] || "setup";

  if (command === "--help" || command === "-h" || command === "help") {
    (runtime.log || console.log)(usage);
    return 0;
  }

  if (command !== "setup" && command !== "update") {
    (runtime.error || console.error)(`Unknown command: ${command}\n\n${usage}`);
    return 1;
  }

  try {
    if (command === "update") await runUpdate(runtime);
    else await runSetup(runtime);
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

export function isDirectRun(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  if (!entrypoint) return false;
  return (
    pathToFileURL(realpathSync(resolve(entrypoint))).href ===
    pathToFileURL(modulePath(moduleUrl)).href
  );
}

function modulePath(moduleUrl: string): string {
  return realpathSync(fileURLToPath(moduleUrl));
}
