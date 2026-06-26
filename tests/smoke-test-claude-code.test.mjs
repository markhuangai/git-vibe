// @ts-nocheck
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isDirectRun,
  main,
  readClaudeSmokeConfig,
  runClaudeCodeSmokeTest,
} from "../scripts/smoke-test-claude-code.mjs";

describe("Claude Code SDK smoke test", () => {
  it("loads bundle and literal env values from the configured profile", () => {
    const cwd = writeConfig(`
ai:
  profiles:
    claude_code:
      enabled: true
      adapter: claude-code-sdk
      env:
        ANTHROPIC_API_KEY:
          from_bundle: GITVIBE_AI_API_KEY
        ANTHROPIC_BASE_URL:
          from_bundle: ANTHROPIC_BASE_URL
        ANTHROPIC_MODEL: glm-5
        CLAUDE_CODE_SUBAGENT_MODEL: glm-5
      model: opus
      reasoning:
        effort: max
`);

    const config = readClaudeSmokeConfig({
      cwd,
      env: {
        GITVIBE_AI_ENV_JSON: JSON.stringify({
          ANTHROPIC_BASE_URL: "https://proxy.test/anthropic",
          GITVIBE_AI_API_KEY: "api-key",
        }),
        HOME: "/home/runner",
        PATH: "/usr/bin",
      },
    });

    expect(config).toMatchObject({
      effort: "max",
      model: "opus",
      profileName: "claude_code",
    });
    expect(config.env).toMatchObject({
      ANTHROPIC_API_KEY: "api-key",
      ANTHROPIC_BASE_URL: "https://proxy.test/anthropic",
      ANTHROPIC_MODEL: "glm-5",
      CLAUDE_CODE_SUBAGENT_MODEL: "glm-5",
    });
    expect(config.env.PATH).toBe("/home/runner/.local/bin:/usr/bin");
    expect(config.env.GITVIBE_AI_ENV_JSON).toBeUndefined();
  });
});

describe("Claude Code SDK smoke execution", () => {
  it("runs through the SDK with model, effort, schema, and bypass settings", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    alternate:
      enabled: true
      adapter: claude-code-sdk
      env:
        ANTHROPIC_MODEL: glm-5
        CLAUDE_CONFIG_DIR: /tmp/profile-claude-config
        HOME: /tmp/profile-home
      model: opus
      reasoning:
        effort: max
`);
    const query = vi.fn((params) => claudeResult(params));

    const report = await runClaudeCodeSmokeTest({
      cwd,
      dependencies: { query },
      env: {
        CLAUDE_CONFIG_DIR: "/home/runner/.claude",
        GITVIBE_AI_SMOKE_CLAUDE_PROFILE: "alternate",
        HOME: "/home/runner",
        PATH: "/usr/bin",
      },
    });

    expect(report).toEqual({ model: "opus", profileName: "alternate" });
    const queryOptions = query.mock.calls[0][0].options;
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          allowDangerouslySkipPermissions: true,
          effort: "max",
          model: "opus",
          outputFormat: expect.objectContaining({ type: "json_schema" }),
          permissionMode: "bypassPermissions",
          persistSession: false,
        }),
      }),
    );
    expect(queryOptions.env).toMatchObject({
      CLAUDE_CONFIG_DIR: "/home/runner/.claude",
      HOME: "/home/runner",
    });
    expect(queryOptions).not.toHaveProperty("settingSources");
  });
});

describe("Claude Code SDK smoke profile selection", () => {
  it("prefers the claude_code profile and allows profiles without env mappings", () => {
    const cwd = writeConfig(`
ai:
  profiles:
    alternate:
      adapter: claude-code-sdk
      model: alternate
    claude_code:
      adapter: claude-code-sdk
      model: opus
`);

    const config = readClaudeSmokeConfig({ cwd, env: {} });

    expect(config).toMatchObject({
      effort: undefined,
      model: "opus",
      profileName: "claude_code",
    });
    expect(config.env.PATH).toContain(".local/bin");
    expect(config.secrets).toEqual([]);
  });

  it("selects requested profiles and accepts string JSON result fallbacks", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    claude_code:
      enabled: false
      adapter: claude-code-sdk
      model: disabled
    alternate:
      adapter: claude-code-sdk
      env:
        ANTHROPIC_MODEL: glm-5
      model: opus
`);
    const query = vi.fn(() =>
      claudeResult({
        prefixMessages: [{ subtype: "init", type: "system" }],
        result: '```json\n{"ok": true, "source": "claude-code"}\n```',
        structuredOutput: undefined,
      }),
    );

    const report = await runClaudeCodeSmokeTest({
      cwd,
      dependencies: { query },
      env: {
        GITVIBE_AI_SMOKE_CLAUDE_PROFILE: "alternate",
        HOME: "/home/runner",
        PATH: "/usr/bin",
      },
    });

    expect(report).toEqual({ model: "opus", profileName: "alternate" });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({ ANTHROPIC_MODEL: "glm-5" }),
        }),
      }),
    );
  });
});

