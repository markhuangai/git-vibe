// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { gitVibeLabels } from "../src/shared/labels.ts";
import {
  createApp,
  createClient,
  repositoryPayload,
  requestBodies,
  requestPaths,
  workflowDispatches,
} from "./support/server-app.mjs";

describe("GitVibe app server accept-risk run-bound metadata sources", () => {
  it("routes issue validation accept-risk reruns", async () => {
    const client = createClient({
      comments: [stageResultComment({ stage: "validate" })],
      permission: { role_name: "maintain" },
      workflowRun: {
        head_branch: "main",
        html_url: "https://github.com/example/repo/actions/runs/88",
        path: ".github/workflows/validate.yml@main",
        run_attempt: 1,
        url: "https://api.github.com/repos/example/repo/actions/runs/88",
      },
    });

    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.acceptRisk.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "POST")).toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(workflowDispatches(client)).toEqual([]);
  });

  it("uses pull request payload title and body when binding accepted risk", async () => {
    const client = createClient({
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "payload-sha",
      pullRequestReviews: [stageResultReview()],
    });

    await createApp({ client }).handleWebhook("pull_request", {
      action: "labeled",
      label: { name: gitVibeLabels.acceptRisk.name },
      pull_request: {
        body: "Payload PR body",
        head: { sha: "payload-sha" },
        number: 12,
        title: "Payload PR title",
      },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "GET")).not.toContain("/repos/example/repo/pulls/12");
    expect(requestBodies(client, "PUT", "/pulls/12/reviews/200").at(-1).body).toContain(
      "Pull request head SHA: `payload-sha`",
    );
  });

  it("uses discussion payload title and body when binding accepted risk", async () => {
    const client = createClient({
      discussionComments: [discussionStageResultComment()],
      permission: { role_name: "maintain" },
      workflowRun: {
        head_branch: "main",
        html_url: "https://github.com/example/repo/actions/runs/88",
        path: ".github/workflows/validate.yml@main",
        run_attempt: 1,
        url: "https://api.github.com/repos/example/repo/actions/runs/88",
      },
    });

    await createApp({ client }).handleWebhook("discussion", {
      action: "labeled",
      discussion: {
        body: "Payload discussion body",
        node_id: "discussion-node",
        number: 5,
        title: "Payload discussion title",
      },
      label: { name: gitVibeLabels.acceptRisk.name, node_id: "accept-risk-label" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "POST")).toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(workflowDispatches(client)).toEqual([]);
    expect(discussionUpdateBodies(client).at(-1)).toContain("Accepted stages: `validate`");
  });
});

describe("GitVibe app server accept-risk run-bound metadata failures", () => {
  it("removes accept-risk when run-bound metadata cannot be recorded", async () => {
    const client = createClient({
      comments: [stageResultComment()],
      issuePatchError: new Error("patch unavailable"),
      permission: { role_name: "maintain" },
      workflowRun: {
        head_branch: "main",
        html_url: "https://github.com/example/repo/actions/runs/88",
        path: ".github/workflows/validate.yml@main",
        run_attempt: 1,
        url: "https://api.github.com/repos/example/repo/actions/runs/88",
      },
    });
    const log = vi.fn();

    await createApp({ client, log }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.acceptRisk.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "POST")).not.toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/9/labels/git-vibe%3Aaccept-risk",
    );
    expect(requestBodies(client, "POST", "/issues/9/comments").at(-1).body).toContain(
      "could not record run-bound accepted-risk metadata",
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("patch unavailable"));
  });
});

function stageResultComment({ stage = "validate" } = {}) {
  return {
    author_association: "OWNER",
    body: stageResultBody({ artifact: "issue", number: 9, stage }),
    created_at: "2026-01-02T00:00:00Z",
    id: 100,
    user: { login: "maintainer" },
  };
}

function stageResultReview() {
  return {
    author_association: "OWNER",
    body: stageResultBody({ artifact: "pull-request", number: 12, stage: "review-matrix" }),
    id: 200,
    submitted_at: "2026-01-02T00:00:00Z",
    user: { login: "maintainer" },
  };
}

function discussionStageResultComment() {
  return {
    author: { login: "maintainer" },
    authorAssociation: "OWNER",
    body: stageResultBody({ artifact: "discussion", number: 5, stage: "validate" }),
    createdAt: "2026-01-02T00:00:00Z",
    id: "discussion-comment",
    url: "https://github.com/example/repo/discussions/5#discussioncomment-1",
  };
}

function stageResultBody({ artifact, number, stage }) {
  return [
    `<!-- git-vibe:stage-result stage=${stage} artifact=${artifact} number=${number} run=88 -->`,
    "## GitVibe Result",
    "",
    "**Status:** `blocked`",
    "**Next state:** `blocked`",
    "",
    "GitVibe paused this run for maintainer review.",
  ].join("\n");
}

function discussionUpdateBodies(client) {
  return client.graphql.mock.calls
    .filter(([query]) => query.includes("GitVibeUpdateDiscussionComment"))
    .map(([, variables]) => variables.body);
}
