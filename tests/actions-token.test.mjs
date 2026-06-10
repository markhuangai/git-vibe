// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import {
  defaultTrustedWorkflowRefPattern,
  exchangeActionsToken,
} from "../src/app/actions-token.ts";

const trustedClaims = {
  jobWorkflowRef: "markhuangai/git-vibe/.github/workflows/develop.yml@v3",
  repository: "example/repo",
  repositoryId: "123",
  repositoryOwner: "example",
  workflowRef: "example/repo/.github/workflows/develop.yml@refs/heads/main",
};

describe("GitHub Actions token exchange", () => {
  it("exchanges trusted GitHub Actions OIDC claims for a repository App token", async () => {
    const tokenProvider = { tokenForRepository: vi.fn(async () => "installation-token") };
    const verifier = { verify: vi.fn(async () => trustedClaims) };

    await expect(
      exchangeActionsToken({
        audience: "https://git-vibe.markhuang.ai/actions/token",
        body: JSON.stringify({
          oidcToken: "oidc",
          permissionProfile: "runner-status-write",
        }),
        tokenProvider,
        verifier,
      }),
    ).resolves.toEqual({ expires_in: 3600, token: "installation-token" });

    expect(verifier.verify).toHaveBeenCalledWith(
      "oidc",
      "https://git-vibe.markhuang.ai/actions/token",
    );
    expect(tokenProvider.tokenForRepository).toHaveBeenCalledWith({
      owner: "example",
      profile: "runner-status-write",
      repo: "repo",
    });
  });

  it("rejects unsupported profiles and untrusted reusable workflow refs", async () => {
    const tokenProvider = { tokenForRepository: vi.fn() };
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
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("unsupported GitHub App token permission profile");

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-read" }),
        tokenProvider,
        trustedWorkflowRefPattern: defaultTrustedWorkflowRefPattern,
        verifier,
      }),
    ).rejects.toThrow("job_workflow_ref is not trusted");
    expect(tokenProvider.tokenForRepository).not.toHaveBeenCalled();
  });

  it("accepts snake_case body fields", async () => {
    const tokenProvider = { tokenForRepository: vi.fn(async () => "installation-token") };
    const verifier = { verify: vi.fn(async () => trustedClaims) };

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidc_token: "oidc", permission_profile: "runner-read" }),
        tokenProvider,
        verifier,
      }),
    ).resolves.toEqual({ expires_in: 3600, token: "installation-token" });

    expect(verifier.verify).toHaveBeenCalledWith("oidc", "audience");
  });
});

describe("GitHub Actions token workflow ref trust", () => {
  it("trusts GitVibe reusable workflows from canonical local branches only", async () => {
    const tokenProvider = { tokenForRepository: vi.fn(async () => "installation-token") };
    const verifier = {
      verify: vi.fn(async () => ({
        ...trustedClaims,
        jobWorkflowRef: "markhuangai/git-vibe/.github/workflows/review.yml@refs/heads/dev",
      })),
    };

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-read" }),
        tokenProvider,
        verifier,
      }),
    ).resolves.toEqual({ expires_in: 3600, token: "installation-token" });

    verifier.verify.mockResolvedValueOnce({
      ...trustedClaims,
      jobWorkflowRef: "markhuangai/git-vibe/.github/workflows/review.yml@refs/heads/feature/test",
    });
    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc", permissionProfile: "runner-read" }),
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("job_workflow_ref is not trusted");
  });
});

describe("GitHub Actions token request validation", () => {
  it("rejects malformed token exchange request bodies", async () => {
    const tokenProvider = { tokenForRepository: vi.fn() };
    const verifier = { verify: vi.fn() };

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: "not-json",
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("actions token request body must be valid JSON");

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: "[]",
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("actions token request body must be a JSON object");

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: "{}",
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("permissionProfile is required");

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ oidcToken: "oidc" }),
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("permissionProfile is required");

    await expect(
      exchangeActionsToken({
        audience: "audience",
        body: JSON.stringify({ permissionProfile: "runner-read" }),
        tokenProvider,
        verifier,
      }),
    ).rejects.toThrow("oidcToken is required");
  });
});
