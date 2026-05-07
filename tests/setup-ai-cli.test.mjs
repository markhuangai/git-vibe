import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cliAdaptersForStage,
  isDirectRun,
  setupAiCli,
} from "../src/runner/actions/setup-ai-cli.ts";

/**
 * @typedef {{ args: string[], command: string, env?: NodeJS.ProcessEnv, stdio?: string }} CommandCall
 * @typedef {{ env?: NodeJS.ProcessEnv, stdio?: "ignore" | "inherit" }} ExecOptions
 */

describe("GitVibe AI CLI setup", () => {
  it("selects CLI adapters from the same stage profile config as runtime routing", () => {
    const config = {
      ai: {
        profiles: {
          claude_code: { adapter: "cli-claude-code" },
          codex_cli: { adapter: "cli-codex" },
          local_proxy: { adapter: "ai-sdk-agentool" },
        },
        stages: {
          investigate: {
            fallback_profile: "codex_cli",
            profile: "local_proxy",
          },
          summarize: {
            enabled: false,
            profile: "codex_cli",
          },
          validate: {
            profile: "codex_cli",
          },
          "review-matrix": {
            profiles: ["codex_cli", "claude_code", "codex_cli"],
          },
        },
      },
    };

    expect(cliAdaptersForStage(config, "validate")).toEqual(["cli-codex"]);
    expect(cliAdaptersForStage(config, "investigate")).toEqual(["cli-codex"]);
    expect(cliAdaptersForStage(config, "review-matrix")).toEqual(["cli-codex", "cli-claude-code"]);
    expect(cliAdaptersForStage(config, "summarize")).toEqual([]);
  });
});

describe("GitVibe AI CLI setup Codex installer", () => {
  it("uses an existing Codex CLI without installing a package", () => {
    const cwd = configuredWorkspace(codexConfig());
    /** @type {CommandCall[]} */
    const calls = [];

    const code = setupAiCli({
      argv: ["validate"],
      env: runtimeEnv(cwd),
      execFileSync: execMock(calls, []),
      log: () => undefined,
    });

    expect(code).toBe(0);
    expectCommand(calls, "codex", ["--version"]);
    expectNoCommand(calls, "corepack");
    expectNoCommand(calls, "pnpm");
  });

  it("installs Codex CLI with pnpm when a selected stage uses cli-codex", () => {
    const cwd = configuredWorkspace(codexConfig());
    const env = runtimeEnv(cwd);
    /** @type {CommandCall[]} */
    const calls = [];

    const code = setupAiCli({
      argv: ["validate"],
      env,
      execFileSync: execMock(calls, ["codex"]),
      log: () => undefined,
    });

    expect(code).toBe(0);
    expectCommand(calls, "corepack", ["pnpm", "add", "--global", "@openai/codex"]);
    expectCommand(calls, "codex", ["--version"]);
    expect(readFileSync(env.GITHUB_PATH, "utf8")).toContain(
      join(env.RUNNER_TEMP, "git-vibe-cli", "git-vibe-pnpm-global"),
    );
  });

  it("uses installed pnpm when Corepack is unavailable", () => {
    const cwd = configuredWorkspace(codexConfig());
    /** @type {CommandCall[]} */
    const calls = [];

    const code = setupAiCli({
      argv: ["validate"],
      env: runtimeEnv(cwd),
      execFileSync: execMock(calls, ["codex", "corepack"]),
      log: () => undefined,
    });

    expect(code).toBe(0);
    expectCommand(calls, "pnpm", ["add", "--global", "@openai/codex"]);
  });

  it("reports an install error when no pnpm provider is available", () => {
    const cwd = configuredWorkspace(codexConfig());
    /** @type {CommandCall[]} */
    const calls = [];
    /** @type {string[]} */
    const errors = [];

    const code = setupAiCli({
      argv: ["validate"],
      env: runtimeEnv(cwd),
      error: (message) => errors.push(message),
      execFileSync: execMock(calls, ["codex", "corepack", "pnpm"]),
      log: () => undefined,
    });

    expect(code).toBe(1);
    expect(errors).toContain("GitVibe requires pnpm or Corepack to install configured AI CLIs.");
  });
});

