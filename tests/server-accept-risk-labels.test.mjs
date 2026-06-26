// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
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
          stage: "validate",
          submittedAt: "2026-01-02T00:00:00Z",
        }),
      ],
      permission: { role_name: "maintain" },
      workflowRun: workflowRun(".github/workflows/validate.yml@main"),
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
    const updatedResult = requestBodies(client, "PATCH", "/issues/comments/100").at(-1).body;
    expect(updatedResult).toContain("## GitVibe Risk Accepted");
    expect(updatedResult).toContain("### Accepted Risk");
    expect(updatedResult).toContain("git-vibe:accepted-risk-metadata");
    expect(updatedResult).toContain("run=88");
    expect(updatedResult).toContain("run-attempt=2");
    expect(updatedResult).toContain("Accepted workflow run: `88`");
    expect(updatedResult).not.toContain("### Required Fixes");
    expect(updatedResult).not.toContain("Original blocked finding");
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/9/labels/git-vibe%3Aaccept-risk",
    );
    expect(requestBodies(client, "POST", "/issues/9/comments").at(-1).body).toContain(
      "accepted prompt-injection risk",
    );
  });

  it("removes accept-risk without writing metadata when no blocked workflow run is recorded", async () => {
    const client = createClient({
      comments: [
        stageResultComment({
          artifact: "issue",
          number: 9,
          run: "",
          stage: "validate",
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

    expect(workflowDispatches(client)).toEqual([]);
    expect(requestBodies(client, "PATCH", "/issues/comments/100")).toEqual([]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/9/labels/git-vibe%3Aaccept-risk",
    );
    expect(requestBodies(client, "POST", "/issues/9/comments").at(-1).body).toContain(
      "could not safely rerun",
    );
  });
});

describe("GitVibe app server accept-risk run id binding", () => {
  it("binds accepted risk to the trusted blocked run and next attempt", async () => {
    const client = createClient({
      comments: [stageResultComment({ artifact: "issue", number: 9, stage: "validate" })],
      permission: { role_name: "maintain" },
      workflowRun: workflowRun(".github/workflows/validate.yml@main", { run_attempt: 4 }),
    });

    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.acceptRisk.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    const updatedResult = requestBodies(client, "PATCH", "/issues/comments/100").at(-1).body;
    expect(updatedResult).toContain("run=88");
    expect(updatedResult).toContain("run-attempt=5");
    expect(updatedResult).toContain("Accepted workflow run: `88`");
    expect(updatedResult).toContain("Accepted workflow attempt: `5`");
  });

  it("posts the rerun workflow URL from the blocked run details", async () => {
    const client = createClient({
      comments: [stageResultComment({ artifact: "issue", number: 9, stage: "validate" })],
      permission: { role_name: "maintain" },
      workflowRun: workflowRun(".github/workflows/validate.yml@main"),
    });

    await createApp({ client }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.acceptRisk.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestBodies(client, "POST", "/issues/9/comments").at(-1).body).toContain(
      "Workflow run: https://github.com/example/repo/actions/runs/88",
    );
  });
});

describe("GitVibe app server accept-risk rerun-unavailable cleanup", () => {
  it("removes accept-risk without writing metadata when the blocked run cannot be fetched", async () => {
    const client = createClient({
      comments: [stageResultComment({ artifact: "issue", number: 9, stage: "validate" })],
      permission: { role_name: "maintain" },
      workflowRunError: new Error("GitHub API GET /actions/runs/88 failed: 404 {}"),
    });
    const log = vi.fn();

    await createApp({ client, log }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.acceptRisk.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestBodies(client, "PATCH", "/issues/comments/100")).toEqual([]);
    expect(workflowDispatches(client)).toEqual([]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/9/labels/git-vibe%3Aaccept-risk",
    );
    expect(requestBodies(client, "POST", "/issues/9/comments").at(-1).body).toContain(
      "could not safely rerun",
    );
    expect(log).toHaveBeenCalledWith("accepted-risk rerun skipped: workflow run 88 is unavailable");
  });
});

describe("GitVibe app server accept-risk pull request reviews", () => {
  it("resumes blocked pull request reviews from PR review bodies and binds the head SHA", async () => {
    const client = createClient({
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "head-sha",
      pullRequestReviews: [
        stageResultReview({
          artifact: "pull-request",
          authorAssociation: "NONE",
          number: 12,
          stage: "review-matrix",
          submittedAt: "2026-01-02T00:00:00Z",
          user: "gitvibe-for-github[bot]",
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

    expect(requestPaths(client, "POST")).toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(workflowDispatches(client)).toEqual([]);
    const updatedReview = requestBodies(client, "PUT", "/pulls/12/reviews/200").at(-1).body;
    expect(updatedReview).toContain("## GitVibe Risk Accepted");
    expect(updatedReview).toContain("Accepted workflow run: `88`");
    expect(updatedReview).toContain("Pull request head SHA: `head-sha`");
    expect(updatedReview).not.toContain("### Required Fixes");
    expect(updatedReview).not.toContain("Original blocked finding");
    expect(requestPaths(client, "DELETE")).toEqual(
      expect.arrayContaining([
        "/repos/example/repo/issues/12/labels/gvi%3Aready-for-approval",
        "/repos/example/repo/issues/12/labels/gvi%3Ablocked",
        "/repos/example/repo/issues/12/labels/gvi%3Areviewing",
        "/repos/example/repo/issues/12/labels/git-vibe%3Aaccept-risk",
      ]),
    );
    expect(requestBodies(client, "POST", "/issues/12/labels")).toContainEqual({
      labels: ["gvi:reviewing"],
    });
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
            stage: "review-matrix",
            submittedAt: "2026-01-02T00:00:00Z",
          }),
        ],
      ],
      workflowRun: workflowRun(".github/workflows/review.yml@dev", {
        head_branch: "dev",
        head_sha: "head-sha",
      }),
    });

    await createApp({ client }).handleWebhook("pull_request", {
      action: "labeled",
      label: { name: gitVibeLabels.acceptRisk.name },
      pull_request: { head: { sha: "head-sha" }, number: 12 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "POST")).toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(workflowDispatches(client)).toEqual([]);
    expect(requestBodies(client, "PUT", "/pulls/12/reviews/200").at(-1).body).toContain(
      "Accepted stages: `review-matrix`",
    );
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
          stage: "validate",
          submittedAt: "2026-01-05T00:00:00Z",
        }),
        stageResultComment({
          artifact: "issue",
          number: 99,
          stage: "validate",
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
          user: { login: "gitvibe-for-github[bot]" },
        },
        stageResultComment({
          artifact: "issue",
          number: 9,
          stage: "validate",
          submittedAt: "2026-01-03T00:00:00Z",
        }),
      ],
      permission: { role_name: "maintain" },
      workflowRun: workflowRun(".github/workflows/validate.yml@main"),
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
    expect(requestBodies(client, "PATCH", "/issues/comments/100").at(-1).body).toContain(
      "Accepted stages: `validate`",
    );
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
          stage: "validate",
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
      workflowRun: workflowRun(".github/workflows/investigate.yml@main"),
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
    expect(requestBodies(client, "PATCH", "/issues/comments/100").at(-1).body).toContain(
      "Accepted stages: `investigate`",
    );
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
          stage: "review-matrix",
        }),
      ],
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "lookup-sha",
      workflowRun: workflowRun(".github/workflows/review.yml@dev", {
        head_branch: "dev",
        head_sha: "lookup-sha",
      }),
    });

    await createApp({ client }).handleWebhook("pull_request", {
      action: "labeled",
      label: { name: gitVibeLabels.acceptRisk.name },
      pull_request: { number: 12 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "POST")).toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(workflowDispatches(client)).toEqual([]);
    expect(requestBodies(client, "PATCH", "/issues/comments/100").at(-1).body).toContain(
      "Pull request head SHA: `lookup-sha`",
    );
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
      workflowRun: workflowRun(".github/workflows/validate.yml@main"),
    });

    await createApp({ client }).handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.acceptRisk.name, node_id: "accept-risk-label" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "POST")).toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(workflowDispatches(client)).toEqual([]);
    expect(discussionUpdateBodies(client).at(-1)).toContain("Accepted stages: `validate`");
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
      workflowRun: workflowRun(".github/workflows/materialize.yml@main"),
    });

    await createApp({ client }).handleWebhook("discussion", {
      action: "labeled",
      discussion: { node_id: "discussion-node", number: 5 },
      label: { name: gitVibeLabels.acceptRisk.name, node_id: "accept-risk-label" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "POST")).toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(workflowDispatches(client)).toEqual([]);
    expect(discussionUpdateBodies(client).at(-1)).toContain("Accepted stages: `materialize`");
  });
});

