import { describe, expect, it, vi } from "vitest";
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

  it("does not expose the removed Codex auth writeback endpoint", async () => {
    const actionsOidcVerifier = { verify: vi.fn(async () => trustedClaims) };
    const app = createApp({
      actionsOidcVerifier,
      client: clientForHostedAuth({ head_sha: "abc123", name: "validate / security-review" }),
    });

    await withHttpServer(
      app.handleRequest,
      /**
       * @param {string} url
       */
      async (url) => {
        await expect(
          requestJson(url, "POST", "/actions/codex-auth", JSON.stringify({ oidcToken: "oidc" })),
        ).resolves.toMatchObject({
          body: { error: "not_found" },
          status: 404,
        });
      },
    );

    expect(actionsOidcVerifier.verify).not.toHaveBeenCalled();
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
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    }),
  };
}

/**
 * @param {any} appAuth
 */
function tokenProfiles(appAuth) {
  /** @type {Array<[{ profile: string }]>} */
  const calls = appAuth.tokenForRepository.mock.calls;
  return calls.map(([request]) => request.profile);
}
