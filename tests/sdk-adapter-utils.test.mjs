// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundleValueFromMcpSource,
  bundleValueFromSource,
  optionalAiEnvBundleSecretValues,
  optionalMcpEnvBundleSecretValues,
  sanitizedChildEnv,
  sdkProfileEnv,
} from "../src/runner/sdk-adapter-utils.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("SDK profile environment bundle", () => {
  it("resolves selected profile env keys from GITVIBE_AI_ENV_JSON", () => {
    const env = sdkProfileEnv(
      {
        env: {
          ANTHROPIC_API_KEY: { from_bundle: "MINIMAX_API_KEY" },
          ANTHROPIC_BASE_URL: { from_bundle: "MINIMAX_BASE_URL" },
          ANTHROPIC_MODEL: "glm-5",
        },
      },
      "ai.profiles.claude_minimax",
      {
        CLAUDE_CODE_OAUTH_TOKEN: "old-claude-token",
        CODEX_API_KEY: "old-codex-key",
        GITVIBE_GITHUB_APP_TOKEN: "repo-token",
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
      ANTHROPIC_MODEL: "glm-5",
      PATH: "/bin",
    });
    expect(env.GITVIBE_AI_ENV_JSON).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GITVIBE_GITHUB_APP_TOKEN).toBeUndefined();
    expect(env.GITVIBE_AI_API_KEY).toBeUndefined();
    expect(env.GITVIBE_AI_BASE_URL).toBeUndefined();
    expect(env.UNUSED_KEY).toBeUndefined();
  });

  it("removes bundled and legacy secrets when a profile has no env mapping", () => {
    const env = sdkProfileEnv({ model: "gpt-5" }, "ai.profiles.no_env", {
      CLAUDE_CODE_OAUTH_TOKEN: "old-claude-token",
      CODEX_API_KEY: "old-codex-key",
      GITVIBE_AI_API_KEY: "old-ai-key",
      GITVIBE_AI_BASE_URL: "https://old-ai.test/v1",
      GITVIBE_AI_ENV_JSON: JSON.stringify({ UNUSED_KEY: "unused" }),
      PATH: "/bin",
    });

    expect(env.PATH).toBe("/bin");
    expect(env.GITVIBE_AI_ENV_JSON).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GITVIBE_AI_API_KEY).toBeUndefined();
    expect(env.GITVIBE_AI_BASE_URL).toBeUndefined();
  });

  it("strips generic secret-like variables from child environments", () => {
    expect(
      sanitizedChildEnv({
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
        GITVIBE_AI_ENV_JSON: JSON.stringify({ KEY: "value" }),
        GITVIBE_MCP_ENV_JSON: JSON.stringify({ MCP_KEY: "mcp-value" }),
        INPUT_TOKEN: "action-input-token",
        NORMAL_VALUE: "kept",
        PATH: "/bin",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        "npm_config_//registry.npmjs.org/:_authToken": "npm-token",
      }),
    ).toEqual({
      NORMAL_VALUE: "kept",
      PATH: "/bin",
    });
  });
});

