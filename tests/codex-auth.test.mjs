// @ts-nocheck
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCodexEnv, writeBackCodexAuth } from "../src/runner/codex-auth.ts";

const originalEnv = { ...process.env };
const tempDirs = [];

beforeEach(() => {
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      CODEX_AUTH_JSON: codexAuthJson("old"),
      GITVIBE_AI_API_KEY: "test-key",
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("Codex auth environment", () => {
  it("seeds auth.json from the AI env bundle and strips bundle secrets from the child env", () => {
    const prepared = prepare();

    expect(readFileSync(prepared.auth.authPath, "utf8")).toBe(codexAuthJson("old"));
    expect(prepared.env.CODEX_HOME).toContain("git-vibe-codex-test-");
    expect(prepared.env.GITVIBE_AI_ENV_JSON).toBeUndefined();
    expect(prepared.env.CODEX_AUTH_JSON).toBeUndefined();
  });

  it("does not configure Codex auth when the profile has no auth_json source", () => {
    const prepared = prepareCodexEnv({
      contextDir: tempDir(),
      profile: { model: "gpt-5.5" },
      profileName: "codex_sdk",
    });

    expect(prepared.auth).toBeUndefined();
    expect(prepared.env.CODEX_HOME).toBeUndefined();
  });
});

describe("Codex auth write-back", () => {
  it("updates the repository AI env bundle secret with refreshed auth JSON", async () => {
    const prepared = prepare();
    writeFileSync(prepared.auth.authPath, codexAuthJson("refreshed"));
    const client = await githubClientWithPublicKey();
    const logger = { event: vi.fn() };

    await writeBackCodexAuth({
      auth: prepared.auth,
      github: { client, repository: "example/repo", token: "token" },
      logger,
    });

    const requests = client.request.mock.calls.map(([request]) => request);
    expect(requests[0]).toMatchObject({
      method: "GET",
      path: "/repos/example/repo/actions/secrets/public-key",
    });
    expect(requests[1]).toMatchObject({
      body: expect.objectContaining({ key_id: "key-id" }),
      method: "PUT",
      path: "/repos/example/repo/actions/secrets/GITVIBE_AI_ENV_JSON",
    });
    expect(requests[1].body.encrypted_value).toEqual(expect.any(String));
    expect(JSON.parse(process.env.GITVIBE_AI_ENV_JSON)).toEqual({
      CODEX_AUTH_JSON: codexAuthJson("refreshed"),
      GITVIBE_AI_API_KEY: "test-key",
    });
    expect(logger.event).toHaveBeenCalledWith("codex.auth_json.validation.done", {
      auth_mode: "chatgpt",
      bundle_key: "CODEX_AUTH_JSON",
      has_access_token: true,
      has_id_token: true,
      has_refresh_token: true,
      has_tokens: true,
    });
    expect(logger.event).toHaveBeenCalledWith("codex.auth_json.writeback.done", {
      bundle_key: "CODEX_AUTH_JSON",
      secret: "GITVIBE_AI_ENV_JSON",
    });
    expect(eventIndex(logger, "codex.auth_json.validation.done")).toBeLessThan(
      eventIndex(logger, "codex.auth_json.writeback.done"),
    );
  });

  it("uses the hosted broker callback when provided", async () => {
    const prepared = prepare();
    writeFileSync(prepared.auth.authPath, codexAuthJson("refreshed"));
    const authWriteback = vi.fn();
    const client = { request: vi.fn() };

    await writeBackCodexAuth({
      auth: prepared.auth,
      github: {
        authWriteback,
        client,
        repository: "example/repo",
        token: "runner-token",
      },
    });

    expect(authWriteback).toHaveBeenCalledWith(
      JSON.stringify({
        CODEX_AUTH_JSON: codexAuthJson("refreshed"),
        GITVIBE_AI_API_KEY: "test-key",
      }),
    );
    expect(client.request).not.toHaveBeenCalled();
    expect(JSON.parse(process.env.GITVIBE_AI_ENV_JSON).CODEX_AUTH_JSON).toBe(
      codexAuthJson("refreshed"),
    );
  });
});

describe("Codex auth write-back edge cases", () => {
  it("skips GitHub writes when Codex leaves auth JSON unchanged", async () => {
    const prepared = prepare();
    const logger = { event: vi.fn() };

    await writeBackCodexAuth({ auth: prepared.auth, github: undefined, logger });

    expect(logger.event).toHaveBeenCalledWith("codex.auth_json.writeback.skip", {
      reason: "unchanged",
    });
  });

  it("fails changed auth write-back without a GitHub token that can update secrets", async () => {
    const prepared = prepare();
    writeFileSync(prepared.auth.authPath, codexAuthJson("refreshed"));

    await expect(writeBackCodexAuth({ auth: prepared.auth, github: undefined })).rejects.toThrow(
      "GitVibe GitHub App Secrets write permission is required",
    );
  });

  it("fails changed auth write-back when GitHub omits the Actions public key", async () => {
    const prepared = prepare();
    writeFileSync(prepared.auth.authPath, codexAuthJson("refreshed"));
    const client = { request: vi.fn(async () => ({})) };

    await expect(
      writeBackCodexAuth({
        auth: prepared.auth,
        github: { client, repository: "example/repo", token: "token" },
      }),
    ).rejects.toThrow("GitHub repository example/repo did not return an Actions public key.");
  });
});

const invalidCodexAuthCases = [
  ["malformed JSON", "{", "Codex auth.json must be valid JSON before write-back:"],
  [
    "missing auth mode",
    JSON.stringify({
      tokens: {
        id_token: validIdToken("refreshed"),
        refresh_token: "refresh-refreshed",
      },
    }),
    "Codex auth.json auth_mode is required.",
  ],
  [
    "non-object tokens",
    JSON.stringify({ auth_mode: "chatgpt", tokens: [] }),
    "Codex auth.json tokens must be a JSON object when present.",
  ],
  [
    "malformed ID token",
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "access-refreshed",
        id_token: "not-a-jwt",
        refresh_token: "refresh-refreshed",
      },
    }),
    "Codex auth.json tokens.id_token must be JWT-shaped.",
  ],
  [
    "missing token object",
    JSON.stringify({ auth_mode: "chatgpt" }),
    "Codex auth.json tokens are required for chatgpt auth.",
  ],
  [
    "missing ID token",
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        refresh_token: "refresh-refreshed",
      },
    }),
    "Codex auth.json tokens.id_token is required for chatgpt auth.",
  ],
  [
    "missing refresh token",
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "access-refreshed",
        id_token: validIdToken("refreshed"),
      },
    }),
    "Codex auth.json tokens.refresh_token is required for chatgpt auth.",
  ],
  [
    "non-string auth mode",
    JSON.stringify({ auth_mode: 12 }),
    "Codex auth.json auth_mode must be a string.",
  ],
  [
    "blank access token",
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: " ",
        id_token: validIdToken("refreshed"),
        refresh_token: "refresh-refreshed",
      },
    }),
    "Codex auth.json tokens.access_token must be non-empty.",
  ],
];

