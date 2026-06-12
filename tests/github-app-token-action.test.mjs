// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  githubAppCodexAuthWriteback,
  githubAppToken,
  runnerPermissionProfileForStage,
} from "../src/runner/actions/github-app-token.ts";
import { defaultActionsCodexAuthUrl, defaultActionsTokenUrl } from "../src/shared/hosted-app.ts";

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
        permissionProfile: "runner-status-write",
      }),
    ).resolves.toBe("installation-token");

    const oidcUrl = fetchImpl.mock.calls[0][0];
    expect(String(oidcUrl)).toBe(
      "https://token.actions.test/id?audience=https%3A%2F%2Fgit-vibe.markhuang.ai%2Factions%2Ftoken",
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      headers: { authorization: "Bearer request-token" },
    });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(globalThis.AbortSignal);
    expect(fetchImpl.mock.calls[1]).toMatchObject([
      "https://git-vibe.markhuang.ai/actions/token",
      {
        body: JSON.stringify({
          oidcToken: "oidc-token",
          permissionProfile: "runner-status-write",
        }),
        method: "POST",
      },
    ]);
    expect(fetchImpl.mock.calls[1][1].signal).toBeInstanceOf(globalThis.AbortSignal);
  });

  it("selects least-privilege runner profiles from stage and execution mode", () => {
    expect(runnerPermissionProfileForStage("validate", "member")).toBe("runner-read");
    expect(runnerPermissionProfileForStage("investigate", "standard")).toBe("runner-status-write");
    expect(runnerPermissionProfileForStage("materialize", "standard")).toBe("runner-status-write");
    expect(runnerPermissionProfileForStage("create-pr", "standard")).toBe("runner-status-write");
    expect(runnerPermissionProfileForStage("review-matrix", "standard")).toBe(
      "runner-workflow-write",
    );
    expect(runnerPermissionProfileForStage("implement", "standard")).toBe("runner-content-write");
    expect(runnerPermissionProfileForStage("address-pr-feedback", "standard")).toBe(
      "runner-content-write",
    );
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
        permissionProfile: "runner-read",
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
        permissionProfile: "runner-workflow-write",
      }),
    ).resolves.toBe("installation-token");

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "https://token.actions.test/id?audience=custom-audience",
    );
    expect(fetchImpl.mock.calls[1][0]).toBe("https://git-vibe.example/actions/token");
  });
});

describe("GitHub App token action Codex auth writeback", () => {
  it("posts refreshed Codex auth bundles to the hosted writeback endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: "oidc-token" }))
      .mockResolvedValueOnce(jsonResponse({ updated: true }));

    await expect(
      githubAppCodexAuthWriteback(JSON.stringify({ CODEX_AUTH_JSON: "{}" }), {
        env: {
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test/id",
          GITVIBE_ACTIONS_CODEX_AUTH_URL: "https://git-vibe.example/actions/codex-auth",
        },
        fetch: fetchImpl,
      }),
    ).resolves.toBeUndefined();

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      `https://token.actions.test/id?audience=${encodeURIComponent(defaultActionsTokenUrl)}`,
    );
    expect(fetchImpl.mock.calls[1]).toMatchObject([
      "https://git-vibe.example/actions/codex-auth",
      {
        body: JSON.stringify({
          oidcToken: "oidc-token",
          value: JSON.stringify({ CODEX_AUTH_JSON: "{}" }),
        }),
        method: "POST",
      },
    ]);
  });

  it("uses the hosted Codex auth writeback URL by default", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: "oidc-token" }))
      .mockResolvedValueOnce(jsonResponse({ updated: true }));

    await githubAppCodexAuthWriteback("{}", {
      env: tokenRequestEnv(),
      fetch: fetchImpl,
    });

    expect(fetchImpl.mock.calls[1][0]).toBe(defaultActionsCodexAuthUrl);
  });
});

describe("GitHub App token action response validation", () => {
  it("surfaces invalid OIDC and GitVibe token endpoint responses", async () => {
    await expect(
      githubAppToken({
        env: tokenRequestEnv(),
        fetch: vi.fn().mockResolvedValueOnce(textResponse("", 200)),
        permissionProfile: "runner-status-write",
      }),
    ).rejects.toThrow("GitHub Actions OIDC token response was missing value");

    await expect(
      githubAppToken({
        env: tokenRequestEnv(),
        fetch: vi
          .fn()
          .mockResolvedValueOnce(jsonResponse({ value: "oidc-token" }))
          .mockResolvedValueOnce(textResponse("", 200)),
        permissionProfile: "runner-status-write",
      }),
    ).rejects.toThrow("GitVibe actions token response was missing token");

    const secretResponse = githubAppToken({
      env: tokenRequestEnv(),
      fetch: vi.fn().mockResolvedValueOnce(jsonResponse({ error: "nope", token: "secret" }, 403)),
      permissionProfile: "runner-status-write",
    });
    await expect(secretResponse).rejects.toThrow("GitHub Actions OIDC token request failed: 403");
    await expect(secretResponse).rejects.not.toThrow("secret");

    await expect(
      githubAppToken({
        env: tokenRequestEnv(),
        fetch: vi.fn().mockResolvedValueOnce(jsonResponse([], 200)),
        permissionProfile: "runner-status-write",
      }),
    ).rejects.toThrow("GitHub Actions OIDC token response must be a JSON object");

    await expect(
      githubAppCodexAuthWriteback("{}", {
        env: tokenRequestEnv(),
        fetch: vi
          .fn()
          .mockResolvedValueOnce(jsonResponse({ value: "oidc-token" }))
          .mockResolvedValueOnce(textResponse("", 200)),
      }),
    ).rejects.toThrow("GitVibe actions Codex auth response was missing updated=true");
  });

  it("fails hosted auth HTTP calls with a clear timeout error", async () => {
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    await expect(
      githubAppToken({
        env: { ...tokenRequestEnv(), GITVIBE_HTTP_TIMEOUT_MS: "1" },
        fetch: fetchImpl,
        permissionProfile: "runner-status-write",
      }),
    ).rejects.toThrow("GitHub Actions OIDC token request timed out after 1ms.");
  });

  it("rejects invalid hosted auth timeout configuration", async () => {
    const fetchImpl = vi.fn();

    await expect(
      githubAppToken({
        env: { ...tokenRequestEnv(), GITVIBE_HTTP_TIMEOUT_MS: "later" },
        fetch: fetchImpl,
        permissionProfile: "runner-status-write",
      }),
    ).rejects.toThrow("GITVIBE_HTTP_TIMEOUT_MS must be a positive integer");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires an explicit hosted token permission profile", async () => {
    const fetchImpl = vi.fn();

    await expect(
      githubAppToken({
        env: tokenRequestEnv(),
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("GitHub App permission profile is required");
    expect(fetchImpl).not.toHaveBeenCalled();
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
