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

describe("GitVibe app server accept-risk pull request reruns", () => {
  it("reruns blocked pull request review workflows and binds the next run attempt", async () => {
    const client = createClient({
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "head-sha",
      pullRequestReviews: [stageResultReview({ run: "88" })],
      workflowRun: {
        head_branch: "dev",
        head_sha: "head-sha",
        html_url: "https://github.com/example/repo/actions/runs/88",
        path: ".github/workflows/review.yml@dev",
        run_attempt: 2,
        url: "https://api.github.com/repos/example/repo/actions/runs/88",
      },
    });

    await createApp({ client }).handleWebhook("pull_request", acceptRiskPullRequestPayload());

    expect(requestPaths(client, "POST")).toContain("/repos/example/repo/actions/runs/88/rerun");
    expectMetadataUpdateBeforeRerun(client);
    expect(workflowDispatches(client)).toEqual([]);
    const updatedResult = requestBodies(client, "PUT", "/pulls/12/reviews/200").at(-1).body;
    expect(updatedResult).toContain("run=88");
    expect(updatedResult).toContain("run-attempt=3");
    expect(updatedResult).toContain("Accepted workflow attempt: `3`");
    expect(requestBodies(client, "POST", "/issues/12/comments").at(-1).body).toContain(
      "Workflow run: https://github.com/example/repo/actions/runs/88",
    );
    expect(requestBodies(client, "POST", "/issues/12/labels")).toContainEqual({
      labels: ["gvi:reviewing"],
    });
  });

  it("reruns blocked automatic pull request review wrapper workflows", async () => {
    const client = createClient({
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "head-sha",
      pullRequestReviews: [stageResultReview({ run: "88" })],
      workflowRun: {
        head_branch: "dev",
        head_sha: "head-sha",
        html_url: "https://github.com/example/repo/actions/runs/88",
        path: ".github/workflows/automatic-pr-review.yml@refs/heads/dev",
        run_attempt: 1,
        url: "https://api.github.com/repos/example/repo/actions/runs/88",
      },
    });

    await createApp({ client }).handleWebhook("pull_request", acceptRiskPullRequestPayload());

    expect(requestPaths(client, "POST")).toContain("/repos/example/repo/actions/runs/88/rerun");
    expectMetadataUpdateBeforeRerun(client);
    expect(workflowDispatches(client)).toEqual([]);
    const updatedResult = requestBodies(client, "PUT", "/pulls/12/reviews/200").at(-1).body;
    expect(updatedResult).toContain("run=88");
    expect(updatedResult).toContain("run-attempt=2");
  });
});

describe("GitVibe app server accept-risk pull request rerun unavailable", () => {
  it("removes accept-risk when the blocked result came from a different workflow", async () => {
    const log = vi.fn();
    const client = createClient({
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "head-sha",
      pullRequestReviews: [stageResultReview({ run: "88" })],
      workflowRun: {
        head_branch: "dev",
        html_url: "https://github.com/example/repo/actions/runs/88",
        path: ".github/workflows/develop.yml@dev",
        run_attempt: 2,
      },
    });

    await createApp({ client, log }).handleWebhook("pull_request", acceptRiskPullRequestPayload());

    expect(requestPaths(client, "POST")).not.toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(workflowDispatches(client)).toEqual([]);
    expect(requestBodies(client, "PUT", "/pulls/12/reviews/200")).toEqual([]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/12/labels/git-vibe%3Aaccept-risk",
    );
    expect(requestBodies(client, "POST", "/issues/12/comments").at(-1).body).toContain(
      "could not safely rerun",
    );
    expect(log).toHaveBeenCalledWith(
      "accepted-risk rerun skipped: workflow run 88 does not match review.yml",
    );
  });

  it("removes accept-risk when the prior workflow run is unavailable", async () => {
    const log = vi.fn();
    const client = createClient({
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "head-sha",
      pullRequestReviews: [stageResultReview({ run: "88" })],
      workflowRunError: new Error("GitHub API GET /actions/runs/88 failed: 404 {}"),
    });

    await createApp({ client, log }).handleWebhook("pull_request", acceptRiskPullRequestPayload());

    expect(requestPaths(client, "POST")).not.toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(workflowDispatches(client)).toEqual([]);
    expect(requestBodies(client, "PUT", "/pulls/12/reviews/200")).toEqual([]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/12/labels/git-vibe%3Aaccept-risk",
    );
    expect(requestBodies(client, "POST", "/issues/12/comments").at(-1).body).toContain(
      "could not safely rerun",
    );
    expect(log).toHaveBeenCalledWith("accepted-risk rerun skipped: workflow run 88 is unavailable");
  });
});

