// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import {
  defaultTrustedWorkflowRefPattern,
  exchangeActionsToken,
} from "../src/app/actions-token.ts";

const trustedClaims = {
  checkRunId: "123456",
  jobWorkflowRef: "markhuangai/git-vibe/.github/workflows/develop.yml@v3",
  repository: "example/repo",
  repositoryId: "123",
  repositoryOwner: "example",
  sha: "abc123",
  workflowRef: "example/repo/.github/workflows/develop.yml@refs/heads/main",
};

describe("GitHub Actions token exchange", () => {
  it("derives the runner profile from the trusted workflow check run", async () => {
    const client = clientWithCheckRun({ head_sha: "abc123", name: "develop / security-review" });
    const tokenProvider = tokenProviderForProfiles();
    const verifier = { verify: vi.fn(async () => trustedClaims) };

    await expect(
      exchangeActionsToken({
        audience: "https://git-vibe.markhuang.ai/actions/token",
        body: JSON.stringify({
          oidcToken: "oidc",
          permissionProfile: "runner-status-write",
        }),
        client,
        tokenProvider,
        verifier,
      }),
    ).resolves.toEqual({ expires_in: 3600, token: "runner-token" });

    expect(verifier.verify).toHaveBeenCalledWith(
      "oidc",
      "https://git-vibe.markhuang.ai/actions/token",
    );
    expect(tokenProvider.tokenForRepository.mock.calls).toEqual([
      [
        {
          owner: "example",
          profile: "server-checks-read",
          repo: "repo",
        },
      ],
      [
        {
          owner: "example",
          profile: "runner-status-write",
          repo: "repo",
        },
      ],
    ]);
    expect(client.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/repos/example/repo/check-runs/123456",
      token: "checks-token",
    });
  });

  it("accepts snake_case body fields", async () => {
    const tokenProvider = tokenProviderForProfiles();
    const verifier = { verify: vi.fn(async () => trustedClaims) };

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidc_token: "oidc", permission_profile: "runner-status-write" }),
        client: clientWithCheckRun({ head_sha: "abc123", name: "develop / create-pr" }),
        tokenProvider,
        verifier,
      }),
    ).resolves.toEqual({ expires_in: 3600, token: "runner-token" });

    expect(verifier.verify).toHaveBeenCalledWith("oidc", "audience");
  });

  it("rejects a requested profile that does not match the check run authority", async () => {
    const tokenProvider = tokenProviderForProfiles();

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-read" }),
        client: clientWithCheckRun({ head_sha: "abc123", name: "develop / security-review" }),
        tokenProvider,
        verifier: { verify: vi.fn(async () => trustedClaims) },
      }),
    ).rejects.toThrow("not authorized for the requested permission profile");

    expect(tokenProvider.tokenForRepository).toHaveBeenCalledTimes(1);
    expect(tokenProvider.tokenForRepository).toHaveBeenCalledWith({
      owner: "example",
      profile: "server-checks-read",
      repo: "repo",
    });
  });
});

describe("GitHub Actions token exchange rejection", () => {
  it("rejects unsupported profiles and untrusted reusable workflow refs", async () => {
    const tokenProvider = tokenProviderForProfiles();
    const verifier = {
      verify: vi.fn(async () => ({
        ...trustedClaims,
        jobWorkflowRef: "example/repo/.github/workflows/develop.yml@refs/heads/main",
      })),
    };

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "server" }),
        client: clientWithCheckRun(),
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("unsupported GitHub App token permission profile");

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-read" }),
        client: clientWithCheckRun(),
        tokenProvider,
        trustedWorkflowRefPattern: defaultTrustedWorkflowRefPattern,
        verifier,
      }),
    ).rejects.toThrow("job_workflow_ref is not trusted");
    expect(tokenProvider.tokenForRepository).not.toHaveBeenCalled();
  });
});

