import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isDirectRun, runAction } from "../src/runner/actions/run-action.ts";

const baseEnv = {
  GITHUB_REPOSITORY: "example/repo",
  GITVIBE_GITHUB_APP_TOKEN: "token",
  GITVIBE_ISSUE_NUMBER: "12",
};

describe("GitVibe action launcher", () => {
  it("runs a stage, logs output, and writes GitHub outputs", async () => {
    const appendFile = vi.fn();
    const log = vi.fn();
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "Long body",
      parsedOutput: {
        blocking_questions: [],
        implementation_plan: ["Implement the verified change."],
        next_state: "ready-for-implementation",
      },
      resultFile: "/tmp/git-vibe-investigate-result.json",
      schemaId: "investigate.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });

    await expect(
      runAction({
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
          GITVIBE_MAX_TURNS: "12",
          GITVIBE_SOURCE_COMMENT: JSON.stringify({
            id: "99",
            kind: "issue-comment",
            nodeId: "IC_99",
            url: "https://github.com/example/repo/issues/12#issuecomment-99",
          }),
          GITVIBE_STAGE_TIMEOUT_MINUTES: "34",
        },
        log,
        runStage,
      }),
    ).resolves.toBe(0);

    expect(runStage).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        handoffDir: "/tmp/handoffs",
        issueNumber: "12",
        maxTurns: 12,
        repository: "example/repo",
        sourceComment: {
          id: "99",
          kind: "issue-comment",
          nodeId: "IC_99",
          url: "https://github.com/example/repo/issues/12#issuecomment-99",
        },
        stage: "investigate",
        stageTimeoutMinutes: 34,
        validationRepairAttempts: 3,
        validationRepairMaxTurns: 45,
        workflowRunUrl: "https://github.enterprise.test/example/repo/actions/runs/99",
      }),
    );
    expect(log).toHaveBeenCalledWith("investigate status=completed");
    expect(appendFile.mock.calls.map((call) => call[1])).toEqual([
      "summary<<GITVIBE_OUTPUT\nDone\nGITVIBE_OUTPUT\n",
      "status<<GITVIBE_OUTPUT\ncompleted\nGITVIBE_OUTPUT\n",
      "comment-body<<GITVIBE_OUTPUT\nLong body\nGITVIBE_OUTPUT\n",
      "next-state<<GITVIBE_OUTPUT\nready-for-implementation\nGITVIBE_OUTPUT\n",
      "ready-for-implementation<<GITVIBE_OUTPUT\ntrue\nGITVIBE_OUTPUT\n",
      "result-file<<GITVIBE_OUTPUT\n/tmp/git-vibe-investigate-result.json\nGITVIBE_OUTPUT\n",
    ]);
  });
});

describe("GitVibe action launcher hosted auth", () => {
  it("requests hosted App tokens with the stage permission profile", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: "oidc-token" }))
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token" }));
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "",
      parsedOutput: {},
      schemaId: "review-matrix.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });

    await expect(
      runAction({
        argv: ["review-matrix"],
        env: {
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test/id",
          GITHUB_REPOSITORY: "example/repo",
          GITVIBE_ACTIONS_TOKEN_URL: "https://git-vibe.example/actions/token",
          GITVIBE_ISSUE_NUMBER: "12",
        },
        fetch: fetchImpl,
        runStage,
      }),
    ).resolves.toBe(0);

    expect(fetchImpl.mock.calls[1]).toMatchObject([
      "https://git-vibe.example/actions/token",
      {
        body: JSON.stringify({
          oidcToken: "oidc-token",
          permissionProfile: "runner-workflow-write",
        }),
        method: "POST",
      },
    ]);
    expect(runStage).toHaveBeenCalledWith(expect.objectContaining({ token: "installation-token" }));
  });
});

