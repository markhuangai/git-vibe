// @ts-nocheck
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexAuthOptions, prepareCodexEnv } from "../src/runner/codex-auth.ts";

const originalEnv = { ...process.env };
const tempDirs = [];

beforeEach(() => {
  process.env = {
    ...originalEnv,
    CODEX_HOME: "/ambient/codex-home",
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      CODEX_BASE_URL: "https://codex-proxy.example/v1",
      GITVIBE_AI_API_KEY: "test-key",
    }),
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("Codex proxy auth environment", () => {
  it("resolves proxy settings from the bundle and forces an isolated CODEX_HOME", () => {
    const codexHome = join(tempDir(), "codex-home");
    const prepared = prepareCodexEnv({
      codexHome,
      profile: {
        api_key: { from_bundle: "GITVIBE_AI_API_KEY" },
        base_url: { from_bundle: "CODEX_BASE_URL" },
        env: {
          CODEX_HOME: "/profile/codex-home",
          EXTRA_LITERAL: "literal",
        },
        model: "gpt-5.5",
      },
      profileName: "codex_sdk",
    });

    expect(prepared).toMatchObject({
      apiKey: "test-key",
      baseUrl: "https://codex-proxy.example/v1",
    });
    expect(prepared.env.CODEX_HOME).toBe(codexHome);
    expect(prepared.env.EXTRA_LITERAL).toBe("literal");
    expect(prepared.env.GITVIBE_AI_ENV_JSON).toBeUndefined();
    expect(prepared.env.CODEX_BASE_URL).toBeUndefined();
    expect(prepared.env.GITVIBE_AI_API_KEY).toBeUndefined();
    expect(existsSync(codexHome)).toBe(true);
  });

  it("passes proxy settings as Codex SDK auth options", () => {
    const prepared = prepare();

    expect(codexAuthOptions(prepared)).toEqual({
      apiKey: "test-key",
      baseUrl: "https://codex-proxy.example/v1",
    });
  });
});

describe("Codex proxy auth validation", () => {
  it("requires typed proxy fields on codex-sdk profiles", () => {
    expect(() =>
      prepareCodexEnv({
        codexHome: join(tempDir(), "codex-home"),
        profile: {
          auth_json: { from_bundle: "CODEX_AUTH_JSON" },
          model: "gpt-5.5",
        },
        profileName: "codex_sdk",
      }),
    ).toThrow("ai.profiles.codex_sdk.base_url is required for codex-sdk profiles.");

    expect(() =>
      prepareCodexEnv({
        codexHome: join(tempDir(), "codex-home"),
        profile: {
          base_url: { from_bundle: "CODEX_BASE_URL" },
          model: "gpt-5.5",
        },
        profileName: "codex_sdk",
      }),
    ).toThrow("ai.profiles.codex_sdk.api_key is required for codex-sdk profiles.");
  });

  it("rejects missing, empty, and malformed proxy bundle values", () => {
    expect(() =>
      prepare({
        env: { GITVIBE_AI_ENV_JSON: JSON.stringify({ GITVIBE_AI_API_KEY: "test-key" }) },
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON key CODEX_BASE_URL is required");

    expect(() =>
      prepare({
        env: {
          GITVIBE_AI_ENV_JSON: JSON.stringify({
            CODEX_BASE_URL: " ",
            GITVIBE_AI_API_KEY: "test-key",
          }),
        },
      }),
    ).toThrow("ai.profiles.codex_sdk.base_url.from_bundle resolved to an empty value.");

    expect(() =>
      prepare({
        env: {
          GITVIBE_AI_ENV_JSON: JSON.stringify({
            CODEX_BASE_URL: "ftp://codex-proxy.example",
            GITVIBE_AI_API_KEY: "test-key",
          }),
        },
      }),
    ).toThrow(
      "ai.profiles.codex_sdk.base_url.from_bundle must resolve to an absolute HTTP(S) URL.",
    );

    expect(() =>
      prepare({
        env: {
          GITVIBE_AI_ENV_JSON: JSON.stringify({
            CODEX_BASE_URL: "https://codex-proxy.example/v1",
            GITVIBE_AI_API_KEY: "",
          }),
        },
      }),
    ).toThrow("ai.profiles.codex_sdk.api_key.from_bundle resolved to an empty value.");
  });
});

function prepare({ env } = {}) {
  if (env) process.env = { ...originalEnv, ...env };
  return prepareCodexEnv({
    codexHome: join(tempDir(), "codex-home"),
    profile: {
      api_key: { from_bundle: "GITVIBE_AI_API_KEY" },
      base_url: { from_bundle: "CODEX_BASE_URL" },
      model: "gpt-5.5",
    },
    profileName: "codex_sdk",
  });
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "git-vibe-codex-test-"));
  tempDirs.push(dir);
  return dir;
}
