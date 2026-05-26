// @ts-nocheck
import { describe, expect, it } from "vitest";
import { gitVibeLabels } from "../src/shared/labels.ts";
import {
  createApp,
  createClient,
  discussionCommentBodies,
  discussionLabelRemovals,
  repositoryPayload,
  requestBodies,
  requestPaths,
  workflowDispatches,
} from "./support/server-app.mjs";

describe("GitVibe app server managed runtime labels", () => {
  it("accepts managed runtime issue labels from GitHub Actions", async () => {
    const client = createClient({ permission: new Error("GitHub API GET permission failed: 404") });
    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 11 },
      label: { name: gitVibeLabels.blocked.name },
      repository: repositoryPayload(),
      sender: { login: "github-actions[bot]" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "DELETE")).toEqual([]);
    expect(requestBodies(client, "POST", "/issues/11/comments")).toEqual([]);
  });

  it("rejects managed runtime issue labels from untrusted users", async () => {
    const client = createClient({ permission: new Error("GitHub API GET permission failed: 404") });
    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 11 },
      label: { name: gitVibeLabels.validated.name },
      repository: repositoryPayload(),
      sender: { login: "guest" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/11/labels/gvi%3Avalidated",
    );
    expect(requestBodies(client, "POST", "/issues/11/comments").at(-1).body).toContain(
      "not allowed to control GitVibe automation labels",
    );
  });

  it("accepts managed runtime discussion labels from GitHub Actions", async () => {
    const client = createClient({ permission: new Error("GitHub API GET permission failed: 404") });
    const app = createApp({ client });

    await app.handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.blocked.name, node_id: "blocked-label-node" },
      repository: repositoryPayload(),
      sender: { login: "github-actions[bot]" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(discussionLabelRemovals(client)).toEqual([]);
    expect(discussionCommentBodies(client)).toEqual([]);
  });

  it("rejects managed runtime discussion labels from untrusted users", async () => {
    const client = createClient({ permission: new Error("GitHub API GET permission failed: 404") });
    const app = createApp({ client });

    await app.handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.validated.name, node_id: "validated-label-node" },
      repository: repositoryPayload(),
      sender: { login: "guest" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(discussionLabelRemovals(client)).toEqual([
      { discussionId: "discussion-node", labelIds: ["validated-label-node"] },
    ]);
    expect(discussionCommentBodies(client).at(-1)).toContain(
      "not allowed to control GitVibe automation labels",
    );
  });

  it("ignores managed runtime pull request label events from GitHub Actions", async () => {
    const client = createClient({ permission: new Error("GitHub API GET permission failed: 404") });
    await createApp({ client }).handleWebhook("pull_request", {
      action: "labeled",
      label: { name: gitVibeLabels.blocked.name },
      pull_request: { number: 12 },
      repository: repositoryPayload(),
      sender: { login: "github-actions[bot]" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "DELETE")).toEqual([]);
    expect(requestBodies(client, "POST", "/issues/12/comments")).toEqual([]);
  });
});
