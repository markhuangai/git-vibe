import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
          validate: {
            profile: "codex_cli",
          },
          "review-matrix": {
            profile: "codex_cli",
          },
        },
      },
    };

    expect(cliAdaptersForStage(config, "validate")).toEqual(["cli-codex"]);
    expect(cliAdaptersForStage(config, "investigate")).toEqual(["cli-codex"]);
    expect(cliAdaptersForStage(config, "review-matrix")).toEqual(["cli-codex"]);
    expect(cliAdaptersForStage(config, "review-matrix", "claude_code")).toEqual([
      "cli-claude-code",
    ]);
  });

  it("selects a CLI adapter from a role-group member index", () => {
    const cwd = configuredRoleGroupWorkspace();
    const env = runtimeEnv(cwd);
    /** @type {CommandCall[]} */
    const calls = [];

    const code = setupAiCli({
      argv: ["validate"],
      env: { ...env, GITVIBE_EXECUTION_MODE: "member", GITVIBE_MEMBER_INDEX: "1" },
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
    expect(
      cliAdaptersForStage(configWithRoleGroupProfiles(), "validate", {
        cwd,
        memberIndex: 0,
      }),
    ).toEqual(["cli-codex"]);
    expect(
      cliAdaptersForStage(configWithRoleGroupProfiles(), "validate", {
        cwd,
        executionMode: "finalizer",
      }),
    ).toEqual([]);
  });
});

describe("GitVibe AI CLI setup Codex installer", () => {
  it("uses an existing Codex CLI without installing a package", () => {
    const cwd = configuredWorkspace(codexConfig());
    const env = runtimeEnv(cwd);
    /** @type {CommandCall[]} */
    const calls = [];

    const code = setupAiCli({
      argv: ["validate"],
      env,
      execFileSync: execMock(calls, []),
      log: () => undefined,
    });

    expect(code).toBe(0);
    expectCommand(calls, "/mock/bin/codex", ["--version"]);
    expect(readFileSync(env.GITHUB_PATH, "utf8")).toContain("/mock/bin");
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
    const globalBinDir = join(env.RUNNER_TEMP, "git-vibe-cli", "git-vibe-pnpm-global", "bin");
    const installCall = calls.find(
      (call) =>
        call.command === "corepack" &&
        JSON.stringify(call.args) === JSON.stringify(["pnpm", "add", "--global", "@openai/codex"]),
    );

    expectCommand(calls, "corepack", ["pnpm", "add", "--global", "@openai/codex"]);
    expect(installCall?.env?.PNPM_HOME).toBe(
      join(env.RUNNER_TEMP, "git-vibe-cli", "git-vibe-pnpm-global"),
    );
    expect(installCall?.env?.PATH?.split(delimiter)[0]).toBe(globalBinDir);
    expectCommand(calls, "codex", ["--version"]);
    expect(readFileSync(env.GITHUB_PATH, "utf8")).toContain(globalBinDir);
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
    const env = runtimeEnv(cwd);
    /** @type {CommandCall[]} */
    const calls = [];

    const code = setupAiCli({
      argv: ["validate"],
      env,
      execFileSync: execMock(calls, []),
      log: () => undefined,
    });

    expect(code).toBe(0);
    expectCommand(calls, "/mock/bin/claude", ["--version"]);
    expect(readFileSync(env.GITHUB_PATH, "utf8")).toContain("/mock/bin");
    expectNoCommand(calls, "curl");
  });

  it("verifies an existing Claude Code command when shell resolution returns a command name", () => {
    const cwd = configuredWorkspace(claudeConfig());
    const env = runtimeEnv(cwd);
    /** @type {CommandCall[]} */
    const calls = [];

    const code = setupAiCli({
      argv: ["validate"],
      env,
      execFileSync: execMock(calls, [], { claude: "claude" }),
      log: () => undefined,
    });

    expect(code).toBe(0);
    expectCommand(calls, "claude", ["--version"]);
    expect(existsSync(env.GITHUB_PATH)).toBe(false);
    expectNoCommand(calls, "curl");
  });

  it("verifies an existing Claude Code path when GITHUB_PATH is unavailable", () => {
    const cwd = configuredWorkspace(claudeConfig());
    const env = { ...runtimeEnv(cwd), GITHUB_PATH: undefined };
    /** @type {CommandCall[]} */
    const calls = [];

    const code = setupAiCli({
      argv: ["validate"],
      env,
      execFileSync: execMock(calls, []),
      log: () => undefined,
    });

    expect(code).toBe(0);
    expectCommand(calls, "/mock/bin/claude", ["--version"]);
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
  profiles:
    local_proxy:
      adapter: ai-sdk-agentool
  stages:
    validate:
      profile: local_proxy
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

function configWithRoleGroupProfiles() {
  return {
    ai: {
      profiles: {
        claude_code: { adapter: "cli-claude-code" },
        codex_cli: { adapter: "cli-codex" },
        local_proxy: { adapter: "ai-sdk-agentool" },
      },
      role_groups: {
        review_gate: {
          roles: [
            { profile: "codex_cli", role: "security.md" },
            { profile: "claude_code", role: "maintainability.md" },
          ],
          synthesizer: "local_proxy",
        },
      },
      stages: {
        validate: { role_group: "review_gate" },
      },
    },
  };
}

function configuredRoleGroupWorkspace() {
  const cwd = configuredWorkspace(`
ai:
  profiles:
    claude_code:
      adapter: cli-claude-code
    codex_cli:
      adapter: cli-codex
    local_proxy:
      adapter: ai-sdk-agentool
  role_groups:
    review_gate:
      synthesizer: local_proxy
      roles:
        - role: security.md
          profile: codex_cli
        - role: maintainability.md
          profile: claude_code
  stages:
    validate:
      role_group: review_gate
`);
  mkdirSync(join(cwd, ".git-vibe", "role-group"), { recursive: true });
  writeFileSync(join(cwd, ".git-vibe", "role-group", "security.md"), "Check security.");
  writeFileSync(
    join(cwd, ".git-vibe", "role-group", "maintainability.md"),
    "Check maintainability.",
  );
  return cwd;
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
 * @param {Record<string, string>} [resolvedCommands]
 * @returns {(command: string, args?: readonly string[], options?: ExecOptions) => Buffer | string}
 */
function execMock(calls, missingCommands, resolvedCommands = {}) {
  return (command, args = [], options = {}) => {
    calls.push({ args: [...args], command, env: options.env, stdio: options.stdio });
    if (command === "bash" && args[0] === "-lc" && typeof args[1] === "string") {
      const commandName = args[1].replace("command -v ", "");
      if (missingCommands.includes(commandName)) throw new Error("missing command");
      if (resolvedCommands[commandName]) return `${resolvedCommands[commandName]}\n`;
      return Buffer.from(`/mock/bin/${commandName}\n`);
    }
    return Buffer.from("ok\n");
  };
}