describe("GitVibe create-pr action outputs", () => {
  it("writes pull request outputs for create-pr", async () => {
    const appendFile = vi.fn();
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "PR body",
      parsedOutput: {
        next_state: "pr-draft-ready",
        pr_number: "22",
        pr_url: "https://github.com/example/repo/pull/22",
      },
      schemaId: "create-pr.v1",
      status: "completed",
      summary: "Created PR",
      validationErrors: [],
    });

    await expect(
      runAction({
        appendFile,
        argv: ["create-pr"],
        cwd: "/repo",
        env: { ...baseEnv, GITHUB_OUTPUT: "/tmp/output" },
        runStage,
      }),
    ).resolves.toBe(0);

    expect(appendFile.mock.calls.map((call) => call[1])).toEqual([
      "summary<<GITVIBE_OUTPUT\nCreated PR\nGITVIBE_OUTPUT\n",
      "status<<GITVIBE_OUTPUT\ncompleted\nGITVIBE_OUTPUT\n",
      "comment-body<<GITVIBE_OUTPUT\nPR body\nGITVIBE_OUTPUT\n",
      "next-state<<GITVIBE_OUTPUT\npr-draft-ready\nGITVIBE_OUTPUT\n",
      "pr-number<<GITVIBE_OUTPUT\n22\nGITVIBE_OUTPUT\n",
      "pr-url<<GITVIBE_OUTPUT\nhttps://github.com/example/repo/pull/22\nGITVIBE_OUTPUT\n",
    ]);
  });
});

function roleGroupWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), "git-vibe-run-action-"));
  mkdirSync(join(cwd, ".github"), { recursive: true });
  mkdirSync(join(cwd, ".git-vibe", "role-group"), { recursive: true });
  writeFileSync(
    join(cwd, ".github", "git-vibe.yml"),
    [
      "ai:",
      "  profiles:",
      "    local_proxy: {}",
      "    codex_cli: {}",
      "  role_groups:",
      "    review_gate:",
      "      synthesizer: local_proxy",
      "      roles:",
      "        - role: security.md",
      "          profile: local_proxy",
      "        - role: maintainability.md",
      "          profile: codex_cli",
      "  stages:",
      "    validate:",
      "      role_group: review_gate",
    ].join("\n"),
  );
  writeFileSync(join(cwd, ".git-vibe", "role-group", "security.md"), "Review security.");
  writeFileSync(
    join(cwd, ".git-vibe", "role-group", "maintainability.md"),
    "Review maintainability.",
  );
  return cwd;
}

/**
 * @param {unknown} body
 * @param {number} [status]
 */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe("GitVibe action launcher investigation readiness", () => {
  it("fails an investigation action when not-ready gating is enabled", async () => {
    const error = vi.fn();
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "Long body",
      parsedOutput: {
        blocking_questions: ["Choose a config key."],
        implementation_plan: [],
        next_state: "needs-info",
      },
      schemaId: "investigate.v1",
      status: "completed",
      summary: "Needs info",
      validationErrors: [],
    });

    await expect(
      runAction({
        argv: ["investigate"],
        env: {
          ...baseEnv,
          GITVIBE_FAIL_ON_NOT_READY: "true",
        },
        error,
        runStage,
      }),
    ).resolves.toBe(1);

    expect(error).toHaveBeenCalledWith(
      "investigate is not ready for implementation; stopping workflow.",
    );
  });
});

