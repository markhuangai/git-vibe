// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { gitVibeInternalLabels, gitVibeLabels } from "../src/shared/labels.ts";
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

describe("GitVibe app server issue labels", () => {
  it("rejects untrusted protected labels", async () => {
    const client = createClient({ permission: new Error("GitHub API GET permission failed: 404") });
    const app = createApp({ client });

    await app.handleWebhook("issues", {
      action: "labeled",
      issue: { number: 2 },
      label: { name: gitVibeLabels.approved.name },
      repository: repositoryPayload(),
      sender: { login: "guest" },
    });

    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/2/labels/git-vibe%3Aapproved",
    );
    expect(requestBodies(client, "POST", "/issues/2/comments")[0].body).toContain("removed");
  });

  it("dispatches trusted investigate labels and replaces the trigger label", async () => {
    const client = createClient({ permission: { role_name: "maintain" } });
    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { labels: [{ name: gitVibeLabels.blocked.name }], number: 9 },
      label: { name: gitVibeLabels.investigate.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: { "issue-number": "9" },
        ref: "main",
        return_run_details: true,
      }),
    ]);
    expect(requestBodies(client, "POST", "/issues/9/labels")).toContainEqual({
      labels: ["gvi:investigating"],
    });
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/9/labels/git-vibe%3Ainvestigate",
    );
    expect(requestPaths(client, "DELETE")).toEqual(
      expect.arrayContaining([
        "/repos/example/repo/issues/9/labels/gvi%3Ablocked",
        "/repos/example/repo/issues/9/labels/git-vibe%3Ablocked",
      ]),
    );
    expect(requestBodies(client, "POST", "/issues/9/comments")).toEqual([]);
  });
});

describe("GitVibe app server issue approval labels", () => {
  it("rejects approved issue labels until investigation has completed", async () => {
    const client = createClient({ permission: { role_name: "maintain" } });
    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { labels: [{ name: gitVibeLabels.approved.name }], number: 9 },
      label: { name: gitVibeLabels.approved.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/9/labels/git-vibe%3Aapproved",
    );
    expect(requestBodies(client, "POST", "/issues/9/comments").at(-1).body).toContain(
      "has not completed investigation yet",
    );
  });

  it("dispatches trusted approved labels after investigation has completed", async () => {
    const client = createClient({ permission: { role_name: "maintain" } });
    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: {
        labels: [{ name: gitVibeLabels.approved.name }, { name: gitVibeLabels.investigated.name }],
        number: 9,
      },
      label: { name: gitVibeLabels.approved.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: { "issue-number": "9" },
        ref: "main",
        return_run_details: true,
      }),
    ]);
    expect(requestBodies(client, "POST", "/issues/9/comments")).toEqual([]);
  });

  it("accepts legacy investigated labels when approving in-flight issues", async () => {
    const client = createClient({ permission: { role_name: "maintain" } });
    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: {
        labels: [{ name: gitVibeLabels.approved.name }, { name: "git-vibe:investigated" }],
        number: 9,
      },
      label: { name: gitVibeLabels.approved.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: { "issue-number": "9" },
        ref: "main",
        return_run_details: true,
      }),
    ]);
    expect(requestBodies(client, "POST", "/issues/9/comments")).toEqual([]);
  });
});

describe("GitVibe app server managed runtime labels", () => {
  it("accepts trusted managed runtime labels without dispatching workflows", async () => {
    const client = createClient({ permission: { role_name: "maintain" } });
    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 11 },
      label: { name: gitVibeLabels.investigating.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "DELETE")).toEqual([]);
    expect(requestBodies(client, "POST", "/issues/11/comments")).toEqual([]);
  });
});