describe("GitVibe app server accept-risk pull request rerun SHA checks", () => {
  it("removes accept-risk when the prior workflow run head SHA differs", async () => {
    const log = vi.fn();
    const client = createClient({
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "head-sha",
      pullRequestReviews: [stageResultReview({ run: "88" })],
      workflowRun: {
        head_branch: "dev",
        head_sha: "old-sha",
        html_url: "https://github.com/example/repo/actions/runs/88",
        path: ".github/workflows/review.yml@dev",
        run_attempt: 2,
      },
    });

    await createApp({ client, log }).handleWebhook("pull_request", acceptRiskPullRequestPayload());

    expect(requestPaths(client, "POST")).not.toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(workflowDispatches(client)).toEqual([]);
    expect(requestBodies(client, "PUT", "/pulls/12/reviews/200")).toEqual([]);
    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/12/labels/git-vibe%3Aaccept-risk",
    );
    expect(requestBodies(client, "POST", "/issues/12/comments").at(-1).body).toContain(
      "could not safely rerun",
    );
    expect(log).toHaveBeenCalledWith(
      "accepted-risk rerun skipped: workflow run 88 head SHA does not match",
    );
  });
});

describe("GitVibe app server accept-risk pull request rerun failures", () => {
  it("does not dispatch review when workflow run lookup fails unexpectedly", async () => {
    const client = createClient({
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "head-sha",
      pullRequestReviews: [stageResultReview({ run: "404" })],
      workflowRunError: new Error("GitHub API GET /actions/runs/404 failed: 403 {}"),
    });

    await expect(
      createApp({ client }).handleWebhook("pull_request", acceptRiskPullRequestPayload()),
    ).rejects.toThrow("403");

    expect(requestPaths(client, "POST")).not.toContain(
      "/repos/example/repo/actions/runs/404/rerun",
    );
    expect(workflowDispatches(client)).toEqual([]);
  });

  it("does not dispatch review when rerun request fails", async () => {
    const client = createClient({
      permission: { role_name: "maintain" },
      pullRequestHeadSha: "head-sha",
      pullRequestReviews: [stageResultReview({ run: "88" })],
      workflowRerunError: new Error("GitHub API POST /actions/runs/88/rerun failed: 403 {}"),
    });

    await expect(
      createApp({ client }).handleWebhook("pull_request", acceptRiskPullRequestPayload()),
    ).rejects.toThrow("403");

    expect(requestPaths(client, "POST")).toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(workflowDispatches(client)).toEqual([]);
  });
});

function acceptRiskPullRequestPayload() {
  return {
    action: "labeled",
    label: { name: gitVibeLabels.acceptRisk.name },
    pull_request: { head: { sha: "head-sha" }, number: 12 },
    repository: repositoryPayload(),
    sender: { login: "maintainer" },
  };
}

function expectMetadataUpdateBeforeRerun(client) {
  const calls = client.request.mock.calls.map(([request]) => request);
  const metadataIndex = calls.findIndex(
    (request) => request.method === "PUT" && request.path.includes("/pulls/12/reviews/200"),
  );
  const rerunIndex = calls.findIndex(
    (request) => request.method === "POST" && request.path.endsWith("/actions/runs/88/rerun"),
  );
  expect(metadataIndex).toBeGreaterThan(-1);
  expect(rerunIndex).toBeGreaterThan(-1);
  expect(metadataIndex).toBeLessThan(rerunIndex);
}

function stageResultReview({ run }) {
  return {
    author_association: "OWNER",
    body: stageResultBody({ run }),
    id: 200,
    submitted_at: "2026-01-01T00:00:00Z",
    user: { login: "maintainer" },
  };
}

function stageResultBody({ run }) {
  return [
    `<!-- git-vibe:stage-result stage=review-matrix artifact=pull-request number=12 run=${run} -->`,
    "## GitVibe Result",
    "",
    "**Status:** `blocked`",
    "**Next state:** `blocked`",
    "",
    "GitVibe paused this run for maintainer review.",
  ].join("\n");
}
