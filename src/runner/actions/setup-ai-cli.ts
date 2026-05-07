#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  activeProfileByName,
  adapterName,
  profileNamesForStage,
  stageConfigFor,
} from "../ai-config.js";
import { loadConfig } from "../config.js";
import { parseStage } from "../../shared/stages.js";
import type { GitVibeConfig, Stage } from "../../shared/types.js";

interface SetupAiCliRuntime {
  appendFile?: (path: string, content: string) => void;
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  error?: (message: string) => void;
  execFileSync?: ExecFileSyncLike;
  log?: (message: string) => void;
}

type ExecFileSyncLike = (
  command: string,
  args?: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; stdio?: "ignore" | "inherit" },
) => Buffer | string;

interface PackageManager {
  args: string[];
  command: string;
}

const cliAdapters = new Set(["cli-codex", "cli-claude-code"]);

export function setupAiCli(runtime: SetupAiCliRuntime = {}): number {
  const env = runtime.env || process.env;
  const argv = runtime.argv || process.argv.slice(2);
  const log = runtime.log || ((message) => console.log(`[git-vibe] ${message}`));
  const error = runtime.error || ((message) => console.error(`[git-vibe] ${message}`));

  try {
    const stage = parseStage(argv[0]);
    const config = loadConfig(env.GITHUB_WORKSPACE || runtime.cwd || process.cwd());
    const adapters = cliAdaptersForStage(config, stage);

    if (adapters.length === 0) {
      log(`${stage} does not require AI CLI setup.`);
      return 0;
    }

    for (const adapter of adapters) {
      if (adapter === "cli-codex") installCodex(runtime, env, log);
      if (adapter === "cli-claude-code") installClaudeCode(runtime, env, log);
    }

    return 0;
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    return 1;
  }
}

export function cliAdaptersForStage(config: GitVibeConfig, stage: Stage): string[] {
  const stageConfig = stageConfigFor(config, stage);
  if (stageConfig.enabled === false) return [];

  const adapters = profileNamesForStage(config, stage)
    .map((profileName) => adapterName(activeProfileByName(config, profileName)))
    .filter((adapter) => cliAdapters.has(adapter));

  return [...new Set(adapters)];
}

export function isDirectRun(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  const file = entrypoint ? basename(entrypoint) : "";
  if (!moduleUrl) return /^setup-ai-cli\.(?:c?js|ts)$/.test(file);
  return Boolean(entrypoint && moduleUrl === pathToFileURL(resolve(entrypoint)).href);
}

function installCodex(
  runtime: SetupAiCliRuntime,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): void {
  if (commandExists(runtime, "codex", env)) {
    log("Codex CLI already available.");
    verifyCommand(runtime, "codex", env);
    return;
  }

  const installDir = join(runnerTemp(env), "git-vibe-pnpm-global");
  mkdirSync(installDir, { recursive: true });
  const installEnv = prependPath({ ...env, PNPM_HOME: installDir }, installDir);
  const packageManager = pnpmCommand(runtime, installEnv);

  log("Installing Codex CLI from @openai/codex.");
  runCommand(
    runtime,
    packageManager.command,
    [...packageManager.args, "add", "--global", "@openai/codex"],
    installEnv,
  );
  addPath(runtime, installDir, env);
  verifyCommand(runtime, "codex", installEnv);
}

function installClaudeCode(
  runtime: SetupAiCliRuntime,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): void {
  if (commandExists(runtime, "claude", env)) {
    log("Claude Code CLI already available.");
    verifyCommand(runtime, "claude", env);
    return;
  }

  const installer = join(runnerTemp(env), "claude-code-install.sh");
  const binDir = join(home(env), ".local", "bin");

  log("Installing Claude Code CLI from Anthropic installer.");
  runCommand(runtime, "curl", ["-fsSL", "https://claude.ai/install.sh", "-o", installer], env);
  runCommand(runtime, "bash", [installer], env);
  addPath(runtime, binDir, env);
  verifyCommand(runtime, "claude", prependPath(env, binDir));
}

function pnpmCommand(runtime: SetupAiCliRuntime, env: NodeJS.ProcessEnv): PackageManager {
  if (commandExists(runtime, "corepack", env)) return { args: ["pnpm"], command: "corepack" };
  if (commandExists(runtime, "pnpm", env)) return { args: [], command: "pnpm" };
  throw new Error("GitVibe requires pnpm or Corepack to install configured AI CLIs.");
}

function commandExists(
  runtime: SetupAiCliRuntime,
  command: string,
  env: NodeJS.ProcessEnv,
): boolean {
  try {
    runCommand(runtime, "bash", ["-lc", `command -v ${command}`], env, "ignore");
    return true;
  } catch {
    return false;
  }
}

function verifyCommand(
  runtime: SetupAiCliRuntime,
  command: "claude" | "codex",
  env: NodeJS.ProcessEnv,
): void {
  runCommand(runtime, command, ["--version"], env);
}

function runCommand(
  runtime: SetupAiCliRuntime,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdio: "ignore" | "inherit" = "inherit",
): void {
  (runtime.execFileSync || execFileSync)(command, args, {
    env,
    stdio,
  });
}

function addPath(runtime: SetupAiCliRuntime, path: string, env: NodeJS.ProcessEnv): void {
  const appendFile = runtime.appendFile || appendFileSync;
  if (env.GITHUB_PATH) appendFile(env.GITHUB_PATH, `${path}\n`);
}

function prependPath(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  return { ...env, PATH: [path, env.PATH].filter(Boolean).join(delimiter) };
}

function runnerTemp(env: NodeJS.ProcessEnv): string {
  const base = env.RUNNER_TEMP || tmpdir();
  const path = join(base, "git-vibe-cli");
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir();
}

if (isDirectRun("", process.argv[1])) {
  process.exit(setupAiCli());
}
