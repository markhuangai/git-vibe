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

describe("GitVibe app server accept-risk labels", () => {
  it("resumes the latest blocked issue stage with one-run accepted risk", async () => {
    const client = createClient({
      comments: [
        stageResultComment({
          artifact: "issue",
          number: 9,
          stage: "implement",
          submittedAt: "2026-01-02T00:00:00Z",
        }),
      ],
      permission: { role_name: "maintain" },
    });

    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.acceptRisk.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: expect.objectContaining({
          "accept-risk": "true",
          "accept-risk-actor": "maintainer",
          "accept-risk-stage": "implement,create-pr",
          "issue-number": "9",
        }),
        ref: "main",
      }),
    ]);
    expect(requestPaths(client, "DELETE")).not.toContain(
      "/repos/example/repo/issues/9/labels/git-vibe%3Aaccept-risk",
    );
    expect(requestBodies(client, "POST", "/issues/9/comments").at(-1).body).toContain(
      "accepted prompt-injection risk",
    );
  });

  it("resumes blocked pull request reviews from PR review bodies and binds the head SHA", async () => {
    const client = createClient({
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "head-sha",
      pullRequestReviews: [
        stageResultReview({
          artifact: "pull-request",
          number: 12,
          stage: "review-matrix",
          submittedAt: "2026-01-02T00:00:00Z",
        }),
      ],
    });

    await createApp({ client }).handleWebhook("pull_request", {
      action: "labeled",
      label: { name: gitVibeLabels.acceptRisk.name },
      pull_request: { head: { sha: "head-sha" }, number: 12 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: expect.objectContaining({
          "accept-risk": "true",
          "accept-risk-actor": "maintainer",
          "accept-risk-artifact-sha": "head-sha",
          "accept-risk-stage": "review-matrix",
          "pr-number": "12",
        }),
      }),
    ]);
  });
});

describe("GitVibe app server accept-risk pull request review pagination", () => {
  it("paginates pull request reviews before selecting the latest blocked result", async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      stageResultReview({
        artifact: "pull-request",
        number: 12,
        stage: "review-matrix",
        submittedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      }),
    );
    const client = createClient({
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "head-sha",
      pullRequestReviewPages: [
        pageOne,
        [
          stageResultReview({
            artifact: "pull-request",
            number: 12,
            stage: "address-pr-feedback",
            submittedAt: "2026-01-02T00:00:00Z",
          }),
        ],
      ],
    });

    await createApp({ client }).handleWebhook("pull_request", {
      action: "labeled",
      label: { name: gitVibeLabels.acceptRisk.name },
      pull_request: { head: { sha: "head-sha" }, number: 12 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)[0].inputs).toMatchObject({
      "accept-risk-stage": "investigate,address-pr-feedback",
      "pr-number": "12",
    });
    expect(requestPaths(client, "GET")).toEqual(
      expect.arrayContaining([
        "/repos/example/repo/pulls/12/reviews?page=1&per_page=100",
        "/repos/example/repo/pulls/12/reviews?page=2&per_page=100",
      ]),
    );
  });
});

describe("GitVibe app server accept-risk label result selection", () => {
  it("uses the latest trusted blocked result and ignores invalid candidates", async () => {
    const client = createClient({
      comments: [
        stageResultComment({
          artifact: "issue",
          number: 99,
          stage: "implement",
          submittedAt: "2026-01-05T00:00:00Z",
        }),
        stageResultComment({
          artifact: "issue",
          number: 99,
          stage: "implement",
          status: "completed",
          submittedAt: "2026-01-06T00:00:00Z",
        }),
        stageResultComment({
          artifact: "issue",
          number: 9,
          stage: "investigate",
          submittedAt: "2026-01-02T00:00:00Z",
        }),
        {
          ...stageResultComment({
            artifact: "issue",
            number: 9,
            stage: "validate",
            submittedAt: "2026-01-03T00:00:00Z",
          }),
          author_association: "NONE",
          user: { login: "github-actions[bot]" },
        },
        stageResultComment({
          artifact: "issue",
          number: 9,
          stage: "implement",
          submittedAt: "2026-01-03T00:00:00Z",
        }),
      ],
      permission: { role_name: "maintain" },
    });

    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.acceptRisk.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: expect.objectContaining({
          "accept-risk-stage": "implement,create-pr",
          "issue-number": "9",
        }),
      }),
    ]);
  });

  it("removes accept-risk when the blocked stage cannot resume from the artifact", async () => {
    const client = createClient({
      comments: [stageResultComment({ artifact: "issue", number: 9, stage: "materialize" })],
      permission: { role_name: "maintain" },
    });

    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.acceptRisk.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/9/labels/git-vibe%3Aaccept-risk",
    );
    expect(requestBodies(client, "POST", "/issues/9/comments").at(-1).body).toContain(
      "cannot be resumed",
    );
  });
});

