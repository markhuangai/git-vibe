import { describe, expect, it, vi } from "vitest";
import { createApp, createAppAuth, requestJson, withHttpServer } from "./support/server-app.mjs";

describe("GitVibe app actions token endpoint", () => {
  it("exchanges GitHub Actions OIDC tokens over HTTP", async () => {
    const appAuth = createAppAuth();
    const actionsOidcVerifier = {
      verify: vi.fn(async () => ({
        jobWorkflowRef: "markhuangai/git-vibe/.github/workflows/develop.yml@v3",
        repository: "example/repo",
        repositoryId: "123",
        repositoryOwner: "example",
        workflowRef: "example/repo/.github/workflows/develop.yml@refs/heads/main",
      })),
    };
    const app = createApp({
      actionsOidcAudience: "https://git-vibe.markhuang.ai/actions/token",
      actionsOidcVerifier,
      appAuth,
    });

    await withHttpServer(
      app.handleRequest,
      /**
       * @param {string} url
       */
      async (url) => {
        await expect(
          requestJson(url, "POST", "/actions/token", JSON.stringify({ oidcToken: "oidc" })),
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
    expect(appAuth.tokenForRepository).toHaveBeenCalledWith({
      owner: "example",
      profile: "runner",
      repo: "repo",
    });
  });
});
