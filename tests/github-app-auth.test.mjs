// @ts-nocheck
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canWriteBackCodexAuthForGitHubActionsJob,
  GitHubAppInstallationTokenProvider,
  isGitHubAppPermissionProfile,
  permissionsForProfile,
  runnerPermissionProfileForGitHubActionsJob,
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
        profile: "runner-workflow-write",
        repo: "repo",
      }),
    ).resolves.toBe("installation-token");
    await expect(
      provider.tokenForRepository({
        installationId: 987,
        owner: "example",
        profile: "runner-workflow-write",
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

describe("GitHub App installation token private keys", () => {
  it("accepts GitHub App RSA private keys downloaded from GitHub", async () => {
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
      privateKey: testPrivateKey("pkcs1"),
    });

    await expect(
      provider.tokenForRepository({
        installationId: 987,
        owner: "example",
        profile: "runner-status-write",
        repo: "repo",
      }),
    ).resolves.toBe("installation-token");

    expect(client.request.mock.calls[0][0].token.split(".")).toHaveLength(3);
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
});

describe("GitHub App permission profiles", () => {
  it("defines least-privilege permission profiles for server and runner tokens", () => {
    expect(permissionsForProfile("server")).toEqual({
      actions: "write",
      actions_variables: "read",
      contents: "write",
      discussions: "write",
      issues: "write",
      pull_requests: "write",
    });
    expect(permissionsForProfile("server-checks-read")).toEqual({ checks: "read" });
    expect(permissionsForProfile("server-secrets-write")).toEqual({ secrets: "write" });
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
      contents: "write",
      discussions: "write",
      issues: "write",
      pull_requests: "write",
    });
    expect(permissionsForProfile("runner-workflow-write")).not.toHaveProperty("secrets");
  });

  it("recognizes server and runner permission profile names", () => {
    expect(isGitHubAppPermissionProfile("server-checks-read")).toBe(true);
    expect(isGitHubAppPermissionProfile("runner-read")).toBe(true);
    expect(isGitHubAppPermissionProfile("server-secrets-write")).toBe(true);
    expect(isGitHubAppPermissionProfile("owner")).toBe(false);
  });
});

describe("GitHub Actions hosted auth job mapping", () => {
  it("derives runner profiles from trusted reusable workflow files and check run job names", () => {
    expect(profile("validate.yml", "validate / validate")).toBe("runner-status-write");
    expect(profile("review.yml", "review / review-matrix")).toBe("runner-workflow-write");
    expect(profile("review.yml", "review / plan-review-matrix")).toBe("runner-read");
    expect(profile("review.yml", "review / security-review")).toBe("runner-status-write");
    expect(profile("review.yml", "review / git-vibe-review-member-1 / security")).toBe(
      "runner-read",
    );
    expect(profile("review.yml", "git-vibe-review-member-1 / security")).toBe("runner-read");
    expect(profile("review.yml", "review / security")).toBeUndefined();
  });

  it("allows legacy Codex auth writeback only for AI execution jobs", () => {
    expect(canWriteback("validate.yml", "validate / validate")).toBe(true);
    expect(canWriteback("review.yml", "review / review-matrix")).toBe(true);
    expect(canWriteback("review.yml", "review / git-vibe-review-member-1 / security")).toBe(true);
    expect(canWriteback("review.yml", "git-vibe-review-member-1 / security")).toBe(true);
    expect(canWriteback("validate.yml", "validate / security-review")).toBe(false);
    expect(canWriteback("review.yml", "review / plan-review-matrix")).toBe(false);
  });
});

function testPrivateKey(type = "pkcs8") {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "pem", type }).toString();
}

function profile(workflowFile, checkRunName) {
  return runnerPermissionProfileForGitHubActionsJob({
    checkRunName,
    jobWorkflowRef: `markhuangai/git-vibe/.github/workflows/${workflowFile}@v3`,
  });
}

function canWriteback(workflowFile, checkRunName) {
  return canWriteBackCodexAuthForGitHubActionsJob({
    checkRunName,
    jobWorkflowRef: `markhuangai/git-vibe/.github/workflows/${workflowFile}@v3`,
  });
}