describe("GitVibe app server accept-risk stage result ordering", () => {
  it("removes accept-risk when the latest trusted stage result is no longer blocked", async () => {
    const client = createClient({
      comments: [
        stageResultComment({
          artifact: "issue",
          number: 9,
          stage: "investigate",
          submittedAt: "2026-01-02T00:00:00Z",
        }),
        stageResultComment({
          artifact: "issue",
          number: 9,
          stage: "implement",
          status: "completed",
          submittedAt: "2026-01-03T00:00:00Z",
        }),
      ],
      permission: { role_name: "maintain" },
    });

    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.acceptRisk.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/9/labels/git-vibe%3Aaccept-risk",
    );
    expect(requestBodies(client, "POST", "/issues/9/comments").at(-1).body).toContain(
      "no valid blocked GitVibe stage result",
    );
  });
});

describe("GitVibe app server accept-risk label stage routing", () => {
  it("resumes blocked issue investigation stages", async () => {
    const client = createClient({
      comments: [stageResultComment({ artifact: "issue", number: 9, stage: "investigate" })],
      permission: { role_name: "maintain" },
    });

    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.acceptRisk.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "POST")).toContain(
      "/repos/example/repo/actions/workflows/investigate.yml/dispatches",
    );
    expect(workflowDispatches(client)[0].inputs).toMatchObject({
      "accept-risk-stage": "investigate",
      "issue-number": "9",
    });
  });

  it("removes accept-risk when pull request blocked stages are not resumable", async () => {
    const client = createClient({
      comments: [stageResultComment({ artifact: "pull-request", number: 12, stage: "validate" })],
      permission: { role_name: "maintain" },
    });

    await createApp({ client }).handleWebhook("pull_request", {
      action: "labeled",
      label: { name: gitVibeLabels.acceptRisk.name },
      pull_request: { number: 12 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestBodies(client, "POST", "/issues/12/comments").at(-1).body).toContain(
      "cannot be resumed",
    );
  });

  it("removes accept-risk when discussion blocked stages are not resumable", async () => {
    const client = createClient({
      discussionComments: [
        {
          author: { login: "maintainer" },
          authorAssociation: "OWNER",
          body: stageResultBody({ artifact: "discussion", number: 5, stage: "investigate" }),
          createdAt: "2026-01-02T00:00:00Z",
          id: "discussion-comment",
          url: "https://github.com/example/repo/discussions/5#discussioncomment-1",
        },
      ],
      permission: { role_name: "maintain" },
    });

    await createApp({ client }).handleWebhook("discussion", {
      action: "labeled",
      discussion: { id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.acceptRisk.name, node_id: "accept-risk-label" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(discussionLabelRemovals(client)).toEqual([
      { discussionId: "discussion-node", labelIds: ["accept-risk-label"] },
    ]);
    expect(discussionCommentBodies(client).at(-1)).toContain("cannot be resumed");
  });
});

describe("GitVibe app server accept-risk pull request labels", () => {
  it("falls back to pull request lookup when the labeled payload has no head SHA", async () => {
    const client = createClient({
      comments: [
        stageResultComment({
          artifact: "pull-request",
          number: 12,
          stage: "address-pr-feedback",
        }),
      ],
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "lookup-sha",
    });

    await createApp({ client }).handleWebhook("pull_request", {
      action: "labeled",
      label: { name: gitVibeLabels.acceptRisk.name },
      pull_request: { number: 12 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: expect.objectContaining({
          "accept-risk-artifact-sha": "lookup-sha",
          "accept-risk-stage": "investigate,address-pr-feedback",
          "pr-number": "12",
        }),
      }),
    ]);
    expect(requestPaths(client, "GET")).toContain("/repos/example/repo/pulls/12");
  });
});

describe("GitVibe app server accept-risk label validation", () => {
  it("resumes blocked discussion stages", async () => {
    const client = createClient({
      discussionComments: [
        {
          author: { login: "maintainer" },
          authorAssociation: "OWNER",
          body: stageResultBody({ artifact: "discussion", number: 5, stage: "validate" }),
          createdAt: "2026-01-02T00:00:00Z",
          id: "discussion-comment",
          url: "https://github.com/example/repo/discussions/5#discussioncomment-1",
        },
      ],
      permission: { role_name: "maintain" },
    });

    await createApp({ client }).handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.acceptRisk.name, node_id: "accept-risk-label" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: expect.objectContaining({
          "accept-risk": "true",
          "accept-risk-actor": "maintainer",
          "accept-risk-stage": "validate",
          "discussion-number": "5",
        }),
      }),
    ]);
  });

  it("resumes blocked discussion materialization", async () => {
    const client = createClient({
      discussionComments: [
        {
          author: { login: "maintainer" },
          authorAssociation: "MEMBER",
          body: stageResultBody({ artifact: "discussion", number: 5, stage: "materialize" }),
          createdAt: "2026-01-02T00:00:00Z",
          id: "discussion-comment",
          url: "https://github.com/example/repo/discussions/5#discussioncomment-1",
        },
      ],
      permission: { role_name: "maintain" },
    });

    await createApp({ client }).handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.acceptRisk.name, node_id: "accept-risk-label" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: expect.objectContaining({
          "accept-risk-stage": "materialize",
          "discussion-number": "5",
        }),
      }),
    ]);
  });
});

