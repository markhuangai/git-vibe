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
      CODEX_AUTH_JSON: '{"tokens":["old"]}\n',
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

    expect(readFileSync(prepared.auth.authPath, "utf8")).toBe('{"tokens":["old"]}\n');
    expect(prepared.env.CODEX_HOME).toContain("git-vibe-codex-test-");
    expect(prepared.env.GITVIBE_AI_ENV_JSON).toBeUndefined();
    expect(prepared.env.CODEX_AUTH_JSON).toBeUndefined();
  });

  it("does not configure Codex auth when the profile has no auth_json source", () => {
    const prepared = prepareCodexEnv({
      contextDir: tempDir(),
      profile: { model: "gpt-5.5" },
      profileName: "codex_cli",
    });

    expect(prepared.auth).toBeUndefined();
    expect(prepared.env.CODEX_HOME).toBeUndefined();
  });
});

describe("Codex auth write-back", () => {
  it("updates the repository AI env bundle secret with refreshed auth JSON", async () => {
    const prepared = prepare();
    writeFileSync(prepared.auth.authPath, '{"tokens":["refreshed"]}\n');
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
      CODEX_AUTH_JSON: '{"tokens":["refreshed"]}\n',
      GITVIBE_AI_API_KEY: "test-key",
    });
    expect(logger.event).toHaveBeenCalledWith("codex.auth_json.writeback.done", {
      bundle_key: "CODEX_AUTH_JSON",
      secret: "GITVIBE_AI_ENV_JSON",
    });
  });

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
    writeFileSync(prepared.auth.authPath, '{"tokens":["refreshed"]}\n');

    await expect(writeBackCodexAuth({ auth: prepared.auth, github: undefined })).rejects.toThrow(
      "GITVIBE_GITHUB_TOKEN with repository Secrets read/write permission is required",
    );
  });

  it("fails changed auth write-back when GitHub omits the Actions public key", async () => {
    const prepared = prepare();
    writeFileSync(prepared.auth.authPath, '{"tokens":["refreshed"]}\n');
    const client = { request: vi.fn(async () => ({})) };

    await expect(
      writeBackCodexAuth({
        auth: prepared.auth,
        github: { client, repository: "example/repo", token: "token" },
      }),
    ).rejects.toThrow("GitHub repository example/repo did not return an Actions public key.");
  });
});

function prepare() {
  return prepareCodexEnv({
    contextDir: tempDir(),
    profile: {
      auth_json: { from_bundle: "CODEX_AUTH_JSON" },
      model: "gpt-5.5",
    },
    profileName: "codex_cli",
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
