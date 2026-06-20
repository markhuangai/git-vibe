// @ts-nocheck
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isDirectRun,
  main,
  readCodexSmokeConfig,
  runCodexSmokeTest,
} from "../scripts/smoke-test-codex.mjs";

describe("Codex SDK smoke test", () => {
  it("loads auth_json from the bundle and writes CODEX_HOME auth.json", () => {
    const cwd = writeConfig(`
ai:
  profiles:
    codex:
      enabled: true
      adapter: codex-sdk
      auth_json:
        from_bundle: CODEX_AUTH_JSON
      model: gpt-5-test
      reasoning:
        effort: xhigh
`);

    const config = readCodexSmokeConfig({
      cwd,
      env: {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}' }),
      },
    });

    expect(config).toMatchObject({
      model: "gpt-5-test",
      profileName: "codex",
      reasoningEffort: "xhigh",
    });
    expect(existsSync(join(config.env.CODEX_HOME, "auth.json"))).toBe(true);
    expect(readFileSync(join(config.env.CODEX_HOME, "auth.json"), "utf8")).toBe(
      '{"auth_mode":"chatgpt"}',
    );
    expect(config.env.GITVIBE_AI_ENV_JSON).toBeUndefined();
  });
});

describe("Codex SDK smoke execution", () => {
  it("runs through the SDK with model, effort, schema, and bypass settings", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    codex:
      enabled: true
      adapter: codex-sdk
      auth_json:
        from_bundle: CODEX_AUTH_JSON
      model: gpt-5-test
      reasoning:
        effort: high
`);
    let codexHome;
    const run = vi.fn(async () => ({
      finalResponse: JSON.stringify({ ok: true, source: "codex" }),
    }));
    const startThread = vi.fn(() => ({ run }));
    const Codex = vi.fn(function Codex(options) {
      codexHome = options.env.CODEX_HOME;
      expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toBe('{"auth_mode":"chatgpt"}');
      return { startThread };
    });

    const report = await runCodexSmokeTest({
      cwd,
      dependencies: { Codex },
      env: {
        CODEX_HOME: "/runner/codex-home",
        GITVIBE_AI_ENV_JSON: JSON.stringify({ CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}' }),
      },
    });

    expect(report).toEqual({ model: "gpt-5-test", profileName: "codex" });
    expect(codexHome).toContain("git-vibe-codex-smoke-");
    expect(codexHome).not.toBe("/runner/codex-home");
    expect(existsSync(codexHome)).toBe(false);
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "never",
        model: "gpt-5-test",
        modelReasoningEffort: "high",
        sandboxMode: "danger-full-access",
        workingDirectory: cwd,
      }),
    );
    expect(run).toHaveBeenCalledWith(expect.any(String), {
      outputSchema: expect.objectContaining({ required: ["ok", "source"] }),
    });
  });

  it("selects requested profiles, maps literal env, and accepts fenced JSON responses", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    disabled:
      enabled: false
      adapter: codex-sdk
      model: disabled
    alternate:
      enabled: true
      adapter: codex-sdk
      env:
        CODEX_BASE_URL: https://codex.example
      model: gpt-5-alt
`);
    const Codex = codexDependency('```json\n{"ok": true, "source": "codex"}\n```');

    const report = await runCodexSmokeTest({
      cwd,
      dependencies: { Codex },
      env: { GITVIBE_AI_SMOKE_CODEX_PROFILE: "alternate", PATH: "/usr/bin" },
    });

    expect(report).toEqual({ model: "gpt-5-alt", profileName: "alternate" });
    expect(Codex).toHaveBeenCalledWith({
      env: expect.objectContaining({
        CODEX_BASE_URL: "https://codex.example",
        PATH: "/usr/bin",
      }),
    });
  });
});