describe("Claude Code SDK smoke main", () => {
  it("returns zero from main on successful smoke runs", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    claude_code:
      adapter: claude-code-sdk
      model: opus
`);
    const logger = { error: vi.fn(), log: vi.fn() };

    await expect(
      main({
        cwd,
        dependencies: { query: vi.fn(() => claudeResult()) },
        env: {},
        logger,
      }),
    ).resolves.toBe(0);
    expect(logger.log).toHaveBeenCalledWith(
      "[git-vibe] claude-code-sdk smoke passed with profile=claude_code model=opus",
    );
  });
});

describe("Claude Code SDK smoke failure handling", () => {
  it("reports SDK errors without leaking bundled secrets", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    claude_code:
      enabled: true
      adapter: claude-code-sdk
      env:
        ANTHROPIC_API_KEY:
          from_bundle: GITVIBE_AI_API_KEY
      model: opus
`);
    const query = vi.fn(() => claudeResult({ error: "auth failed for secret-api-key" }));

    await expect(
      runClaudeCodeSmokeTest({
        cwd,
        dependencies: { query },
        env: { GITVIBE_AI_ENV_JSON: JSON.stringify({ GITVIBE_AI_API_KEY: "secret-api-key" }) },
      }),
    ).rejects.toThrow("auth failed for ***");
  });

  it("returns nonzero from main on config errors", async () => {
    const logger = { error: vi.fn(), log: vi.fn() };

    await expect(
      main({ cwd: mkdtempSync(join(tmpdir(), "git-vibe-claude-smoke-")), logger }),
    ).resolves.toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(".github/git-vibe.yml is required"),
    );
  });
});

describe("Claude Code SDK smoke config failures", () => {
  it("rejects invalid config, bundle, env, and reasoning shapes", () => {
    expect(() => readClaudeSmokeConfig({ cwd: writeConfig("[]"), env: {} })).toThrow(
      ".github/git-vibe.yml must contain a YAML object.",
    );
  });
});

