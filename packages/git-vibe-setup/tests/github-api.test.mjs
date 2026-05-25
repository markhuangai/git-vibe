import { describe, expect, it } from "vitest";
import { githubApiHeaders, githubTokenFromEnvironment } from "../src/github-api.ts";

describe("GitHub API request headers", () => {
  it("omits authorization when no token is available", () => {
    expect(githubApiHeaders()).toMatchObject({
      accept: "application/vnd.github+json",
      "user-agent": "git-vibe-setup",
      "x-github-api-version": "2022-11-28",
    });
    expect(githubApiHeaders()).not.toHaveProperty("authorization");
  });

  it("adds an authorization header when a token is available", () => {
    expect(githubApiHeaders(" ghs_test ")).toMatchObject({
      authorization: "Bearer ghs_test",
    });
  });

  it("prefers GITHUB_TOKEN and falls back to GH_TOKEN", () => {
    expect(
      githubTokenFromEnvironment({
        GH_TOKEN: "ghs_secondary",
        GITHUB_TOKEN: "ghs_primary",
      }),
    ).toBe("ghs_primary");
    expect(githubTokenFromEnvironment({ GH_TOKEN: "ghs_secondary" })).toBe("ghs_secondary");
  });

  it("rejects invalid token values without exposing the token", () => {
    expect(() => githubTokenFromEnvironment({ GITHUB_TOKEN: "secret\nvalue" })).toThrow(
      "invalid GitHub token value",
    );
    expect(() => githubTokenFromEnvironment({ GITHUB_TOKEN: "secret\nvalue" })).not.toThrow(
      "secret",
    );
  });
});