describe("Codex SDK smoke main", () => {
  it("returns zero from main on successful smoke runs", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      model: gpt-5-test
`);
    const logger = { error: vi.fn(), log: vi.fn() };

    await expect(
      main({
        cwd,
        dependencies: { Codex: codexDependency('{"ok": true, "source": "codex"}') },
        env: {},
        logger,
      }),
    ).resolves.toBe(0);
    expect(logger.log).toHaveBeenCalledWith(
      "[git-vibe] codex-sdk smoke passed with profile=codex model=gpt-5-test",
    );
  });
});

describe("Codex SDK smoke failure handling", () => {
  it("returns nonzero from main on config errors", async () => {
    const logger = { error: vi.fn(), log: vi.fn() };

    await expect(
      main({ cwd: mkdtempSync(join(tmpdir(), "git-vibe-codex-smoke-")), logger }),
    ).resolves.toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(".github/git-vibe.yml is required"),
    );
  });
});

describe("Codex SDK smoke config failures", () => {
  it("rejects invalid config, bundle, env, and reasoning shapes", () => {
    expect(() => readCodexSmokeConfig({ cwd: writeConfig("[]"), env: {} })).toThrow(
      ".github/git-vibe.yml must contain a YAML object.",
    );
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig("ai:\n  profiles: []\n"),
        env: {},
      }),
    ).toThrow("ai.profiles must be an object.");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    other:
      adapter: claude-code-sdk
      model: opus
`),
        env: {},
      }),
    ).toThrow("does not define an enabled codex-sdk profile");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      enabled: false
      adapter: codex-sdk
      model: gpt-5-test
`),
        env: { GITVIBE_AI_SMOKE_CODEX_PROFILE: "codex" },
      }),
    ).toThrow("AI profile codex must be an enabled codex-sdk profile.");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
`),
        env: {},
      }),
    ).toThrow("AI profile codex model must be configured.");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      model: gpt-5-test
      reasoning:
        effort: max
`),
        env: {},
      }),
    ).toThrow("reasoning.effort is not supported by codex-sdk: max");
  });
});

describe("Codex SDK smoke env failures", () => {
  it("rejects invalid env mappings and bundle values", () => {
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      env:
        "": value
      model: gpt-5-test
`),
        env: {},
      }),
    ).toThrow("env keys must be non-empty strings");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      env:
        CODEX_API_KEY:
          from_bundle: MISSING
      model: gpt-5-test
`),
        env: { GITVIBE_AI_ENV_JSON: "{}" },
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON.MISSING is required");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      auth_json:
        from_bundle: CODEX_AUTH_JSON
      model: gpt-5-test
`),
        env: { GITVIBE_AI_ENV_JSON: JSON.stringify({ CODEX_AUTH_JSON: 12 }) },
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON.CODEX_AUTH_JSON must be a string.");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      auth_json:
        from_bundle: CODEX_AUTH_JSON
      model: gpt-5-test
`),
        env: { GITVIBE_AI_ENV_JSON: JSON.stringify({ CODEX_AUTH_JSON: "   " }) },
      }),
    ).toThrow("ai.profiles.codex.auth_json must resolve to a non-empty string.");
  });
});

describe("Codex SDK smoke response failures", () => {
  it("rejects unexpected or non-JSON SDK responses with redaction", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      env:
        CODEX_API_KEY:
          from_bundle: CODEX_API_KEY
      model: gpt-5-test
`);

    await expect(
      runCodexSmokeTest({
        cwd,
        dependencies: { Codex: codexDependency('{"ok": false, "source": "secret-codex"}') },
        env: { GITVIBE_AI_ENV_JSON: JSON.stringify({ CODEX_API_KEY: "secret-codex" }) },
      }),
    ).rejects.toThrow('unexpected Codex SDK smoke response: {"ok":false,"source":"***"}');

    await expect(
      runCodexSmokeTest({
        cwd,
        dependencies: { Codex: codexDependency("secret-codex without json") },
        env: { GITVIBE_AI_ENV_JSON: JSON.stringify({ CODEX_API_KEY: "secret-codex" }) },
      }),
    ).rejects.toThrow("Codex SDK result did not contain JSON: *** without json");
  });

  it("detects direct script execution", () => {
    expect(isDirectRun("file:///tmp/smoke-test-codex.mjs", "/tmp/smoke-test-codex.mjs")).toBe(true);
    expect(isDirectRun("file:///tmp/other.mjs", "/tmp/smoke-test-codex.mjs")).toBe(false);
    expect(isDirectRun("file:///tmp/smoke-test-codex.mjs", undefined)).toBe(false);
  });
});

function writeConfig(content) {
  const cwd = mkdtempSync(join(tmpdir(), "git-vibe-codex-smoke-"));
  mkdirSync(join(cwd, ".github"), { recursive: true });
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), content);
  return cwd;
}

function codexDependency(finalResponse) {
  return vi.fn(function Codex() {
    return {
      startThread: vi.fn(() => ({
        run: vi.fn(async () => ({ finalResponse })),
      })),
    };
  });
}