describe("GitVibe AI CLI setup Claude Code installer", () => {
  it("uses an existing Claude Code CLI without running the installer", () => {
    const cwd = configuredWorkspace(claudeConfig());
    /** @type {CommandCall[]} */
    const calls = [];

    const code = setupAiCli({
      argv: ["validate"],
      env: runtimeEnv(cwd),
      execFileSync: execMock(calls, []),
      log: () => undefined,
    });

    expect(code).toBe(0);
    expectCommand(calls, "claude", ["--version"]);
    expectNoCommand(calls, "curl");
  });

  it("installs Claude Code when a selected stage uses cli-claude-code", () => {
    const cwd = configuredWorkspace(claudeConfig());
    const env = runtimeEnv(cwd);
    /** @type {CommandCall[]} */
    const calls = [];

    const code = setupAiCli({
      argv: ["validate"],
      env,
      execFileSync: execMock(calls, ["claude"]),
      log: () => undefined,
    });

    expect(code).toBe(0);
    expectCommand(calls, "curl", [
      "-fsSL",
      "https://claude.ai/install.sh",
      "-o",
      join(env.RUNNER_TEMP, "git-vibe-cli", "claude-code-install.sh"),
    ]);
    expectCommand(calls, "bash", [join(env.RUNNER_TEMP, "git-vibe-cli", "claude-code-install.sh")]);
    expectCommand(calls, "claude", ["--version"]);
    expect(readFileSync(env.GITHUB_PATH, "utf8")).toContain(join(env.HOME, ".local", "bin"));
  });
});

describe("GitVibe AI CLI setup no-op stages", () => {
  it("does not install a CLI for ai-sdk-agentool stages", () => {
    const cwd = configuredWorkspace(`
ai:
  default_profile: local_proxy
  profiles:
    local_proxy:
      adapter: ai-sdk-agentool
`);
    /** @type {CommandCall[]} */
    const calls = [];
    const code = setupAiCli({
      argv: ["validate"],
      env: runtimeEnv(cwd),
      execFileSync: execMock(calls, []),
      log: () => undefined,
    });

    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("GitVibe AI CLI setup direct execution", () => {
  it("detects direct setup-ai-cli entrypoints", () => {
    const path = "/tmp/setup-ai-cli.ts";

    expect(isDirectRun("", "/tmp/setup-ai-cli.js")).toBe(true);
    expect(isDirectRun("", "/tmp/run-action.js")).toBe(false);
    expect(isDirectRun(pathToFileURL(path).href, path)).toBe(true);
  });
});

/**
 * @param {CommandCall[]} calls
 * @param {string} command
 * @param {string[]} args
 */
function expectCommand(calls, command, args) {
  expect(
    calls.some(
      (call) => call.command === command && JSON.stringify(call.args) === JSON.stringify(args),
    ),
    `expected ${JSON.stringify(calls)} to contain ${command} ${args.join(" ")}`,
  ).toBe(true);
}

/**
 * @param {CommandCall[]} calls
 * @param {string} command
 */
function expectNoCommand(calls, command) {
  expect(
    calls.some((call) => call.command === command),
    `expected ${JSON.stringify(calls)} not to contain ${command}`,
  ).toBe(false);
}

function codexConfig() {
  return `
ai:
  profiles:
    codex_cli:
      adapter: cli-codex
  stages:
    validate:
      profile: codex_cli
`;
}

function claudeConfig() {
  return `
ai:
  profiles:
    claude_code:
      adapter: cli-claude-code
  stages:
    validate:
      profile: claude_code
`;
}

/**
 * @param {string} config
 * @returns {string}
 */
function configuredWorkspace(config) {
  const cwd = mkdtempSync(join(tmpdir(), "git-vibe-setup-cli-"));
  mkdirSync(join(cwd, ".github"), { recursive: true });
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), config);
  return cwd;
}

/**
 * @param {string} cwd
 * @returns {NodeJS.ProcessEnv & { GITHUB_PATH: string, GITHUB_WORKSPACE: string, HOME: string, RUNNER_TEMP: string }}
 */
function runtimeEnv(cwd) {
  const runnerTemp = mkdtempSync(join(tmpdir(), "git-vibe-runner-"));
  const home = mkdtempSync(join(tmpdir(), "git-vibe-home-"));
  return {
    GITHUB_PATH: join(runnerTemp, "github-path"),
    GITHUB_WORKSPACE: cwd,
    HOME: home,
    PATH: process.env.PATH || "",
    RUNNER_TEMP: runnerTemp,
  };
}

/**
 * @param {CommandCall[]} calls
 * @param {string[]} missingCommands
 * @returns {(command: string, args?: readonly string[], options?: ExecOptions) => Buffer}
 */
function execMock(calls, missingCommands) {
  return (command, args = [], options = {}) => {
    calls.push({ args: [...args], command, env: options.env, stdio: options.stdio });
    if (
      command === "bash" &&
      args[0] === "-lc" &&
      missingCommands.some((missing) => args[1] === `command -v ${missing}`)
    ) {
      throw new Error("missing command");
    }
    return Buffer.from("ok\n");
  };
}
