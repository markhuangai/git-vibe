import { describe, expect, it, vi } from "vitest";
import {
  createApp,
  createClient,
  repositoryPayload,
  requestBodies,
  requestPaths,
  workflowDispatches,
} from "./support/server-app.mjs";

describe("GitVibe app server PR approval labels", () => {
  it("labels pull requests when trusted reviews approve GitVibe pull requests", async () => {
    const client = createClient();
    const app = createApp({ client });

    await app.handleWebhook("pull_request_review", {
      action: "submitted",
      pull_request: {
        body: "## GitVibe Traceability\n\nRefs #12",
        number: 22,
      },
      repository: repositoryPayload(),
      review: { state: "approved" },
      sender: { login: "maintainer" },
    });

    expect(requestBodies(client, "POST", "/issues/22/labels")).toContainEqual({
      labels: ["git-vibe:pr-approved"],
    });
    expect(requestPaths(client, "DELETE")).toEqual(
      expect.arrayContaining([
        "/repos/example/repo/issues/22/labels/git-vibe%3Aready-for-approval",
        "/repos/example/repo/issues/12/labels/git-vibe%3Aapproved",
      ]),
    );
    expect(workflowDispatches(client)).toEqual([]);
  });

  it("fetches PR bodies when approval webhook payloads omit them", async () => {
    const client = createClient({ pullRequestBody: "## GitVibe Traceability\n\nRefs #12" });
    const app = createApp({ client });

    await app.handleWebhook("pull_request_review", {
      action: "submitted",
      pull_request: { number: 22 },
      repository: repositoryPayload(),
      review: { state: "approved" },
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "GET")).toContain("/repos/example/repo/pulls/22");
    expect(requestBodies(client, "POST", "/issues/22/labels")).toContainEqual({
      labels: ["git-vibe:pr-approved"],
    });
  });

  it("ignores approved reviews from untrusted actors", async () => {
    const log = vi.fn();
    const client = createClient({ permission: new Error("GitHub API GET permission failed: 404") });
    const app = createApp({ client, log });

    await app.handleWebhook("pull_request_review", {
      action: "submitted",
      pull_request: {
        body: "## GitVibe Traceability\n\nRefs #12",
        number: 22,
      },
      repository: repositoryPayload(),
      review: { state: "approved" },
      sender: { login: "guest" },
    });

    expect(requestBodies(client, "POST", "/issues/12/labels")).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "ignored approved review from untrusted actor @guest on PR #22",
    );
  });

  it("skips PR approval labels without GitVibe traceability", async () => {
    const log = vi.fn();
    const client = createClient();
    const app = createApp({ client, log });

    await app.handleWebhook("pull_request_review", {
      action: "submitted",
      pull_request: { body: "Refs #12", number: 22 },
      repository: repositoryPayload(),
      review: { state: "approved" },
      sender: { login: "maintainer" },
    });

    expect(requestBodies(client, "POST", "/issues/22/labels")).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "skipped approved review labels for PR #22: missing GitVibe traceability",
    );
  });
});

describe("GitVibe app server PR merge labels", () => {
  it("labels source issues when GitVibe pull requests are merged", async () => {
    const client = createClient();
    const app = createApp({ client });

    await app.handleWebhook("pull_request", {
      action: "closed",
      pull_request: {
        body: "## GitVibe Traceability\n\nRefs #12\nRefs #13",
        merged: true,
        number: 22,
      },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestBodies(client, "POST", "/issues/12/labels")).toContainEqual({
      labels: ["git-vibe:pr-merged"],
    });
    expect(requestBodies(client, "POST", "/issues/13/labels")).toContainEqual({
      labels: ["git-vibe:pr-merged"],
    });
    expect(requestBodies(client, "POST", "/issues/22/labels")).toContainEqual({
      labels: ["git-vibe:pr-approved"],
    });
    expect(requestPaths(client, "DELETE")).toEqual(
      expect.arrayContaining([
        "/repos/example/repo/issues/22/labels/git-vibe%3Aready-for-approval",
        "/repos/example/repo/issues/12/labels/git-vibe%3Apr-opened",
        "/repos/example/repo/issues/12/labels/git-vibe%3Apr-approved",
        "/repos/example/repo/issues/12/labels/git-vibe%3Aapproved",
      ]),
    );
  });

  it("ignores unmerged closed pull requests", async () => {
    const log = vi.fn();
    const client = createClient();
    const app = createApp({ client, log });

    await app.handleWebhook("pull_request", {
      action: "closed",
      pull_request: {
        body: "## GitVibe Traceability\n\nRefs #12",
        merged: false,
        number: 22,
      },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestBodies(client, "POST", "/issues/12/labels")).toEqual([]);
    expect(log).toHaveBeenCalledWith("ignored pull_request.closed unmerged PR #22");
  });

  it("ignores missing stale labels while marking pull requests merged", async () => {
    const client = createClient({
      labelRemovalError: new Error("GitHub API DELETE label failed: 404"),
    });
    const app = createApp({ client });

    await app.handleWebhook("pull_request", {
      action: "closed",
      pull_request: {
        body: "## GitVibe Traceability\n\nRefs #12",
        merged: true,
        number: 22,
      },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestBodies(client, "POST", "/issues/12/labels")).toContainEqual({
      labels: ["git-vibe:pr-merged"],
    });
  });

  it("skips PR merge label updates without GitVibe traceability", async () => {
    const log = vi.fn();
    const client = createClient();
    const app = createApp({ client, log });

    await app.handleWebhook("pull_request", {
      action: "closed",
      pull_request: { body: "Refs #12", merged: true, number: 22 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestBodies(client, "POST", "/issues/12/labels")).toEqual([]);
    expect(requestBodies(client, "POST", "/issues/22/labels")).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "skipped merged PR labels for PR #22: missing GitVibe traceability",
    );
  });
});