describe("GitVibe action launcher validation", () => {
  it("validates required env and common inputs", async () => {
    const error = vi.fn();
    await expect(runAction({ argv: ["investigate"], env: {}, error })).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "ACTIONS_ID_TOKEN_REQUEST_URL is required. Add permissions: id-token: write to this job.",
    );

    await expect(
      runAction({
        argv: ["materialize"],
        env: baseEnv,
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITVIBE_DISCUSSION_NUMBER is required for this stage.");

    await expect(
      runAction({
        argv: ["materialize"],
        env: baseEnv,
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITVIBE_DISCUSSION_NUMBER is required for this stage.");

    await expect(
      runAction({
        argv: ["validate"],
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITVIBE_GITHUB_APP_TOKEN: "token",
          GITVIBE_MAX_TURNS: "0",
          GITVIBE_ISSUE_NUMBER: "1",
        },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITVIBE_MAX_TURNS must be a positive number.");

    await expect(
      runAction({
        argv: ["investigate"],
        env: { GITVIBE_GITHUB_APP_TOKEN: "token", GITVIBE_ISSUE_NUMBER: "1" },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITHUB_REPOSITORY is required.");

    await expect(
      runAction({
        argv: ["missing-stage"],
        env: baseEnv,
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("Unknown GitVibe action stage: missing-stage");
  });
});

describe("GitVibe action launcher execution mode validation", () => {
  it("validates member and finalizer execution mode inputs", async () => {
    const error = vi.fn();

    await expect(
      runAction({
        argv: ["investigate"],
        env: { ...baseEnv, GITVIBE_EXECUTION_MODE: "parallel" },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "GITVIBE_EXECUTION_MODE must be standard, member, or finalizer.",
    );

    await expect(
      runAction({
        argv: ["investigate"],
        env: { ...baseEnv, GITVIBE_EXECUTION_MODE: "member" },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "GITVIBE_PROFILE_NAME or GITVIBE_MEMBER_INDEX is required for member execution.",
    );
  });
});

describe("GitVibe action launcher member routing", () => {
  it("derives the finalizer member result directory from the stage", async () => {
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "Validated",
      parsedOutput: {},
      schemaId: "validate.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });

    await expect(
      runAction({
        argv: ["validate"],
        cwd: "/repo",
        env: {
          ...baseEnv,
          GITVIBE_EXECUTION_MODE: "finalizer",
          RUNNER_TEMP: "/tmp/git-vibe-runner",
        },
        runStage,
      }),
    ).resolves.toBe(0);

    expect(runStage).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "finalizer",
        memberResultsDir: join("/tmp/git-vibe-runner", "git-vibe-validate-members"),
      }),
    );
  });

  it("resolves member profile and role from the configured matrix index", async () => {
    const cwd = roleGroupWorkspace();
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "Validated",
      parsedOutput: {},
      schemaId: "validate.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });

    await expect(
      runAction({
        argv: ["validate"],
        cwd,
        env: {
          ...baseEnv,
          GITVIBE_EXECUTION_MODE: "member",
          GITVIBE_MEMBER_INDEX: "1",
        },
        runStage,
      }),
    ).resolves.toBe(0);

    expect(runStage).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "member",
        profileName: "codex_cli",
        roleName: "maintainability.md",
      }),
    );
  });
});

describe("GitVibe action launcher target validation", () => {
  it("validates stage target inputs", async () => {
    const error = vi.fn();

    await expect(
      runAction({
        argv: ["address-pr-feedback"],
        env: { GITHUB_REPOSITORY: "example/repo", GITVIBE_GITHUB_APP_TOKEN: "token" },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITVIBE_PR_NUMBER is required for address-pr-feedback.");

    await expect(
      runAction({
        argv: ["investigate"],
        env: { GITHUB_REPOSITORY: "example/repo", GITVIBE_GITHUB_APP_TOKEN: "token" },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "GITVIBE_ISSUE_NUMBER or GITVIBE_PR_NUMBER is required for investigate.",
    );

    await expect(
      runAction({
        argv: ["validate"],
        env: { GITHUB_REPOSITORY: "example/repo", GITVIBE_GITHUB_APP_TOKEN: "token" },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "GITVIBE_ISSUE_NUMBER or GITVIBE_DISCUSSION_NUMBER is required for validate.",
    );

    await expect(
      runAction({
        argv: ["review-matrix"],
        env: { GITHUB_REPOSITORY: "example/repo", GITVIBE_GITHUB_APP_TOKEN: "token" },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "GITVIBE_ISSUE_NUMBER or GITVIBE_PR_NUMBER is required for review-matrix.",
    );

    await expect(
      runAction({
        argv: ["implement"],
        env: { GITHUB_REPOSITORY: "example/repo", GITVIBE_GITHUB_APP_TOKEN: "token" },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITVIBE_ISSUE_NUMBER is required for this stage.");
  });

  it("validates JSON target metadata", async () => {
    const error = vi.fn();

    await expect(
      runAction({
        argv: ["validate"],
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITVIBE_GITHUB_APP_TOKEN: "token",
          GITVIBE_ISSUE_NUMBER: "1",
          GITVIBE_SOURCE_COMMENT: "{bad",
        },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITVIBE_SOURCE_COMMENT must be valid JSON.");
  });
});

describe("GitVibe action launcher targets and defaults", () => {
  it("supports discussion and pull request stages", async () => {
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "",
      parsedOutput: {},
      schemaId: "validate.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });

    await expect(
      runAction({
        argv: ["validate"],
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITVIBE_DISCUSSION_NUMBER: "5",
          GITVIBE_GITHUB_APP_TOKEN: "token",
        },
        runStage,
      }),
    ).resolves.toBe(0);
    await expect(
      runAction({
        argv: ["address-pr-feedback"],
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITVIBE_GITHUB_APP_TOKEN: "token",
          GITVIBE_PR_NUMBER: "8",
        },
        runStage,
      }),
    ).resolves.toBe(0);
    await expect(
      runAction({
        argv: ["investigate"],
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITVIBE_GITHUB_APP_TOKEN: "token",
          GITVIBE_PR_NUMBER: "8",
        },
        runStage,
      }),
    ).resolves.toBe(0);

    expect(runStage.mock.calls[0][0]).toMatchObject({ issueNumber: "", stage: "validate" });
    expect(runStage.mock.calls[1][0]).toMatchObject({
      prNumber: "8",
      stage: "address-pr-feedback",
    });
    expect(runStage.mock.calls[2][0]).toMatchObject({
      prNumber: "8",
      stage: "investigate",
    });
    expect(
      isDirectRun(new URL("../src/runner/actions/run-action.ts", import.meta.url).href, undefined),
    ).toBe(false);
  });

  it("uses runtime defaults and skips GitHub outputs when no output file is configured", async () => {
    const appendFile = vi.fn();
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "",
      parsedOutput: {},
      schemaId: "investigate.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });

    await expect(
      runAction({
        appendFile,
        argv: ["validate"],
        cwd: "/fallback",
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_WORKSPACE: "/workspace",
          GITVIBE_GITHUB_APP_TOKEN: "token",
          GITVIBE_ISSUE_NUMBER: "9",
        },
        runStage,
      }),
    ).resolves.toBe(0);

    expect(runStage).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/workspace",
        dryRun: false,
        issueNumber: "9",
        maxTurns: 90,
        stageTimeoutMinutes: 60,
      }),
    );
    expect(appendFile).not.toHaveBeenCalled();
  });
});

describe("GitVibe action launcher failure paths", () => {
  it("can fail the action when a stage returns a blocked status", async () => {
    const appendFile = vi.fn();
    const error = vi.fn();
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "Needs answers",
      parsedOutput: {},
      resultFile: "/tmp/git-vibe-investigate-result.json",
      schemaId: "investigate.v1",
      status: "blocked",
      summary: "Critical questions are unanswered.",
      validationErrors: [],
    });

    await expect(
      runAction({
        appendFile,
        argv: ["investigate"],
        env: {
          ...baseEnv,
          GITHUB_OUTPUT: "/tmp/output",
          GITVIBE_FAIL_ON_BLOCKED: "true",
        },
        error,
        runStage,
      }),
    ).resolves.toBe(1);

    expect(error).toHaveBeenCalledWith("investigate returned status blocked; stopping workflow.");
    expect(appendFile).toHaveBeenCalledWith(
      "/tmp/output",
      "status<<GITVIBE_OUTPUT\nblocked\nGITVIBE_OUTPUT\n",
    );
  });

  it("reports non-error stage failures and detects bundled direct execution", async () => {
    const error = vi.fn();

    await expect(
      runAction({
        argv: ["investigate"],
        env: baseEnv,
        error,
        runStage: vi.fn().mockRejectedValueOnce("plain failure"),
      }),
    ).resolves.toBe(1);

    expect(error).toHaveBeenCalledWith("plain failure");
    expect(isDirectRun("", "/tmp/run-action.cjs")).toBe(true);
  });

  it("falls back to process env and argv when runtime values are omitted", async () => {
    const originalArgv = process.argv;
    const originalEnv = process.env;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "",
      parsedOutput: {},
      schemaId: "investigate.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });

    process.argv = ["node", "/tmp/run-action.js", "investigate"];
    process.env = { ...originalEnv, ...baseEnv };
    try {
      await expect(runAction({ log: vi.fn(), runStage })).resolves.toBe(0);
      await expect(
        runAction({
          argv: ["validate"],
          env: { GITHUB_REPOSITORY: "example/repo", GITVIBE_GITHUB_APP_TOKEN: "token" },
        }),
      ).resolves.toBe(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[git-vibe] GITVIBE_ISSUE_NUMBER or GITVIBE_DISCUSSION_NUMBER is required for validate.",
      );
    } finally {
      process.argv = originalArgv;
      process.env = originalEnv;
      consoleError.mockRestore();
    }

    expect(runStage).toHaveBeenCalledWith(expect.objectContaining({ stage: "investigate" }));
  });
});
