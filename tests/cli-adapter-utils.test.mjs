// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundleKeyFromSource,
  bundleValueFromMcpSource,
  bundleValueFromSource,
  cliProfileEnv,
  optionalAiEnvBundleSecretValues,
  optionalMcpEnvBundleSecretValues,
  runStreamingCommand,
  sanitizedChildEnv,
} from "../src/runner/cli-adapter-utils.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("CLI profile environment bundle", () => {
  it("resolves selected profile env keys from GITVIBE_AI_ENV_JSON", () => {
    const env = cliProfileEnv(
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
        CODEX_AUTH_JSON: "old-codex-auth",
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
    expect(env.CODEX_AUTH_JSON).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GITVIBE_GITHUB_APP_TOKEN).toBeUndefined();
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

describe("CLI profile environment bundle values", () => {
  it("resolves Codex auth JSON from the bundle", () => {
    expect(
      bundleValueFromSource({ from_bundle: "CODEX_AUTH_JSON" }, "ai.profiles.codex.auth_json", {
        GITVIBE_AI_ENV_JSON: JSON.stringify({ CODEX_AUTH_JSON: '{"tokens":[]}' }),
      }),
    ).toBe('{"tokens":[]}');
    expect(bundleValueFromSource(undefined, "ai.profiles.codex.auth_json", {})).toBeUndefined();
  });

  it("allows literal-only profile env without an AI env bundle", () => {
    const env = cliProfileEnv(
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

  it("resolves Codex auth bundle keys without reading the bundle", () => {
    expect(bundleKeyFromSource(undefined, "ai.profiles.codex.auth_json")).toBeUndefined();
    expect(
      bundleKeyFromSource({ from_bundle: "CODEX_AUTH_JSON" }, "ai.profiles.codex.auth_json"),
    ).toBe("CODEX_AUTH_JSON");
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

  it("rejects invalid Codex auth bundle key sources", () => {
    expect(() => bundleKeyFromSource([], "ai.profiles.codex.auth_json")).toThrow(
      "ai.profiles.codex.auth_json must be an object with from_bundle.",
    );
    expect(() => bundleKeyFromSource({}, "ai.profiles.codex.auth_json")).toThrow(
      "ai.profiles.codex.auth_json.from_bundle must be a non-empty string.",
    );
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

describe("CLI command logging", () => {
  it("redacts streamed child process output and failure messages", async () => {
    process.env.GITVIBE_TEST_SECRET = "super-secret-value";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runStreamingCommand({
        args: [
          "-e",
          "process.stdout.write('super-secret-value'); process.stderr.write('super-secret-value')",
        ],
        command: process.execPath,
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        input: "",
      }),
    ).resolves.toMatchObject({
      stderr: "super-secret-value",
      stdout: "super-secret-value",
    });

    expect(stdout).toHaveBeenCalledWith("<redacted:GITVIBE_TEST_SECRET>");
    expect(stderr).toHaveBeenCalledWith("<redacted:GITVIBE_TEST_SECRET>");

    let caught;
    try {
      await runStreamingCommand({
        args: ["-e", "process.stderr.write('super-secret-value'); process.exit(1)"],
        command: process.execPath,
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        input: "",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain("<redacted:GITVIBE_TEST_SECRET>");
    expect(caught.message).not.toContain("super-secret-value");
  });
});

function profileEnv(target, bundleKey) {
  return { env: { [target]: { from_bundle: bundleKey } } };
}