describe("Claude Code SDK smoke env failures", () => {
  it("rejects invalid env mappings and bundle values", () => {
    expect(() =>
      readClaudeSmokeConfig({
        cwd: writeConfig("ai:\n  profiles: []\n"),
        env: {},
      }),
    ).toThrow("ai.profiles must be an object.");
    expect(() =>
      readClaudeSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      model: gpt-5-test
`),
        env: {},
      }),
    ).toThrow("does not define an enabled claude-code-sdk profile");
    expect(() =>
      readClaudeSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    alternate:
      enabled: false
      adapter: claude-code-sdk
      model: opus
`),
        env: { GITVIBE_AI_SMOKE_CLAUDE_PROFILE: "alternate" },
      }),
    ).toThrow("AI profile alternate must be an enabled claude-code-sdk profile.");
    expect(() =>
      readClaudeSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    claude_code:
      adapter: claude-code-sdk
      model: opus
      reasoning:
        effort: turbo
`),
        env: {},
      }),
    ).toThrow("reasoning.effort is not supported by claude-code-sdk: turbo");
    expect(() =>
      readClaudeSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    claude_code:
      adapter: claude-code-sdk
      env:
        "": value
      model: opus
`),
        env: {},
      }),
    ).toThrow("env keys must be non-empty strings");
    expect(() =>
      readClaudeSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    claude_code:
      adapter: claude-code-sdk
      env:
        ANTHROPIC_API_KEY:
          from_bundle: MISSING
      model: opus
`),
        env: { GITVIBE_AI_ENV_JSON: "{}" },
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON.MISSING is required");
    expect(() =>
      readClaudeSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    claude_code:
      adapter: claude-code-sdk
      env:
        ANTHROPIC_API_KEY:
          from_bundle: GITVIBE_AI_API_KEY
      model: opus
`),
        env: { GITVIBE_AI_ENV_JSON: JSON.stringify({ GITVIBE_AI_API_KEY: 12 }) },
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON.GITVIBE_AI_API_KEY must be a string.");
  });
});

describe("Claude Code SDK smoke response failures", () => {
  it("rejects missing, unexpected, and non-JSON SDK responses with redaction", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    claude_code:
      adapter: claude-code-sdk
      env:
        ANTHROPIC_API_KEY:
          from_bundle: GITVIBE_AI_API_KEY
      model: opus
`);

    await expect(
      runClaudeCodeSmokeTest({
        cwd,
        dependencies: { query: vi.fn(() => claudeResult({ omitResult: true })) },
        env: { GITVIBE_AI_ENV_JSON: JSON.stringify({ GITVIBE_AI_API_KEY: "secret-api-key" }) },
      }),
    ).rejects.toThrow("Claude Code SDK smoke did not return a result message.");

    await expect(
      runClaudeCodeSmokeTest({
        cwd,
        dependencies: {
          query: vi.fn(() =>
            claudeResult({
              structuredOutput: { ok: false, source: "secret-api-key" },
            }),
          ),
        },
        env: { GITVIBE_AI_ENV_JSON: JSON.stringify({ GITVIBE_AI_API_KEY: "secret-api-key" }) },
      }),
    ).rejects.toThrow('unexpected Claude Code SDK smoke response: {"ok":false,"source":"***"}');

    await expect(
      runClaudeCodeSmokeTest({
        cwd,
        dependencies: {
          query: vi.fn(() =>
            claudeResult({
              result: "secret-api-key without json",
              structuredOutput: null,
            }),
          ),
        },
        env: { GITVIBE_AI_ENV_JSON: JSON.stringify({ GITVIBE_AI_API_KEY: "secret-api-key" }) },
      }),
    ).rejects.toThrow("Claude Code SDK result did not contain JSON: *** without json");
  });

  it("detects direct script execution", () => {
    expect(
      isDirectRun("file:///tmp/smoke-test-claude-code.mjs", "/tmp/smoke-test-claude-code.mjs"),
    ).toBe(true);
    expect(isDirectRun("file:///tmp/other.mjs", "/tmp/smoke-test-claude-code.mjs")).toBe(false);
    expect(isDirectRun("file:///tmp/smoke-test-claude-code.mjs", undefined)).toBe(false);
  });
});

async function* claudeResult({
  error,
  omitResult = false,
  prefixMessages = [],
  result = JSON.stringify({ ok: true, source: "claude-code" }),
  structuredOutput = { ok: true, source: "claude-code" },
} = {}) {
  for (const message of prefixMessages) yield message;
  if (omitResult) return;
  if (error) {
    yield {
      errors: [error],
      subtype: "error_during_execution",
      type: "result",
    };
    return;
  }
  yield {
    result,
    structured_output: structuredOutput,
    subtype: "success",
    type: "result",
  };
}

function writeConfig(content) {
  const cwd = mkdtempSync(join(tmpdir(), "git-vibe-claude-smoke-"));
  mkdirSync(join(cwd, ".github"), { recursive: true });
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), content);
  return cwd;
}
