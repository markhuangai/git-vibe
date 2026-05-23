// @ts-nocheck
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isDirectRun, markBlocked, markIssueBlocked } from "../src/runner/actions/mark-blocked.ts";
import { gitVibeLabels } from "../src/shared/labels.ts";

describe("markIssueBlocked", () => {
  it("removes stale implementation labels before adding blocked", async () => {
    const request = vi.fn(async () => ({}));

    await markIssueBlocked(issueOptions(request));

    expect(request.mock.calls).toEqual([
      [
        {
          method: "DELETE",
          path: "/repos/markhuangai/git-vibe/issues/22/labels/gvi%3Ain-progress",
          token: "token",
        },
      ],
      [
        {
          method: "DELETE",
          path: "/repos/markhuangai/git-vibe/issues/22/labels/git-vibe%3Aapproved",
          token: "token",
        },
      ],
      [blockedRequest()],
    ]);
  });

  it("does not mutate labels when low-level options are dry-run", async () => {
    const request = vi.fn(async () => ({}));

    await markIssueBlocked(issueOptions(request, { dryRun: true }));

    expect(request).not.toHaveBeenCalled();
  });

  it("ignores missing stale labels", async () => {
    const request = vi.fn(async (options) => {
      if (options.method === "DELETE") throw new Error("GitHub API failed with 404");
      return {};
    });

    await markIssueBlocked(issueOptions(request));

    expect(request).toHaveBeenLastCalledWith(blockedRequest());
  });

  it("fails when stale label deletion fails for a non-404 error", async () => {
    const request = vi.fn(async () => {
      throw new Error("GitHub API failed with 500");
    });

    await expect(markIssueBlocked(issueOptions(request))).rejects.toThrow(
      "GitHub API failed with 500",
    );
  });
});

describe("markBlocked", () => {
  it("does not mutate labels in dry-run mode", async () => {
    const request = vi.fn(async () => ({}));
    const log = vi.fn();

    const exitCode = await markBlocked({
      client: { request },
      env: actionEnv({ GITVIBE_DRY_RUN: "true" }),
      log,
    });

    expect(exitCode).toBe(0);
    expect(request).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "dry-run: would mark issue #22 blocked after an incomplete run",
    );
  });

  it("marks an issue blocked from action environment", async () => {
    const request = vi.fn(async () => ({}));
    const log = vi.fn();

    const exitCode = await markBlocked({
      client: { request },
      env: actionEnv({ GITVIBE_DRY_RUN: "false" }),
      log,
    });

    expect(exitCode).toBe(0);
    expect(log).toHaveBeenCalledWith("marked issue #22 blocked after an incomplete run");
    expect(request).toHaveBeenLastCalledWith(blockedRequest());
  });

  it("reports missing required environment", async () => {
    const error = vi.fn();

    const exitCode = await markBlocked({
      env: {
        GITHUB_REPOSITORY: "markhuangai/git-vibe",
        GITVIBE_GITHUB_TOKEN: "token",
      },
      error,
    });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "failed to mark issue blocked: GITVIBE_ISSUE_NUMBER is required.",
    );
  });
});

describe("mark-blocked direct run detection", () => {
  it("detects direct action entrypoints", () => {
    expect(isDirectRun("", "/tmp/mark-blocked.cjs")).toBe(true);
    expect(isDirectRun("", "/tmp/run-action.cjs")).toBe(false);

    const entrypoint = resolve("/tmp/mark-blocked.ts");
    expect(isDirectRun(pathToFileURL(entrypoint).href, entrypoint)).toBe(true);
    expect(isDirectRun("file:///tmp/other.ts", entrypoint)).toBe(false);
  });
});

function issueOptions(request, overrides = {}) {
  return {
    client: { request },
    dryRun: false,
    issueNumber: "22",
    owner: "markhuangai",
    repo: "git-vibe",
    token: "token",
    ...overrides,
  };
}

function actionEnv(overrides = {}) {
  return {
    GITHUB_REPOSITORY: "markhuangai/git-vibe",
    GITVIBE_GITHUB_TOKEN: "token",
    GITVIBE_ISSUE_NUMBER: "22",
    ...overrides,
  };
}

function blockedRequest() {
  return {
    body: { labels: [gitVibeLabels.blocked.name] },
    method: "POST",
    path: "/repos/markhuangai/git-vibe/issues/22/labels",
    token: "token",
  };
}