describe("GitVibe app server issue validation labels", () => {
  it("dispatches trusted validate labels on issues and removes the trigger label", async () => {
    const client = createClient({ permission: { role_name: "maintain" } });
    const app = createApp({ client });

    await app.handleWebhook("issues", {
      action: "labeled",
      issue: { number: 10 },
      label: { name: gitVibeLabels.validate.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: { "issue-number": "10" },
        ref: "main",
        return_run_details: true,
      }),
    ]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/10/labels/git-vibe%3Avalidate",
    );
    expect(requestBodies(client, "POST", "/issues/10/comments").at(-1).body).toContain(
      "validate.yml",
    );
  });

  it("ignores unprotected and non-approved labels", async () => {
    const client = createClient();
    const app = createApp({ client });

    await app.handleWebhook("issues", {
      action: "labeled",
      issue: { number: 2 },
      label: { name: "bug" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });
    await app.handleWebhook("issues", {
      action: "labeled",
      issue: { number: 2 },
      label: { name: gitVibeLabels.needsDiscussion.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
  });
});

describe("GitVibe app server internal labels", () => {
  it("removes manually applied internal issue labels", async () => {
    const client = createClient({ permission: { permission: "write" } });
    const app = createApp({ client });

    await app.handleWebhook("issues", {
      action: "labeled",
      issue: { number: 11 },
      label: { name: "gvi:manual" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/11/labels/gvi%3Amanual",
    );
    expect(requestBodies(client, "POST", "/issues/11/comments").at(-1).body).toContain(
      "internal runtime labels",
    );
  });
});

describe("GitVibe app server discussion labels", () => {
  it("resolves missing discussion label node IDs before removing validate triggers", async () => {
    const client = createClient({ permission: { permission: "write" } });
    const app = createApp({ client });

    await app.handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.validate.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("GitVibeDiscussionLabelId"),
      expect.objectContaining({ label: gitVibeLabels.validate.name }),
      "token",
    );
    expect(discussionLabelRemovals(client)).toEqual([
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
    ]);
  });

  it("dispatches trusted discussion validation and materialization labels", async () => {
    const client = createClient({ permission: { permission: "write" } });
    const app = createApp({ client });

    await app.handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.validate.name, node_id: "validate-label-node" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });
    await app.handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.approved.name, node_id: "approved-label-node" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "POST")).toEqual(
      expect.arrayContaining([
        "/repos/example/repo/actions/workflows/validate.yml/dispatches",
        "/repos/example/repo/actions/workflows/materialize.yml/dispatches",
      ]),
    );
    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({ inputs: { "discussion-number": "5" } }),
      expect.objectContaining({ inputs: { "discussion-number": "5" } }),
    ]);
    expect(discussionLabelRemovals(client)).toEqual([
      { discussionId: "discussion-node", labelIds: ["validate-label-node"] },
    ]);
    expect(discussionCommentBodies(client).join("\n")).toContain("validate.yml");
    expect(discussionCommentBodies(client).join("\n")).toContain("materialize.yml");
    expect(discussionCommentBodies(client).join("\n")).toContain(
      "Workflow run: https://github.com/example/repo/actions/runs/1",
    );
  });
});

describe("GitVibe app server discussion label cleanup", () => {
  it("posts queued comments even when validate trigger label cleanup fails", async () => {
    const log = vi.fn();
    const client = createClient({
      discussionLabelRemovalError: new Error("label cleanup failed"),
      permission: { permission: "write" },
    });

    await createApp({ client, log }).handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.validate.name, node_id: "validate-label-node" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({ inputs: { "discussion-number": "5" } }),
    ]);
    expect(discussionCommentBodies(client).at(-1)).toContain("validate.yml");
    expect(log).toHaveBeenCalledWith(
      "discussion label cleanup failed for git-vibe:validate: label cleanup failed",
    );
  });

  it("rejects untrusted protected discussion labels", async () => {
    const client = createClient({ permission: new Error("GitHub API GET permission failed: 404") });
    const app = createApp({ client });

    await app.handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.validate.name, node_id: "validate-label-node" },
      repository: repositoryPayload(),
      sender: { login: "guest" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(discussionLabelRemovals(client)).toEqual([
      { discussionId: "discussion-node", labelIds: ["validate-label-node"] },
    ]);
    expect(discussionCommentBodies(client).at(-1)).toContain("removed");
  });

  it("removes manually applied internal discussion labels", async () => {
    const client = createClient({ permission: { permission: "write" } });
    const app = createApp({ client });

    await app.handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeInternalLabels.reviewFix.name, node_id: "review-fix-label-node" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(discussionLabelRemovals(client)).toEqual([
      { discussionId: "discussion-node", labelIds: ["review-fix-label-node"] },
    ]);
    expect(discussionCommentBodies(client).at(-1)).toContain("internal runtime labels");
  });

  it("accepts trusted managed runtime discussion labels without dispatching workflows", async () => {
    const client = createClient({ permission: { permission: "write" } });
    const app = createApp({ client });

    await app.handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.readyForApproval.name, node_id: "ready-label-node" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(discussionLabelRemovals(client)).toEqual([]);
    expect(discussionCommentBodies(client)).toEqual([]);
  });
});

describe("GitVibe app server discussion payload variants", () => {
  it("uses camel-case discussion and label node IDs for label removal", async () => {
    const client = createClient({ permission: { permission: "write" } });

    await createApp({ client }).handleWebhook("discussion", {
      action: "labeled",
      discussion: { nodeId: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.validate.name, nodeId: "validate-label-node" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(discussionLabelRemovals(client)).toEqual([
      { discussionId: "discussion-node", labelIds: ["validate-label-node"] },
    ]);
  });
});
