import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  claudeArgs,
  main,
  readClaudeSmokeConfig,
  runClaudeCodeSmokeTest,
} from "../scripts/smoke-test-claude-code.mjs";

describe("Claude Code smoke test", () => {
  it("loads bundle and literal env values from the configured profile", () => {
    const cwd = writeConfig(`
ai:
  profiles:
    claude_code:
      enabled: true
      adapter: cli-claude-code
      env:
        ANTHROPIC_API_KEY:
          from_bundle: GITVIBE_AI_API_KEY
        ANTHROPIC_BASE_URL:
          from_bundle: GITVIBE_AI_BASE_URL
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
          GITVIBE_AI_API_KEY: "api-key",
          GITVIBE_AI_BASE_URL: "https://proxy.test/anthropic",
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

  it("runs Claude with model, effort, schema, and bypass settings", () => {
    const cwd = writeConfig(`
ai:
  profiles:
    alternate:
      enabled: true
      adapter: cli-claude-code
      bare: true
      env:
        ANTHROPIC_MODEL: glm-5
      model: opus
      reasoning:
        effort: max
`);
    const spawnSync = vi.fn(() => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        is_error: false,
        structured_output: { ok: true, source: "claude-code" },
      }),
    }));

    const report = runClaudeCodeSmokeTest({
      cwd,
      dependencies: { spawnSync },
      env: {
        GITVIBE_AI_SMOKE_CLAUDE_PROFILE: "alternate",
        HOME: "/home/runner",
        PATH: "/usr/bin",
      },
    });

    expect(report).toEqual({ model: "opus", profileName: "alternate" });
    expect(spawnSync).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining([
        "-p",
        "--bare",
        "--dangerously-skip-permissions",
        "--model",
        "opus",
        "--json-schema",
        "--effort",
        "max",
      ]),
      expect.objectContaining({
        encoding: "utf8",
        env: expect.objectContaining({ ANTHROPIC_MODEL: "glm-5" }),
      }),
    );
  });
});

describe("Claude Code smoke failure handling", () => {
  it("reports Claude JSON errors without leaking bundled secrets", () => {
    const cwd = writeConfig(`
ai:
  profiles:
    claude_code:
      enabled: true
      adapter: cli-claude-code
      env:
        ANTHROPIC_API_KEY:
          from_bundle: GITVIBE_AI_API_KEY
      model: opus
`);
    const spawnSync = vi.fn(() => ({
      status: 1,
      stderr: "",
      stdout: JSON.stringify({
        is_error: true,
        result: "auth failed for secret-api-key",
      }),
    }));

    expect(() =>
      runClaudeCodeSmokeTest({
        cwd,
        dependencies: { spawnSync },
        env: { GITVIBE_AI_ENV_JSON: JSON.stringify({ GITVIBE_AI_API_KEY: "secret-api-key" }) },
      }),
    ).toThrow("Claude Code smoke failed with exit code 1: auth failed for ***");
  });

  it("returns nonzero from main on config errors", () => {
    const logger = { error: vi.fn(), log: vi.fn() };

    expect(main({ cwd: mkdtempSync(join(tmpdir(), "git-vibe-claude-smoke-")), logger })).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(".github/git-vibe.yml is required"),
    );
  });
  it("omits optional mode and effort args when not configured", () => {
    expect(
      claudeArgs({ bare: false, env: {}, model: "sonnet", profileName: "p", secrets: [] }),
    ).toEqual(expect.not.arrayContaining(["--bare", "--effort"]));
  });
});

/**
 * @param {string} content
 * @returns {string}
 */
function writeConfig(content) {
  const cwd = mkdtempSync(join(tmpdir(), "git-vibe-claude-smoke-"));
  mkdirSync(join(cwd, ".github"), { recursive: true });
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), content);
  return cwd;
}
