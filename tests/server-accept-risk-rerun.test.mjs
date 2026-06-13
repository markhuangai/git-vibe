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
        html_url: "https://github.com/example/repo/actions/runs/88",
        path: ".github/workflows/review.yml@dev",
        run_attempt: 2,
        url: "https://api.github.com/repos/example/repo/actions/runs/88",
      },
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

  it("dispatches review when the blocked result came from a different workflow", async () => {
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

    await createApp({ client, log }).handleWebhook("pull_request", {
      action: "labeled",
      label: { name: gitVibeLabels.acceptRisk.name },
      pull_request: { head: { sha: "head-sha" }, number: 12 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "POST")).not.toContain("/repos/example/repo/actions/runs/88/rerun");
    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({ inputs: { "pr-number": "12" } }),
    ]);
    expect(log).toHaveBeenCalledWith(
      "accepted-risk rerun skipped: workflow run 88 does not match review.yml",
    );
  });
});

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