describe("Codex auth write-back validation", () => {
  it("allows non-ChatGPT Codex auth objects without token metadata", async () => {
    const prepared = prepare();
    const authJson = `${JSON.stringify({ OPENAI_API_KEY: "test-api-key", auth_mode: "api_key" })}\n`;
    writeFileSync(prepared.auth.authPath, authJson);
    const client = await githubClientWithPublicKey();
    const logger = { event: vi.fn() };

    await writeBackCodexAuth({
      auth: prepared.auth,
      github: { client, repository: "example/repo", token: "token" },
      logger,
    });

    expect(JSON.parse(process.env.GITVIBE_AI_ENV_JSON).CODEX_AUTH_JSON).toBe(authJson);
    expect(logger.event).toHaveBeenCalledWith("codex.auth_json.validation.done", {
      auth_mode: "api_key",
      bundle_key: "CODEX_AUTH_JSON",
      has_access_token: false,
      has_id_token: false,
      has_refresh_token: false,
      has_tokens: false,
    });
  });

  it.each(invalidCodexAuthCases)(
    "rejects %s before updating the AI env bundle secret",
    async (_name, authJson, message) => {
      await expectInvalidRefreshedAuth(authJson, message);
    },
  );

  it("skips invalid refreshed auth when write-back is best effort", async () => {
    const prepared = prepare();
    const originalBundle = process.env.GITVIBE_AI_ENV_JSON;
    writeFileSync(
      prepared.auth.authPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "access-refreshed",
          id_token: "header.refreshed.signature",
          refresh_token: "refresh-refreshed",
        },
      }),
    );
    const client = await githubClientWithPublicKey();
    const logger = { event: vi.fn() };

    await expect(
      writeBackCodexAuth({
        auth: prepared.auth,
        github: { client, repository: "example/repo", token: "token" },
        invalidAuth: "skip",
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(client.request).not.toHaveBeenCalled();
    expect(process.env.GITVIBE_AI_ENV_JSON).toBe(originalBundle);
    expect(logger.event).toHaveBeenCalledWith("codex.auth_json.validation.failed", {
      bundle_key: "CODEX_AUTH_JSON",
      reason: expect.stringContaining("Codex auth.json tokens.id_token must be JWT-shaped."),
    });
    expect(logger.event).toHaveBeenCalledWith("codex.auth_json.writeback.skip", {
      reason: "invalid-refreshed-auth",
    });
  });
});