describe("GitHub Actions token workflow ref trust", () => {
  it("trusts stable and prerelease GitVibe reusable workflow release refs", async () => {
    const tokenProvider = tokenProviderForProfiles();
    const verifier = { verify: vi.fn() };

    for (const jobWorkflowRef of [
      "markhuangai/git-vibe/.github/workflows/develop.yml@v4.0.0",
      "markhuangai/git-vibe/.github/workflows/develop.yml@v4.0.0-rc.1",
      "markhuangai/git-vibe/.github/workflows/develop.yml@refs/tags/v4.0.0-rc.1",
    ]) {
      verifier.verify.mockResolvedValueOnce({ ...trustedClaims, jobWorkflowRef });
      await expect(
        exchangeActionsToken({
          audience: "audience",
          body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
          client: clientWithCheckRun({ head_sha: "abc123", name: "develop / security-review" }),
          tokenProvider,
          verifier,
        }),
      ).resolves.toEqual({ expires_in: 3600, token: "runner-token" });
    }
  });

  it("trusts GitVibe reusable workflows from canonical local branches only", async () => {
    const tokenProvider = tokenProviderForProfiles();
    const verifier = {
      verify: vi.fn(async () => ({
        ...trustedClaims,
        jobWorkflowRef: "markhuangai/git-vibe/.github/workflows/review.yml@refs/heads/dev",
      })),
    };

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-workflow-write" }),
        client: clientWithCheckRun({ head_sha: "abc123", name: "review / review-matrix" }),
        tokenProvider,
        verifier,
      }),
    ).resolves.toEqual({ expires_in: 3600, token: "runner-token" });

    verifier.verify.mockResolvedValueOnce({
      ...trustedClaims,
      jobWorkflowRef: "markhuangai/git-vibe/.github/workflows/review.yml@refs/heads/feature/test",
    });
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-read" }),
        client: clientWithCheckRun(),
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("job_workflow_ref is not trusted");
  });

  it("rejects malformed prerelease GitVibe workflow refs", async () => {
    const verifier = {
      verify: vi.fn(async () => ({
        ...trustedClaims,
        jobWorkflowRef: "markhuangai/git-vibe/.github/workflows/develop.yml@v4.0.0-",
      })),
    };

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
        client: clientWithCheckRun(),
        tokenProvider: tokenProviderForProfiles(),
        verifier,
      }),
    ).rejects.toThrow("job_workflow_ref is not trusted");
  });
});

describe("GitHub Actions token check run verification", () => {
  it("rejects invalid OIDC check run claims", async () => {
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-read" }),
        client: clientWithCheckRun(),
        tokenProvider: tokenProviderForProfiles(),
        verifier: { verify: vi.fn(async () => ({ ...trustedClaims, checkRunId: "0" })) },
      }),
    ).rejects.toThrow("check_run_id must be a positive integer");
  });

  it("rejects check runs that do not match the OIDC commit sha", async () => {
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
        client: clientWithCheckRun({ head_sha: "other", name: "develop / security-review" }),
        tokenProvider: tokenProviderForProfiles(),
        verifier: { verify: vi.fn(async () => trustedClaims) },
      }),
    ).rejects.toThrow("OIDC sha does not match the check run head SHA");
  });

  it("rejects incomplete check run responses", async () => {
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
        client: clientWithCheckRun({ head_sha: "abc123" }),
        tokenProvider: tokenProviderForProfiles(),
        verifier: { verify: vi.fn(async () => trustedClaims) },
      }),
    ).rejects.toThrow("GitHub check run response was missing name or head_sha");
  });

  it("rejects missing required OIDC claims from custom verifiers", async () => {
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
        client: clientWithCheckRun({ head_sha: "abc123", name: "develop / security-review" }),
        tokenProvider: tokenProviderForProfiles(),
        verifier: { verify: vi.fn(async () => ({ ...trustedClaims, sha: "" })) },
      }),
    ).rejects.toThrow("GitHub Actions OIDC claim sha is required");
  });

  it("rejects unrecognized check run job names", async () => {
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
        client: clientWithCheckRun({ head_sha: "abc123", name: "develop / untrusted-job" }),
        tokenProvider: tokenProviderForProfiles(),
        verifier: { verify: vi.fn(async () => trustedClaims) },
      }),
    ).rejects.toThrow("check run is not authorized for GitVibe hosted auth");
  });
});

describe("GitHub Actions token pull request check run verification", () => {
  it("accepts pull_request_target check runs whose OIDC sha is the pull request base", async () => {
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
        client: clientWithCheckRun({
          head_sha: "pr-head",
          name: "develop / security-review",
          pull_requests: [
            {
              base: { repo: { id: 123 }, sha: "abc123" },
              head: { repo: { id: 123 }, sha: "pr-head" },
            },
          ],
        }),
        tokenProvider: tokenProviderForProfiles(),
        verifier: { verify: vi.fn(async () => trustedClaims) },
      }),
    ).resolves.toEqual({ expires_in: 3600, token: "runner-token" });
  });

  it("accepts linked same-repository pull_request_target check runs with checkout sha drift", async () => {
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
        client: clientWithCheckRun({
          head_sha: "pr-head",
          name: "develop / security-review",
          pull_requests: [
            {
              base: { repo: { id: 123 }, sha: "base-sha" },
              head: { repo: { id: 123 }, sha: "pr-head" },
            },
          ],
        }),
        tokenProvider: tokenProviderForProfiles(),
        verifier: { verify: vi.fn(async () => trustedClaims) },
      }),
    ).resolves.toEqual({ expires_in: 3600, token: "runner-token" });
  });
});

