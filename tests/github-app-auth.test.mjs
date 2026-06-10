// @ts-nocheck
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubAppInstallationTokenProvider,
  permissionsForProfile,
} from "../src/app/github-app-auth.ts";

describe("GitHub App installation token provider", () => {
  it("mints and caches repository-scoped installation tokens by profile", async () => {
    const client = {
      request: vi.fn(async () => ({
        expires_at: "2026-06-09T02:00:00.000Z",
        token: "installation-token",
      })),
    };
    const provider = new GitHubAppInstallationTokenProvider({
      appId: "12345",
      client,
      now: () => new Date("2026-06-09T01:00:00.000Z"),
      privateKey: testPrivateKey(),
    });

    await expect(
      provider.tokenForRepository({
        installationId: 987,
        owner: "example",
        profile: "runner-content-write",
        repo: "repo",
      }),
    ).resolves.toBe("installation-token");
    await expect(
      provider.tokenForRepository({
        installationId: 987,
        owner: "example",
        profile: "runner-content-write",
        repo: "repo",
      }),
    ).resolves.toBe("installation-token");

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0][0]).toMatchObject({
      body: {
        permissions: {
          actions: "write",
          contents: "write",
          discussions: "write",
          issues: "write",
          pull_requests: "write",
          workflows: "write",
        },
        repositories: ["repo"],
      },
      method: "POST",
      path: "/app/installations/987/access_tokens",
    });
    expect(client.request.mock.calls[0][0].token.split(".")).toHaveLength(3);
  });

  it("resolves the installation ID from a verified repository when needed", async () => {
    const client = {
      request: vi.fn(async (request) => {
        if (request.method === "GET") return { id: 456 };
        return { expires_at: "2026-06-09T02:00:00.000Z", token: "repo-token" };
      }),
    };
    const provider = new GitHubAppInstallationTokenProvider({
      appId: "12345",
      client,
      now: () => new Date("2026-06-09T01:00:00.000Z"),
      privateKey: testPrivateKey(),
    });

    await expect(
      provider.tokenForRepository({ owner: "example", profile: "server", repo: "repo" }),
    ).resolves.toBe("repo-token");

    expect(client.request.mock.calls.map(([request]) => request.path)).toEqual([
      "/repos/example/repo/installation",
      "/app/installations/456/access_tokens",
    ]);
  });
});

describe("GitHub App installation token provider profile caching", () => {
  it("reuses resolved installation IDs across permission profiles", async () => {
    const client = {
      request: vi.fn(async (request) => {
        if (request.method === "GET") return { id: 456 };
        return {
          expires_at: "2026-06-09T02:00:00.000Z",
          token: `token-${request.body.repositories[0]}`,
        };
      }),
    };
    const provider = new GitHubAppInstallationTokenProvider({
      appId: "12345",
      client,
      now: () => new Date("2026-06-09T01:00:00.000Z"),
      privateKey: testPrivateKey(),
    });

    await provider.tokenForRepository({ owner: "example", profile: "server", repo: "repo" });
    await provider.tokenForRepository({
      owner: "example",
      profile: "runner-status-write",
      repo: "repo",
    });

    expect(client.request.mock.calls.map(([request]) => request.method)).toEqual([
      "GET",
      "POST",
      "POST",
    ]);
  });
});

describe("GitHub App installation token error handling", () => {
  it("refreshes cached installation tokens when they approach expiration", async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          expires_at: "2026-06-09T01:03:00.000Z",
          token: "expiring-token",
        })
        .mockResolvedValueOnce({
          expires_at: "2026-06-09T02:00:00.000Z",
          token: "fresh-token",
        }),
    };
    const provider = new GitHubAppInstallationTokenProvider({
      appId: "12345",
      client,
      now: () => new Date("2026-06-09T01:00:00.000Z"),
      privateKey: testPrivateKey(),
    });

    await expect(
      provider.tokenForRepository({
        installationId: 987,
        owner: "example",
        profile: "runner-status-write",
        repo: "repo",
      }),
    ).resolves.toBe("expiring-token");
    await expect(
      provider.tokenForRepository({
        installationId: 987,
        owner: "example",
        profile: "runner-status-write",
        repo: "repo",
      }),
    ).resolves.toBe("fresh-token");

    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid installation IDs and incomplete GitHub responses", async () => {
    const client = { request: vi.fn(async () => ({})) };
    const provider = new GitHubAppInstallationTokenProvider({
      appId: "12345",
      client,
      privateKey: testPrivateKey(),
    });

    await expect(
      provider.tokenForRepository({
        installationId: "not-a-number",
        owner: "example",
        profile: "runner-read",
        repo: "repo",
      }),
    ).rejects.toThrow("installation ID must be a positive integer");

    await expect(
      provider.tokenForRepository({
        installationId: 987,
        owner: "example",
        profile: "runner-read",
        repo: "repo",
      }),
    ).rejects.toThrow("missing token or expires_at");

    await expect(
      provider.tokenForRepository({ owner: "example", profile: "server", repo: "repo" }),
    ).rejects.toThrow("installation not found for example/repo");
  });

  it("defines least-privilege permission profiles for server and runner tokens", () => {
    expect(permissionsForProfile("server")).not.toHaveProperty("secrets");
    expect(permissionsForProfile("runner-read")).toEqual({
      contents: "read",
      discussions: "read",
      issues: "read",
      pull_requests: "read",
    });
    expect(permissionsForProfile("runner-status-write")).toEqual({
      contents: "read",
      discussions: "write",
      issues: "write",
      pull_requests: "write",
    });
    expect(permissionsForProfile("runner-workflow-write")).toEqual({
      actions: "write",
      contents: "read",
      discussions: "write",
      issues: "write",
      pull_requests: "write",
    });
    expect(permissionsForProfile("runner-content-write")).toMatchObject({
      contents: "write",
      workflows: "write",
    });
    expect(permissionsForProfile("runner-content-write")).not.toHaveProperty("secrets");
  });
});

function testPrivateKey() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}