function prepare() {
  return prepareCodexEnv({
    contextDir: tempDir(),
    profile: {
      auth_json: { from_bundle: "CODEX_AUTH_JSON" },
      model: "gpt-5.5",
    },
    profileName: "codex_sdk",
  });
}

function codexAuthJson(label) {
  return `${JSON.stringify({
    auth_mode: "chatgpt",
    last_refresh: "2026-05-09T11:57:42.136804048Z",
    tokens: {
      access_token: `access-${label}`,
      account_id: "05eae55c-50ed-4afe-9a8f-4a3127e7d5a3",
      id_token: validIdToken(label),
      refresh_token: `refresh-${label}`,
    },
  })}\n`;
}

function validIdToken(label) {
  return ["header", label, "signature"]
    .map((part) => Buffer.from(part).toString("base64url"))
    .join(".");
}

function eventIndex(logger, eventName) {
  return logger.event.mock.calls.findIndex(([name]) => name === eventName);
}

async function expectInvalidRefreshedAuth(authJson, message) {
  const prepared = prepare();
  const originalBundle = process.env.GITVIBE_AI_ENV_JSON;
  writeFileSync(prepared.auth.authPath, authJson);
  const client = await githubClientWithPublicKey();
  const logger = { event: vi.fn() };

  await expect(
    writeBackCodexAuth({
      auth: prepared.auth,
      github: { client, repository: "example/repo", token: "token" },
      logger,
    }),
  ).rejects.toThrow(message);

  expect(client.request).not.toHaveBeenCalled();
  expect(process.env.GITVIBE_AI_ENV_JSON).toBe(originalBundle);
  expect(logger.event).toHaveBeenCalledWith("codex.auth_json.validation.failed", {
    bundle_key: "CODEX_AUTH_JSON",
    reason: expect.stringContaining(message),
  });
}

async function githubClientWithPublicKey() {
  await sodium.ready;
  const keyPair = sodium.crypto_box_keypair();
  const publicKey = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL);
  return {
    request: vi.fn(async (request) => {
      if (request.method === "GET") return { key: publicKey, key_id: "key-id" };
      return {};
    }),
  };
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "git-vibe-codex-test-"));
  tempDirs.push(dir);
  return dir;
}