describe("GitHub Actions token pull request check run rejection", () => {
  it("rejects linked fork pull request check runs when the OIDC sha does not match", async () => {
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
        client: clientWithCheckRun({
          head_sha: "pr-head",
          name: "develop / security-review",
          pull_requests: [
            {
              base: { repo: { id: 123 }, sha: "base-sha" },
              head: { repo: { id: 456 }, sha: "pr-head" },
            },
          ],
        }),
        tokenProvider: tokenProviderForProfiles(),
        verifier: { verify: vi.fn(async () => trustedClaims) },
      }),
    ).rejects.toThrow("OIDC sha does not match the check run head SHA");
  });

  it("rejects fork pull_request_target check runs whose OIDC sha is the pull request base", async () => {
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
        client: clientWithCheckRun({
          head_sha: "pr-head",
          name: "develop / security-review",
          pull_requests: [
            {
              base: { repo: { id: 123 }, sha: "abc123" },
              head: { repo: { id: 456 }, sha: "pr-head" },
            },
          ],
        }),
        tokenProvider: tokenProviderForProfiles(),
        verifier: { verify: vi.fn(async () => trustedClaims) },
      }),
    ).rejects.toThrow("OIDC sha does not match the check run head SHA");
  });

  it("rejects linked pull requests from a different repository id", async () => {
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
        client: clientWithCheckRun({
          head_sha: "pr-head",
          name: "develop / security-review",
          pull_requests: [
            {
              base: { repo: { id: 999 }, sha: "base-sha" },
              head: { repo: { id: 999 }, sha: "pr-head" },
            },
          ],
        }),
        tokenProvider: tokenProviderForProfiles(),
        verifier: { verify: vi.fn(async () => trustedClaims) },
      }),
    ).rejects.toThrow("OIDC sha does not match the check run head SHA");
  });
});

describe("GitHub Actions token cross-repository pull request rejection", () => {
  it("rejects checkout sha drift when any linked pull request is cross-repository", async () => {
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
        client: clientWithCheckRun({
          head_sha: "pr-head",
          name: "develop / security-review",
          pull_requests: [
            {
              base: { repo: { id: 123 }, sha: "base-sha" },
              head: { repo: { id: 123 }, sha: "pr-head" },
            },
            {
              base: { repo: { id: 123 }, sha: "base-sha" },
              head: { repo: { id: 456 }, sha: "pr-head" },
            },
          ],
        }),
        tokenProvider: tokenProviderForProfiles(),
        verifier: { verify: vi.fn(async () => trustedClaims) },
      }),
    ).rejects.toThrow("OIDC sha does not match the check run head SHA");
  });

  it("rejects base sha matches when any linked pull request is cross-repository", async () => {
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-status-write" }),
        client: clientWithCheckRun({
          head_sha: "pr-head",
          name: "develop / security-review",
          pull_requests: [
            {
              base: { repo: { id: 123 }, sha: "abc123" },
              head: { repo: { id: 123 }, sha: "pr-head" },
            },
            {
              base: { repo: { id: 123 }, sha: "abc123" },
              head: { repo: { id: 456 }, sha: "pr-head" },
            },
          ],
        }),
        tokenProvider: tokenProviderForProfiles(),
        verifier: { verify: vi.fn(async () => trustedClaims) },
      }),
    ).rejects.toThrow("OIDC sha does not match the check run head SHA");
  });
});

describe("GitHub Actions token request validation", () => {
  it("rejects malformed token exchange request bodies", async () => {
    const tokenProvider = tokenProviderForProfiles();
    const verifier = { verify: vi.fn() };

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: "not-json",
        client: clientWithCheckRun(),
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("actions token request body must be valid JSON");

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: "[]",
        client: clientWithCheckRun(),
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("actions token request body must be a JSON object");

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: "{}",
        client: clientWithCheckRun(),
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("permissionProfile is required");

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc" }),
        client: clientWithCheckRun(),
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("permissionProfile is required");

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ permissionProfile: "runner-read" }),
        client: clientWithCheckRun(),
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("oidcToken is required");
  });
});

function clientWithCheckRun(checkRun = { head_sha: "abc123", name: "develop / security-review" }) {
  return {
    request: vi.fn(async () => checkRun),
  };
}

function tokenProviderForProfiles() {
  return {
    tokenForRepository: vi.fn(async ({ profile }) =>
      profile === "server-checks-read" ? "checks-token" : "runner-token",
    ),
  };
}
