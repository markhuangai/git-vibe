import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isDirectRun, securityReview } from "../src/runner/actions/security-review.ts";

const baseEnv = {
  GITHUB_REPOSITORY: "example/repo",
  GITVIBE_GITHUB_APP_TOKEN: "token",
  GITVIBE_ISSUE_NUMBER: "12",
};

describe("GitVibe security review action", () => {
  it("runs a pre-LLM review, logs output, and writes GitHub outputs", async () => {
    const appendFile = vi.fn();
    const log = vi.fn();
    const runStageSecurityReview = vi.fn().mockResolvedValue({
      allowed: false,
      result: { resultFile: "/tmp/git-vibe-investigate-result.json" },
      status: "blocked",
      summary: "Paused for maintainer review.",
    });

    await expect(
      securityReview({
        appendFile,
        argv: ["investigate"],
        cwd: "/repo",
        env: {
          ...baseEnv,
          GITHUB_OUTPUT: "/tmp/output",
          GITHUB_RUN_ID: "99",
          GITHUB_SERVER_URL: "https://github.enterprise.test",
          GITVIBE_DRY_RUN: "true",
          GITVIBE_HANDOFF_DIR: "/tmp/handoffs",
          GITVIBE_SOURCE_COMMENT: JSON.stringify({
            id: "99",
            kind: "issue-comment",
            nodeId: "IC_99",
            url: "https://github.com/example/repo/issues/12#issuecomment-99",
          }),
          GITVIBE_STAGE_TIMEOUT_MINUTES: "7",
        },
        log,
        runStageSecurityReview,
      }),
    ).resolves.toBe(0);

    expect(runStageSecurityReview).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        handoffDir: "/tmp/handoffs",
        issueNumber: "12",
        maxTurns: 1,
        repository: "example/repo",
        sourceComment: {
          id: "99",
          kind: "issue-comment",
          nodeId: "IC_99",
          url: "https://github.com/example/repo/issues/12#issuecomment-99",
        },
        stage: "investigate",
        stageTimeoutMinutes: 7,
        workflowRunUrl: "https://github.enterprise.test/example/repo/actions/runs/99",
      }),
    );
    expect(log).toHaveBeenCalledWith("investigate security-review status=blocked");
    expect(appendFile.mock.calls.map((call) => call[1])).toEqual([
      "allowed<<GITVIBE_OUTPUT\nfalse\nGITVIBE_OUTPUT\n",
      "summary<<GITVIBE_OUTPUT\nPaused for maintainer review.\nGITVIBE_OUTPUT\n",
      "status<<GITVIBE_OUTPUT\nblocked\nGITVIBE_OUTPUT\n",
      "result-file<<GITVIBE_OUTPUT\n/tmp/git-vibe-investigate-result.json\nGITVIBE_OUTPUT\n",
    ]);
  });
});

describe("GitVibe security review action outputs", () => {
  it("writes allowed outputs without a result file", async () => {
    const appendFile = vi.fn();
    const runStageSecurityReview = vi.fn().mockResolvedValue({
      allowed: true,
      status: "allowed",
      summary: "Security review passed.",
    });

    await expect(
      securityReview({
        appendFile,
        argv: [],
        env: {
          ...baseEnv,
          GITHUB_OUTPUT: "/tmp/output",
          GITVIBE_STAGE: "implement",
        },
        runStageSecurityReview,
      }),
    ).resolves.toBe(0);

    expect(appendFile.mock.calls.map((call) => call[1])).toEqual([
      "allowed<<GITVIBE_OUTPUT\ntrue\nGITVIBE_OUTPUT\n",
      "summary<<GITVIBE_OUTPUT\nSecurity review passed.\nGITVIBE_OUTPUT\n",
      "status<<GITVIBE_OUTPUT\nallowed\nGITVIBE_OUTPUT\n",
    ]);
  });

  it("runs without GitHub output wiring", async () => {
    const appendFile = vi.fn();
    const runStageSecurityReview = vi.fn().mockResolvedValue({
      allowed: true,
      status: "allowed",
      summary: "Security review passed.",
    });

    await expect(
      securityReview({
        appendFile,
        argv: ["validate"],
        env: baseEnv,
        runStageSecurityReview,
      }),
    ).resolves.toBe(0);

    expect(appendFile).not.toHaveBeenCalled();
  });
});

describe("GitVibe security review action validation", () => {
  it("validates required target inputs", async () => {
    const cases = [
      {
        argv: ["address-pr-feedback"],
        env: baseEnv,
        error: "GITVIBE_PR_NUMBER is required for address-pr-feedback.",
      },
      {
        argv: ["investigate"],
        env: { ...baseEnv, GITVIBE_ISSUE_NUMBER: "" },
        error: "GITVIBE_ISSUE_NUMBER or GITVIBE_PR_NUMBER is required for investigate.",
      },
      {
        argv: [],
        env: { ...baseEnv, GITVIBE_ISSUE_NUMBER: "", GITVIBE_STAGE: "materialize" },
        error: "GITVIBE_DISCUSSION_NUMBER is required for this stage.",
      },
      {
        argv: ["validate"],
        env: { ...baseEnv, GITVIBE_ISSUE_NUMBER: "" },
        error: "GITVIBE_ISSUE_NUMBER or GITVIBE_DISCUSSION_NUMBER is required for validate.",
      },
      {
        argv: ["review-matrix"],
        env: { ...baseEnv, GITVIBE_ISSUE_NUMBER: "" },
        error: "GITVIBE_ISSUE_NUMBER or GITVIBE_PR_NUMBER is required for review-matrix.",
      },
      {
        argv: ["create-pr"],
        env: { ...baseEnv, GITVIBE_ISSUE_NUMBER: "" },
        error: "GITVIBE_ISSUE_NUMBER is required for this stage.",
      },
      {
        argv: ["implement"],
        env: { ...baseEnv, GITVIBE_STAGE_TIMEOUT_MINUTES: "0" },
        error: "GITVIBE_STAGE_TIMEOUT_MINUTES must be a positive number.",
      },
      {
        argv: ["missing-stage"],
        env: baseEnv,
        error: "Unknown GitVibe action stage: missing-stage",
      },
      {
        argv: ["implement"],
        env: { GITVIBE_GITHUB_APP_TOKEN: "token", GITVIBE_ISSUE_NUMBER: "1" },
        error: "GITHUB_REPOSITORY is required.",
      },
      {
        argv: ["implement"],
        env: { GITHUB_REPOSITORY: "example/repo", GITVIBE_ISSUE_NUMBER: "1" },
        error:
          "ACTIONS_ID_TOKEN_REQUEST_URL is required. Add permissions: id-token: write to this job.",
      },
    ];

    for (const testCase of cases) {
      const error = vi.fn();
      await expect(
        securityReview({
          argv: testCase.argv,
          env: testCase.env,
          error,
        }),
      ).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(testCase.error);
    }
  });
});

describe("GitVibe security review action entrypoints", () => {
  it("detects direct execution entrypoints", () => {
    expect(isDirectRun("", "/repo/dist/actions/security-review.js")).toBe(true);
    expect(isDirectRun("", "/repo/dist/actions/run-action.js")).toBe(false);
    expect(
      isDirectRun(
        pathToFileURL("/repo/dist/actions/security-review.js").href,
        "/repo/dist/actions/security-review.js",
      ),
    ).toBe(true);
    expect(
      isDirectRun(
        pathToFileURL("/repo/dist/actions/security-review.js").href,
        "/repo/dist/actions/run-action.js",
      ),
    ).toBe(false);
  });
});
