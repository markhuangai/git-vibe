// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  bundleValueFromSource,
  cliProfileEnv,
  optionalAiEnvBundleSecretValues,
} from "../src/runner/cli-adapter-utils.ts";

describe("CLI profile environment bundle", () => {
  it("resolves selected profile env keys from GITVIBE_AI_ENV_JSON", () => {
    const env = cliProfileEnv(
      {
        env: {
          ANTHROPIC_API_KEY: { from_bundle: "MINIMAX_API_KEY" },
          ANTHROPIC_BASE_URL: { from_bundle: "MINIMAX_BASE_URL" },
        },
      },
      "ai.profiles.claude_minimax",
      {
        CLAUDE_CODE_OAUTH_TOKEN: "old-claude-token",
        CODEX_AUTH_JSON: "old-codex-auth",
        GITVIBE_AI_API_KEY: "old-ai-key",
        GITVIBE_AI_BASE_URL: "https://old-ai.test/v1",
        GITVIBE_AI_ENV_JSON: JSON.stringify({
          MINIMAX_API_KEY: "minimax-key",
          MINIMAX_BASE_URL: "https://minimax.test/anthropic",
          UNUSED_KEY: "unused",
        }),
        PATH: "/bin",
      },
    );

    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: "minimax-key",
      ANTHROPIC_BASE_URL: "https://minimax.test/anthropic",
      PATH: "/bin",
    });
    expect(env.GITVIBE_AI_ENV_JSON).toBeUndefined();
    expect(env.CODEX_AUTH_JSON).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GITVIBE_AI_API_KEY).toBeUndefined();
    expect(env.GITVIBE_AI_BASE_URL).toBeUndefined();
    expect(env.UNUSED_KEY).toBeUndefined();
  });

  it("removes bundled and legacy secrets when a profile has no env mapping", () => {
    const env = cliProfileEnv({ model: "gpt-5" }, "ai.profiles.no_env", {
      CLAUDE_CODE_OAUTH_TOKEN: "old-claude-token",
      CODEX_AUTH_JSON: "old-codex-auth",
      GITVIBE_AI_API_KEY: "old-ai-key",
      GITVIBE_AI_BASE_URL: "https://old-ai.test/v1",
      GITVIBE_AI_ENV_JSON: JSON.stringify({ UNUSED_KEY: "unused" }),
      PATH: "/bin",
    });

    expect(env.PATH).toBe("/bin");
    expect(env.GITVIBE_AI_ENV_JSON).toBeUndefined();
    expect(env.CODEX_AUTH_JSON).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GITVIBE_AI_API_KEY).toBeUndefined();
    expect(env.GITVIBE_AI_BASE_URL).toBeUndefined();
  });

  it("resolves Codex auth JSON from the bundle", () => {
    expect(
      bundleValueFromSource({ from_bundle: "CODEX_AUTH_JSON" }, "ai.profiles.codex.auth_json", {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ CODEX_AUTH_JSON: '{"tokens":[]}' }),
      }),
    ).toBe('{"tokens":[]}');
    expect(bundleValueFromSource(undefined, "ai.profiles.codex.auth_json", {})).toBeUndefined();
  });
});

describe("CLI profile environment bundle validation", () => {
  it("rejects invalid bundle shapes and missing keys", () => {
    expect(() =>
      cliProfileEnv(profileEnv("ANTHROPIC_API_KEY", "MINIMAX_API_KEY"), "ai.profiles.bad", {}),
    ).toThrow("GITVIBE_AI_ENV_JSON is required by ai.profiles.bad.env.");

    expect(() =>
      cliProfileEnv(profileEnv("ANTHROPIC_API_KEY", "MINIMAX_API_KEY"), "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: "{",
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON must be valid JSON");

    expect(() =>
      cliProfileEnv(profileEnv("ANTHROPIC_API_KEY", "MINIMAX_API_KEY"), "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: "[]",
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON must be a JSON object.");

    expect(() =>
      cliProfileEnv(profileEnv("ANTHROPIC_API_KEY", "MINIMAX_API_KEY"), "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ MINIMAX_API_KEY: 123 }),
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON.MINIMAX_API_KEY must be a string.");

    expect(() =>
      cliProfileEnv(profileEnv("ANTHROPIC_API_KEY", "MINIMAX_API_KEY"), "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ OTHER_KEY: "value" }),
      }),
    ).toThrow(
      "GITVIBE_AI_ENV_JSON key MINIMAX_API_KEY is required by ai.profiles.bad.env.ANTHROPIC_API_KEY.from_bundle.",
    );
  });

  it("rejects invalid profile env sources", () => {
    expect(() =>
      cliProfileEnv({ env: [] }, "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ KEY: "value" }),
      }),
    ).toThrow("ai.profiles.bad.env must be an object.");

    expect(() =>
      cliProfileEnv({ env: { TARGET: {} } }, "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ KEY: "value" }),
      }),
    ).toThrow("ai.profiles.bad.env.TARGET.from_bundle must be a non-empty string.");

    expect(() =>
      cliProfileEnv({ env: { TARGET: [] } }, "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ KEY: "value" }),
      }),
    ).toThrow("ai.profiles.bad.env.TARGET must be an object with from_bundle.");
  });
});

describe("AI env bundle redaction helpers", () => {
  it("returns bundle values for validation redaction without throwing on invalid bundles", () => {
    expect(optionalAiEnvBundleSecretValues({})).toEqual([]);
    expect(optionalAiEnvBundleSecretValues({ GITVIBE_AI_ENV_JSON: "[]" })).toEqual([]);
    expect(
      optionalAiEnvBundleSecretValues({
        GITVIBE_AI_ENV_JSON: JSON.stringify({ A: "secret-a", B: 12, C: "secret-c" }),
      }),
    ).toEqual(["secret-a", "secret-c"]);
    expect(optionalAiEnvBundleSecretValues({ GITVIBE_AI_ENV_JSON: "{" })).toEqual([]);
  });
});

function profileEnv(target, bundleKey) {
  return { env: { [target]: { from_bundle: bundleKey } } };
}
