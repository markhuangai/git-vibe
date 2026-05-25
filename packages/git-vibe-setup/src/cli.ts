#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { fetchConsumerStarterFiles } from "./consumer-starter.js";
import { githubTokenFromEnvironment } from "./github-api.js";
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
import { latestReleaseTag } from "./releases.js";

interface SetupCliRuntime {
  argv?: string[];
  cwd?: string;
  error?: (message: string) => void;
  fetchImpl?: typeof fetch;
  githubToken?: string;
  includePrereleases?: boolean;
  log?: (message: string) => void;
  releaseTag?: string;
}

interface CliOptions {
  command: "setup" | "update";
  includePrereleases: boolean;
  releaseTag?: string;
}

const usage = `Usage:
  git-vibe-setup setup [--release <tag>] [--include-prereleases]
  git-vibe-setup update [--release <tag>] [--include-prereleases]
  git-vibe-setup

Commands:
  setup   Install GitVibe starter files into the current repository.
  update  Update GitVibe workflow wrapper files in the current repository.

Options:
  --release <tag>         Use a specific GitVibe release tag, including prereleases.
  --include-prereleases   Allow latest-release lookup to select prereleases.
  -h, --help              Show this help message.`;

export async function runSetup(runtime: SetupCliRuntime = {}): Promise<void> {
  const cwd = runtime.cwd || process.cwd();
  const fetchImpl = runtime.fetchImpl || fetch;
  const githubToken = runtime.githubToken || githubTokenFromEnvironment();
  const releaseTag = await resolveReleaseTag(runtime, fetchImpl, githubToken);
  const sourceFiles = await fetchConsumerStarterFiles({ fetchImpl, githubToken, releaseTag });
  const files = buildInstallFiles({ cwd, releaseTag, sourceFiles });
  const blockingPaths = blockingInstallPaths(files);

  if (blockingPaths.length > 0) throw existingFilesError(blockingPaths, cwd);

  installFiles(files);
  (runtime.log || console.log)(renderManualSetupInstructions(releaseTag));
}

export async function runUpdate(runtime: SetupCliRuntime = {}): Promise<void> {
  const cwd = runtime.cwd || process.cwd();
  const fetchImpl = runtime.fetchImpl || fetch;
  const githubToken = runtime.githubToken || githubTokenFromEnvironment();
  const releaseTag = await resolveReleaseTag(runtime, fetchImpl, githubToken);
  const sourceFiles = await fetchConsumerStarterFiles({ fetchImpl, githubToken, releaseTag });
  const files = buildWorkflowUpdateFiles({ cwd, releaseTag, sourceFiles });
  const unmanagedPaths = unmanagedWorkflowUpdatePaths(files);

  if (unmanagedPaths.length > 0) throw unmanagedWorkflowUpdateError(unmanagedPaths, cwd);

  updateFiles(files);
  (runtime.log || console.log)(
    `GitVibe workflow files updated with reusable workflows pinned to ${releaseTag}.`,
  );
}

export async function setupCli(runtime: SetupCliRuntime = {}): Promise<number> {
  const argv = runtime.argv || process.argv.slice(2);
  let parsed: ReturnType<typeof parseCliOptions>;

  try {
    parsed = parseCliOptions(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (runtime.error || console.error)(`${message}\n\n${usage}`);
    return 1;
  }

  if (parsed.kind === "help") {
    (runtime.log || console.log)(usage);
    return 0;
  }

  if (parsed.kind === "error") {
    (runtime.error || console.error)(`${parsed.message}\n\n${usage}`);
    return 1;
  }

  const commandRuntime = {
    ...runtime,
    includePrereleases: runtime.includePrereleases || parsed.options.includePrereleases,
    releaseTag: parsed.options.releaseTag || runtime.releaseTag,
  };

  try {
    if (parsed.options.command === "update") await runUpdate(commandRuntime);
    else await runSetup(commandRuntime);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (runtime.error || console.error)(message);
    return 1;
  }
}

async function resolveReleaseTag(
  runtime: SetupCliRuntime,
  fetchImpl: typeof fetch,
  githubToken: string | undefined,
): Promise<string> {
  if (runtime.releaseTag) return validateReleaseTag(runtime.releaseTag);
  const releaseTag = await latestReleaseTag({
    fetchImpl,
    githubToken,
    includePrereleases: runtime.includePrereleases,
  });
  return validateReleaseTag(releaseTag);
}

function parseCliOptions(
  argv: string[],
):
  | { kind: "command"; options: CliOptions }
  | { kind: "error"; message: string }
  | { kind: "help" } {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    return { kind: "help" };
  }

  const command = commandName(argv[0]);
  if (argv[0] && !command && !argv[0].startsWith("-")) {
    return { kind: "error", message: `Unknown command: ${argv[0]}` };
  }

  const options = parseOptionArgs(command ? argv.slice(1) : argv);
  if (options.kind !== "command") return options;

  return {
    kind: "command",
    options: {
      ...options.options,
      command: command || "setup",
    },
  };
}

function parseOptionArgs(
  args: string[],
): { kind: "command"; options: Omit<CliOptions, "command"> } | { kind: "error"; message: string } {
  const options: Omit<CliOptions, "command"> = { includePrereleases: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || "";
    if (arg === "--include-prereleases") {
      options.includePrereleases = true;
    } else if (arg === "--release") {
      index += 1;
      const releaseTag = args[index];
      if (!releaseTag || releaseTag.startsWith("-")) {
        return { kind: "error", message: "--release requires a release tag" };
      }
      options.releaseTag = validateReleaseTag(releaseTag);
    } else if (arg.startsWith("--release=")) {
      options.releaseTag = validateReleaseTag(arg.slice("--release=".length));
    } else {
      return { kind: "error", message: `Unknown option: ${arg}` };
    }
  }

  return { kind: "command", options };
}

function commandName(value: string | undefined): "setup" | "update" | undefined {
  if (value === "setup" || value === "update") return value;
  return undefined;
}

function validateReleaseTag(releaseTag: string): string {
  const trimmed = releaseTag.trim();
  if (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(trimmed)) {
    return trimmed;
  }

  throw new Error(
    `Invalid release tag: ${releaseTag}. Release tags must look like v3.0.4 or v3.0.4-rc.1.`,
  );
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
