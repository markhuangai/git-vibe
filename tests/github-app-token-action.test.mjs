// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubAppToken } from "../src/runner/actions/github-app-token.ts";
import { defaultActionsTokenUrl } from "../src/shared/hosted-app.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub App token action resolver", () => {
  it("uses an already brokered App token when present", async () => {
    const fetchImpl = vi.fn();

    await expect(
      githubAppToken({
        env: { GITVIBE_GITHUB_APP_TOKEN: "installation-token" },
        fetch: fetchImpl,
      }),
    ).resolves.toBe("installation-token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses process env when no runtime env is provided", async () => {
    const previous = process.env.GITVIBE_GITHUB_APP_TOKEN;
    process.env.GITVIBE_GITHUB_APP_TOKEN = "process-token";

    try {
      await expect(githubAppToken({ fetch: vi.fn() })).resolves.toBe("process-token");
    } finally {
      if (previous === undefined) delete process.env.GITVIBE_GITHUB_APP_TOKEN;
      else process.env.GITVIBE_GITHUB_APP_TOKEN = previous;
    }
  });

  it("requests a GitHub Actions OIDC token and exchanges it with GitVibe", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: "oidc-token" }))
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token" }));

    await expect(
      githubAppToken({
        env: {
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test/id",
          GITVIBE_ACTIONS_TOKEN_URL: "https://git-vibe.markhuang.ai/actions/token",
        },
        fetch: fetchImpl,
      }),
    ).resolves.toBe("installation-token");

    const oidcUrl = fetchImpl.mock.calls[0][0];
    expect(String(oidcUrl)).toBe(
      "https://token.actions.test/id?audience=https%3A%2F%2Fgit-vibe.markhuang.ai%2Factions%2Ftoken",
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      headers: { authorization: "Bearer request-token" },
    });
    expect(fetchImpl.mock.calls[1]).toMatchObject([
      "https://git-vibe.markhuang.ai/actions/token",
      {
        body: JSON.stringify({ oidcToken: "oidc-token", permissionProfile: "runner" }),
        method: "POST",
      },
    ]);
  });
});

describe("GitHub App token action hosted exchange", () => {
  it("uses the hosted token URL as the default OIDC audience and exchange endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: "oidc-token" }))
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token" }));
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      githubAppToken({
        env: {
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test/id",
        },
      }),
    ).resolves.toBe("installation-token");

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      `https://token.actions.test/id?audience=${encodeURIComponent(defaultActionsTokenUrl)}`,
    );
    expect(fetchImpl.mock.calls[1][0]).toBe(defaultActionsTokenUrl);
  });

  it("lets a custom OIDC audience override the actions token URL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: "oidc-token" }))
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token" }));

    await expect(
      githubAppToken({
        env: {
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test/id",
          GITVIBE_ACTIONS_OIDC_AUDIENCE: "custom-audience",
          GITVIBE_ACTIONS_TOKEN_URL: "https://git-vibe.example/actions/token",
        },
        fetch: fetchImpl,
      }),
    ).resolves.toBe("installation-token");

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "https://token.actions.test/id?audience=custom-audience",
    );
    expect(fetchImpl.mock.calls[1][0]).toBe("https://git-vibe.example/actions/token");
  });
});

describe("GitHub App token action response validation", () => {
  it("surfaces invalid OIDC and GitVibe token endpoint responses", async () => {
    await expect(
      githubAppToken({
        env: tokenRequestEnv(),
        fetch: vi.fn().mockResolvedValueOnce(textResponse("", 200)),
      }),
    ).rejects.toThrow("GitHub Actions OIDC token response was missing value");

    await expect(
      githubAppToken({
        env: tokenRequestEnv(),
        fetch: vi
          .fn()
          .mockResolvedValueOnce(jsonResponse({ value: "oidc-token" }))
          .mockResolvedValueOnce(textResponse("", 200)),
      }),
    ).rejects.toThrow("GitVibe actions token response was missing token");

    await expect(
      githubAppToken({
        env: tokenRequestEnv(),
        fetch: vi.fn().mockResolvedValueOnce(jsonResponse({ error: "nope" }, 403)),
      }),
    ).rejects.toThrow('GitHub Actions OIDC token request failed: 403 {"error":"nope"}');

    await expect(
      githubAppToken({
        env: tokenRequestEnv(),
        fetch: vi.fn().mockResolvedValueOnce(jsonResponse([], 200)),
      }),
    ).rejects.toThrow("GitHub Actions OIDC token response must be a JSON object");
  });
});

function jsonResponse(body, status = 200) {
  return textResponse(JSON.stringify(body), status);
}

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function tokenRequestEnv() {
  return {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test/id",
    GITVIBE_ACTIONS_TOKEN_URL: "https://git-vibe.markhuang.ai/actions/token",
  };
}