describe("SDK profile environment bundle values", () => {
  it("resolves profile fields from the AI env bundle", () => {
    expect(
      bundleValueFromSource({ from_bundle: "CODEX_BASE_URL" }, "ai.profiles.codex.base_url", {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ CODEX_BASE_URL: "https://codex.example/v1" }),
      }),
    ).toBe("https://codex.example/v1");
    expect(bundleValueFromSource(undefined, "ai.profiles.codex.base_url", {})).toBeUndefined();
  });

  it("allows literal-only profile env without an AI env bundle", () => {
    const env = sdkProfileEnv(
      {
        env: {
          ANTHROPIC_MODEL: "glm-5",
          CLAUDE_CODE_SUBAGENT_MODEL: "glm-5",
        },
      },
      "ai.profiles.claude_code",
      { GITVIBE_AI_ENV_JSON: undefined, PATH: "/bin" },
    );

    expect(env).toMatchObject({
      ANTHROPIC_MODEL: "glm-5",
      CLAUDE_CODE_SUBAGENT_MODEL: "glm-5",
      PATH: "/bin",
    });
    expect(env.GITVIBE_AI_ENV_JSON).toBeUndefined();
  });

  it("resolves MCP env bundle sources from GITVIBE_MCP_ENV_JSON", () => {
    expect(
      bundleValueFromMcpSource(
        { from_bundle: "DENSE_MEM_TOKEN" },
        "ai.mcp.servers.dense.env.TOKEN",
        {
          GITVIBE_MCP_ENV_JSON: JSON.stringify({ DENSE_MEM_TOKEN: "dense-token" }),
        },
      ),
    ).toBe("dense-token");
    expect(
      bundleValueFromMcpSource(undefined, "ai.mcp.servers.dense.env.TOKEN", {}),
    ).toBeUndefined();
    expect(() =>
      bundleValueFromMcpSource(
        { from_bundle: "DENSE_MEM_TOKEN" },
        "ai.mcp.servers.dense.env.TOKEN",
        {},
      ),
    ).toThrow("GITVIBE_MCP_ENV_JSON is required by ai.mcp.servers.dense.env.TOKEN.");
    expect(() =>
      bundleValueFromMcpSource(
        { from_bundle: "DENSE_MEM_TOKEN" },
        "ai.mcp.servers.dense.env.TOKEN",
        {
          GITVIBE_MCP_ENV_JSON: JSON.stringify({ OTHER_TOKEN: "value" }),
        },
      ),
    ).toThrow(
      "GITVIBE_MCP_ENV_JSON key DENSE_MEM_TOKEN is required by ai.mcp.servers.dense.env.TOKEN.from_bundle.",
    );
  });
});

describe("SDK profile environment bundle validation", () => {
  it("rejects invalid bundle shapes and missing keys", () => {
    expect(() =>
      sdkProfileEnv(profileEnv("ANTHROPIC_API_KEY", "MINIMAX_API_KEY"), "ai.profiles.bad", {}),
    ).toThrow("GITVIBE_AI_ENV_JSON is required by ai.profiles.bad.env.");

    expect(() =>
      sdkProfileEnv(profileEnv("ANTHROPIC_API_KEY", "MINIMAX_API_KEY"), "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: "{",
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON must be valid JSON");

    expect(() =>
      sdkProfileEnv(profileEnv("ANTHROPIC_API_KEY", "MINIMAX_API_KEY"), "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: "[]",
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON must be a JSON object.");

    expect(() =>
      sdkProfileEnv(profileEnv("ANTHROPIC_API_KEY", "MINIMAX_API_KEY"), "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ MINIMAX_API_KEY: 123 }),
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON.MINIMAX_API_KEY must be a string.");

    expect(() =>
      sdkProfileEnv(profileEnv("ANTHROPIC_API_KEY", "MINIMAX_API_KEY"), "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ OTHER_KEY: "value" }),
      }),
    ).toThrow(
      "GITVIBE_AI_ENV_JSON key MINIMAX_API_KEY is required by ai.profiles.bad.env.ANTHROPIC_API_KEY.from_bundle.",
    );
  });

  it("rejects invalid profile env sources", () => {
    expect(() =>
      sdkProfileEnv({ env: [] }, "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ KEY: "value" }),
      }),
    ).toThrow("ai.profiles.bad.env must be an object.");

    expect(() =>
      sdkProfileEnv({ env: { TARGET: {} } }, "ai.profiles.bad", {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ KEY: "value" }),
      }),
    ).toThrow("ai.profiles.bad.env.TARGET.from_bundle must be a non-empty string.");

    expect(() =>
      sdkProfileEnv({ env: { TARGET: [] } }, "ai.profiles.bad", {
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
    expect(
      optionalMcpEnvBundleSecretValues({
        GITVIBE_MCP_ENV_JSON: JSON.stringify({ DENSE_TOKEN: "dense-secret", OTHER: 12 }),
      }),
    ).toEqual(["dense-secret"]);
    expect(optionalMcpEnvBundleSecretValues({ GITVIBE_MCP_ENV_JSON: "[]" })).toEqual([]);
  });
});

function profileEnv(target, bundleKey) {
  return { env: { [target]: { from_bundle: bundleKey } } };
}