describe("GitVibe app server accept-risk label no-op cleanup", () => {
  it("does not trust unassociated actors with git-vibe-like logins", async () => {
    const client = createClient({
      comments: [
        {
          ...stageResultComment({ artifact: "issue", number: 9, stage: "implement" }),
          author_association: "NONE",
          user: { login: "external-git-vibe-helper" },
        },
      ],
      permission: { role_name: "maintain" },
    });

    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.acceptRisk.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/9/labels/git-vibe%3Aaccept-risk",
    );
    expect(requestBodies(client, "POST", "/issues/9/comments").at(-1).body).toContain(
      "no valid blocked GitVibe stage result",
    );
  });

  it("removes accept-risk without dispatching when no trusted blocked result exists", async () => {
    const client = createClient({
      comments: [
        {
          ...stageResultComment({ artifact: "issue", number: 9, stage: "implement" }),
          author_association: "NONE",
        },
      ],
      permission: { role_name: "maintain" },
    });

    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.acceptRisk.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/9/labels/git-vibe%3Aaccept-risk",
    );
    expect(requestBodies(client, "POST", "/issues/9/comments").at(-1).body).toContain(
      "no valid blocked GitVibe stage result",
    );
  });

  it("removes discussion accept-risk labels without dispatching when no blocked result exists", async () => {
    const client = createClient({ permission: { role_name: "maintain" } });

    await createApp({ client }).handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.acceptRisk.name, node_id: "accept-risk-label" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "DELETE")).toEqual([]);
    expect(requestBodies(client, "POST", "/issues/5/comments")).toEqual([]);
    expect(discussionLabelRemovals(client)).toEqual([
      { discussionId: "discussion-node", labelIds: ["accept-risk-label"] },
    ]);
    expect(discussionCommentBodies(client).at(-1)).toContain(
      "no valid blocked GitVibe stage result",
    );
  });
});

function stageResultComment({
  artifact,
  number,
  stage,
  status = "blocked",
  submittedAt = "2026-01-01T00:00:00Z",
}) {
  return {
    author_association: "OWNER",
    body: stageResultBody({ artifact, number, stage, status }),
    created_at: submittedAt,
    id: 100,
    user: { login: "maintainer" },
  };
}

function stageResultReview({ artifact, number, stage, submittedAt = "2026-01-01T00:00:00Z" }) {
  return {
    author_association: "OWNER",
    body: stageResultBody({ artifact, number, stage }),
    submitted_at: submittedAt,
    user: { login: "maintainer" },
  };
}

function stageResultBody({ artifact, number, stage, status = "blocked" }) {
  return [
    `<!-- git-vibe:stage-result stage=${stage} artifact=${artifact} number=${number} -->`,
    "## GitVibe Result",
    "",
    `**Status:** \`${status}\``,
    "**Next state:** `blocked`",
    "",
    "GitVibe paused this run for maintainer review.",
  ].join("\n");
}