describe("GitVibe app server accept-risk label no-op cleanup", () => {
  it("does not trust unassociated actors with git-vibe-like logins", async () => {
    const client = createClient({
      comments: [
        {
          ...stageResultComment({ artifact: "issue", number: 9, stage: "validate" }),
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
          ...stageResultComment({ artifact: "issue", number: 9, stage: "validate" }),
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
  run = "88",
  stage,
  status = "blocked",
  submittedAt = "2026-01-01T00:00:00Z",
}) {
  return {
    author_association: "OWNER",
    body: stageResultBody({ artifact, number, run, stage, status }),
    created_at: submittedAt,
    id: 100,
    user: { login: "maintainer" },
  };
}

function stageResultReview({
  artifact,
  authorAssociation = "OWNER",
  number,
  run = "88",
  stage,
  submittedAt = "2026-01-01T00:00:00Z",
  user = "maintainer",
}) {
  return {
    author_association: authorAssociation,
    body: stageResultBody({ artifact, number, run, stage }),
    id: 200,
    submitted_at: submittedAt,
    user: { login: user },
  };
}

function stageResultBody({ artifact, number, run = "88", stage, status = "blocked" }) {
  const runAttribute = run ? ` run=${run}` : "";
  return [
    `<!-- git-vibe:stage-result stage=${stage} artifact=${artifact} number=${number}${runAttribute} -->`,
    "## GitVibe Result",
    "",
    `**Status:** \`${status}\``,
    "**Next state:** `blocked`",
    "",
    "GitVibe paused this run for maintainer review.",
    "",
    "### Required Fixes",
    "1. Original blocked finding with a very long explanation.",
  ].join("\n");
}

function workflowRun(path, overrides = {}) {
  return {
    head_branch: "main",
    html_url: "https://github.com/example/repo/actions/runs/88",
    path,
    run_attempt: 1,
    url: "https://api.github.com/repos/example/repo/actions/runs/88",
    ...overrides,
  };
}

function discussionUpdateBodies(client) {
  return client.graphql.mock.calls
    .filter(([query]) => query.includes("GitVibeUpdateDiscussionComment"))
    .map(([, variables]) => variables.body);
}
