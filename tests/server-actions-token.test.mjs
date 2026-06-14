import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import { writeBackActionsCodexAuth } from "../src/app/actions-codex-auth.ts";
import { createApp, createAppAuth, requestJson, withHttpServer } from "./support/server-app.mjs";

const trustedClaims = {
  checkRunId: "123456",
  jobWorkflowRef: "markhuangai/git-vibe/.github/workflows/validate.yml@v3",
  repository: "example/repo",
  repositoryId: "123",
  repositoryOwner: "example",
  sha: "abc123",
  workflowRef: "example/repo/.github/workflows/validate.yml@refs/heads/main",
};

describe("GitVibe app actions token endpoint", () => {
  it("exchanges GitHub Actions OIDC tokens over HTTP", async () => {
    const appAuth = createAppAuth();
    const client = clientForHostedAuth({ head_sha: "abc123", name: "validate / security-review" });
    const actionsOidcVerifier = {
      verify: vi.fn(async () => trustedClaims),
    };
    const app = createApp({
      actionsOidcAudience: "https://git-vibe.markhuang.ai/actions/token",
      actionsOidcVerifier,
      appAuth,
      client,
    });

    await withHttpServer(
      app.handleRequest,
      /**
       * @param {string} url
       */
      async (url) => {
        await expect(
          requestJson(
            url,
            "POST",
            "/actions/token",
            JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
          ),
        ).resolves.toMatchObject({
          body: { expires_in: 3600, token: "token" },
          status: 200,
        });
      },
    );

    expect(actionsOidcVerifier.verify).toHaveBeenCalledWith(
      "oidc",
      "https://git-vibe.markhuang.ai/actions/token",
    );
    expect(tokenProfiles(appAuth)).toEqual(["server-checks-read", "runner-status-write"]);
    expect(client.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/repos/example/repo/check-runs/123456",
      token: "token",
    });
  });
});

describe("GitVibe app actions Codex auth endpoint", () => {
  it("updates the AI env bundle secret for authorized AI jobs", async () => {
    const appAuth = createAppAuth();
    const client = clientForHostedAuth({ head_sha: "abc123", name: "validate / validate" });
    const app = createApp({
      actionsOidcVerifier: { verify: vi.fn(async () => trustedClaims) },
      appAuth,
      client,
    });

    await withHttpServer(
      app.handleRequest,
      /**
       * @param {string} url
       */
      async (url) => {
        await expect(
          requestJson(
            url,
            "POST",
            "/actions/codex-auth",
            JSON.stringify({
              oidcToken: "oidc",
              value: JSON.stringify({ CODEX_AUTH_JSON: "{}" }),
            }),
          ),
        ).resolves.toMatchObject({
          body: { updated: true },
          status: 200,
        });
      },
    );

    expect(tokenProfiles(appAuth)).toEqual(["server-checks-read", "server-secrets-write"]);
    expect(requestPaths(client)).toEqual([
      "/repos/example/repo/check-runs/123456",
      "/repos/example/repo/actions/secrets/public-key",
      "/repos/example/repo/actions/secrets/GITVIBE_AI_ENV_JSON",
    ]);
  });

  it("rejects non-AI jobs and malformed bundle values", async () => {
    const app = createApp({
      actionsOidcVerifier: { verify: vi.fn(async () => trustedClaims) },
      client: clientForHostedAuth({ head_sha: "abc123", name: "validate / security-review" }),
    });

    await withHttpServer(
      app.handleRequest,
      /**
       * @param {string} url
       */
      async (url) => {
        await expect(
          requestJson(
            url,
            "POST",
            "/actions/codex-auth",
            JSON.stringify({ oidcToken: "oidc", value: JSON.stringify({ CODEX_AUTH_JSON: "{}" }) }),
          ),
        ).resolves.toMatchObject({
          body: { error: "GitHub Actions job is not authorized to update Codex auth." },
          status: 403,
        });

        await expect(
          requestJson(
            url,
            "POST",
            "/actions/codex-auth",
            JSON.stringify({ oidcToken: "oidc", value: "[]" }),
          ),
        ).resolves.toMatchObject({
          body: { error: "value must be a JSON object string." },
          status: 400,
        });
      },
    );
  });
});

describe("GitVibe actions Codex auth writeback validation", () => {
  it("rejects malformed request bodies before verifying OIDC", async () => {
    await expect(codexWriteback({ body: "not-json" })).rejects.toThrow(
      "actions Codex auth request body must be valid JSON",
    );
    await expect(codexWriteback({ body: "[]" })).rejects.toThrow(
      "actions Codex auth request body must be a JSON object",
    );
    await expect(
      codexWriteback({
        body: JSON.stringify({ value: JSON.stringify({ CODEX_AUTH_JSON: "{}" }) }),
      }),
    ).rejects.toThrow("oidcToken is required");
    await expect(codexWriteback({ body: JSON.stringify({ oidc_token: "oidc" }) })).rejects.toThrow(
      "value is required",
    );
  });

  it("rejects malformed AI env bundle values", async () => {
    await expect(
      codexWriteback({ body: JSON.stringify({ oidcToken: "oidc", value: "not-json" }) }),
    ).rejects.toThrow("value must be a valid JSON object string");
    await expect(
      codexWriteback({ body: JSON.stringify({ oidcToken: "oidc", value: "[]" }) }),
    ).rejects.toThrow("value must be a JSON object string");
  });
});

/**
 * @param {{ head_sha: string, name: string }} checkRun
 */
function clientForHostedAuth(checkRun) {
  return {
    request: vi.fn(async (request) => {
      if (request.method === "GET" && request.path === "/repos/example/repo/check-runs/123456") {
        return checkRun;
      }
      if (
        request.method === "GET" &&
        request.path === "/repos/example/repo/actions/secrets/public-key"
      ) {
        return { key: await publicKey(), key_id: "key-id" };
      }
      if (
        request.method === "PUT" &&
        request.path === "/repos/example/repo/actions/secrets/GITVIBE_AI_ENV_JSON"
      ) {
        expect(request.body).toMatchObject({ key_id: "key-id" });
        expect(request.body.encrypted_value).toEqual(expect.any(String));
        return {};
      }
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    }),
  };
}

/**
 * @param {{ body: string }} options
 */
function codexWriteback({ body }) {
  const client = /** @type {any} */ (
    clientForHostedAuth({ head_sha: "abc123", name: "validate / validate" })
  );
  return writeBackActionsCodexAuth({
    audience: "audience",
    body,
    client,
    tokenProvider: createAppAuth(),
    verifier: { verify: vi.fn(async () => trustedClaims) },
  });
}

/**
 * @param {any} appAuth
 */
function tokenProfiles(appAuth) {
  /** @type {Array<[{ profile: string }]>} */
  const calls = appAuth.tokenForRepository.mock.calls;
  return calls.map(([request]) => request.profile);
}

/**
 * @param {{ request: { mock: { calls: Array<[{ path: string }]> } } }} client
 */
function requestPaths(client) {
  return client.request.mock.calls.map(([request]) => request.path);
}

async function publicKey() {
  await sodium.ready;
  return sodium.to_base64(sodium.crypto_box_keypair().publicKey, sodium.base64_variants.ORIGINAL);
}
