import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * @typedef {{ default?: unknown, required?: boolean, type?: string }} WorkflowInput
 * @typedef {{ concurrency?: { group?: string, ["cancel-in-progress"]?: boolean }, env?: Record<string, string>, inputs?: Record<string, WorkflowInput>, jobs?: Record<string, WorkflowJob>, name?: string, on?: { pull_request_target?: { branches?: string[], types?: string[] }, push?: { paths?: string[] }, workflow_call?: { inputs?: Record<string, WorkflowInput>, secrets?: Record<string, { required?: boolean }> }, workflow_dispatch?: { inputs?: Record<string, WorkflowInput> } }, outputs?: Record<string, { description?: string, value?: string }>, permissions?: Record<string, string>, ["run-name"]?: string }} Workflow
 * @typedef {{ env?: Record<string, string>, if?: string, name?: string, needs?: string, outputs?: Record<string, string>, permissions?: Record<string, string>, secrets?: Record<string, string>, steps?: WorkflowStep[], ["timeout-minutes"]?: string, uses?: string, with?: Record<string, unknown> }} WorkflowJob
 * @typedef {{ env?: Record<string, string>, id?: string, if?: string, name?: string, run?: string, uses?: string, with?: Record<string, unknown> }} WorkflowStep
 * @typedef {{ env: Record<string, string>, name?: string, uses?: string }} SimulatedStep
 */

const aiEnv = {
  GITVIBE_AI_ENV_JSON: "${{ secrets.GITVIBE_AI_ENV_JSON }}",
};
const legacyAiEnvNames = [
  "GITVIBE_AI_API_KEY",
  "GITVIBE_AI_BASE_URL",
  "CODEX_AUTH_JSON",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

const reusableWorkflows = [
  ".github/workflows/address-feedback.yml",
  ".github/workflows/develop.yml",
  ".github/workflows/investigate.yml",
  ".github/workflows/materialize.yml",
  ".github/workflows/review.yml",
  ".github/workflows/validate.yml",
];

const consumerWorkflows = [
  "examples/consumer/.github/workflows/address-feedback.yml",
  "examples/consumer/.github/workflows/develop.yml",
  "examples/consumer/.github/workflows/investigate.yml",
  "examples/consumer/.github/workflows/materialize.yml",
  "examples/consumer/.github/workflows/review.yml",
  "examples/consumer/.github/workflows/validate.yml",
];

const actionFiles = [
  "address-pr-feedback/action.yml",
  "create-pr/action.yml",
  "implement/action.yml",
  "investigate/action.yml",
  "mark-blocked/action.yml",
  "materialize/action.yml",
  "plan-stage/action.yml",
  "review-matrix/action.yml",
  "validate/action.yml",
];

const workflowRunNameSpecs = [
  { file: ".github/workflows/release.yml", stage: "release" },
  { file: ".github/workflows/validate.yml", stage: "validate", multiArtifact: true },
  { file: ".github/workflows/materialize.yml", stage: "materialize", artifact: "Discussion" },
  { file: ".github/workflows/investigate.yml", stage: "investigate", artifact: "Issue" },
  { file: ".github/workflows/develop.yml", stage: "develop", artifact: "Issue" },
  { file: ".github/workflows/review.yml", stage: "review", artifact: "PR" },
  { file: ".github/workflows/review-dev-pr.yml", stage: "review-dev", artifact: "PR" },
  { file: ".github/workflows/address-feedback.yml", stage: "address-feedback", artifact: "PR" },
  {
    file: "examples/consumer/.github/workflows/validate.yml",
    stage: "validate",
    multiArtifact: true,
  },
  {
    file: "examples/consumer/.github/workflows/materialize.yml",
    stage: "materialize",
    artifact: "Discussion",
  },
  {
    file: "examples/consumer/.github/workflows/investigate.yml",
    stage: "investigate",
    artifact: "Issue",
  },
  { file: "examples/consumer/.github/workflows/develop.yml", stage: "develop", artifact: "Issue" },
  { file: "examples/consumer/.github/workflows/review.yml", stage: "review", artifact: "PR" },
  {
    file: "examples/consumer/.github/workflows/address-feedback.yml",
    stage: "address-feedback",
    artifact: "PR",
  },
];

const workflowStaticNames = {
  ".github/workflows/release.yml": "GitVibe release",
  ".github/workflows/validate.yml": "GitVibe validate",
  ".github/workflows/materialize.yml": "GitVibe materialize",
  ".github/workflows/investigate.yml": "GitVibe investigate",
  ".github/workflows/develop.yml": "GitVibe develop",
  ".github/workflows/review.yml": "GitVibe review",
  ".github/workflows/review-dev-pr.yml": "GitVibe review dev PR",
  ".github/workflows/address-feedback.yml": "GitVibe address feedback",
  "examples/consumer/.github/workflows/validate.yml": "GitVibe validate",
  "examples/consumer/.github/workflows/materialize.yml": "GitVibe materialize",
  "examples/consumer/.github/workflows/investigate.yml": "GitVibe investigate",
  "examples/consumer/.github/workflows/develop.yml": "GitVibe develop",
  "examples/consumer/.github/workflows/review.yml": "GitVibe review",
  "examples/consumer/.github/workflows/address-feedback.yml": "GitVibe address feedback",
};

describe("GitVibe workflow run names", () => {
  it("defines run-name in all workflows with [git-vibe] prefix and stage identifier", () => {
    for (const spec of workflowRunNameSpecs) {
      const workflow = readWorkflow(spec.file);
      const runName = workflow["run-name"];
      expect(runName, `${spec.file} should define run-name`).toBeDefined();
      expect(runName, `${spec.file} run-name should contain [git-vibe]`).toContain("[git-vibe]");
      expect(runName, `${spec.file} run-name should contain stage [${spec.stage}]`).toContain(
        `[${spec.stage}]`,
      );
      if (spec.artifact) {
        expect(runName, `${spec.file} run-name should reference ${spec.artifact}`).toContain(
          spec.artifact,
        );
      }
      if (spec.multiArtifact) {
        expect(runName, `${spec.file} run-name should handle multiple artifact types`).toContain(
          "inputs.discussion-number",
        );
        expect(runName, `${spec.file} run-name should handle multiple artifact types`).toContain(
          "inputs.issue-number",
        );
      }
    }
  });

  it("preserves static name field in all workflows", () => {
    for (const [file, expectedName] of Object.entries(workflowStaticNames)) {
      const workflow = readWorkflow(file);
      expect(workflow.name, `${file} should preserve static name`).toBe(expectedName);
    }
  });
});

describe("GitVibe workflow wiring", () => {
  it("passes AI environment only into reusable AI action source runs", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      const steps = gitVibeActionSteps(workflow, (uses) => uses.startsWith("./.git-vibe/actions/"));

      expect(
        steps.length,
        `${file} should invoke at least one checked-out GitVibe action`,
      ).toBeGreaterThan(0);
      for (const step of steps) {
        if (step.uses === "./.git-vibe/actions/plan-stage") {
          expect(step.env?.GITVIBE_AI_ENV_JSON, `${file} ${step.uses} omits AI env`).toBe("");
          continue;
        }
        if (step.uses === "./.git-vibe/actions/mark-blocked") {
          expect(
            step.env?.GITVIBE_AI_ENV_JSON,
            `${file} ${step.uses} omits AI env`,
          ).toBeUndefined();
          continue;
        }
        expect(step.env, `${file} ${step.uses} receives AI env`).toMatchObject(aiEnv);
        for (const name of legacyAiEnvNames) {
          expect(step.env?.[name], `${file} ${step.uses} omits ${name}`).toBeUndefined();
        }
      }
    }
  });

  it("removes standalone CLI secret wiring from reusable workflows", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      const workflowCall = workflow.on?.workflow_call;

      expect(
        workflowCall?.secrets?.CODEX_AUTH_JSON,
        `${file} omits old Codex auth`,
      ).toBeUndefined();
      expect(
        workflowCall?.secrets?.CLAUDE_CODE_OAUTH_TOKEN,
        `${file} omits old Claude auth`,
      ).toBeUndefined();
      for (const name of legacyAiEnvNames) {
        expect(workflow.env?.[name], `${file} omits ${name} at workflow scope`).toBeUndefined();
      }
      expect(
        workflow.env?.GITVIBE_AI_ENV_JSON,
        `${file} omits AI bundle at workflow scope`,
      ).toBeUndefined();
    }
  });
});

describe("GitVibe workflow call wiring", () => {
  it("makes reusable workflows callable and manually dispatchable", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      const workflowCall = workflow.on?.workflow_call;
      const checkoutSteps = gitVibeActionSteps(workflow, (uses) => uses === "actions/checkout@v4");

      expect(workflow.on?.workflow_dispatch, `${file} declares workflow_dispatch`).toBeTruthy();
      expect(
        workflowCall?.secrets?.GITVIBE_AI_ENV_JSON,
        `${file} declares AI env bundle`,
      ).toMatchObject({
        required: true,
      });
      expect(workflowCall?.secrets?.GITVIBE_AI_API_KEY, `${file} omits old AI key`).toBeUndefined();
      expect(
        checkoutSteps.some((step) => step.name === "Checkout GitVibe action source"),
        `${file} checks out action source`,
      ).toBe(true);
    }
  });

  it("passes AI secrets from consumer wrapper workflows", () => {
    for (const file of consumerWorkflows) {
      const workflow = readWorkflow(file);
      const jobs = Object.values(workflow.jobs || {});
      const reusableJobs = jobs.filter((job) =>
        String(job.uses || "").startsWith("markhuangai/git-vibe/.github/workflows/"),
      );

      const reusableJob = reusableJobs[0];
      expect(reusableJobs.length, `${file} should call a GitVibe reusable workflow`).toBe(1);
      expect(reusableJob?.secrets).toMatchObject({
        GITVIBE_AI_ENV_JSON: "${{ secrets.GITVIBE_AI_ENV_JSON }}",
        GITVIBE_GITHUB_TOKEN: "${{ secrets.GITVIBE_GITHUB_TOKEN }}",
      });
      expect(reusableJob?.secrets?.GITVIBE_AI_API_KEY, `${file} omits old AI key`).toBeUndefined();
      expect(reusableJob?.secrets?.CODEX_AUTH_JSON, `${file} omits old Codex auth`).toBeUndefined();
      expect(
        reusableJob?.secrets?.CLAUDE_CODE_OAUTH_TOKEN,
        `${file} omits old Claude auth`,
      ).toBeUndefined();
    }
  });
});

describe("GitVibe AI smoke workflow", () => {
  it("validates Codex and Claude Code responses instead of treating CLI presence as success", () => {
    const workflow = readWorkflow(".github/workflows/ai-smoke.yml");
    const claudeSetupNode = workflow.jobs?.["claude-code"]?.steps?.find(
      (step) => step.uses === "actions/setup-node@v4",
    );
    const codexRun = workflowStep(workflow, "codex", "Run Codex smoke test")?.run || "";
    const claudeRun =
      workflowStep(workflow, "claude-code", "Run Claude Code smoke test")?.run || "";
    const claudeInstall = workflow.jobs?.["claude-code"]?.steps?.some(
      (step) => step.run === "pnpm install --frozen-lockfile",
    );

    expect(claudeSetupNode).toMatchObject({ with: { "node-version": 22 } });
    expect(claudeInstall).toBe(true);
    expect(codexRun).toContain("codex exec");
    expect(codexRun).toContain("--output-last-message");
    expect(codexRun).toContain("validateSmokeResponse(response, process.argv[3])");
    expect(codexRun).toContain('"source": { "enum": ["codex"] }');
    expect(codexRun).not.toContain("codex --version");

    expect(claudeRun).toContain("node scripts/smoke-test-claude-code.mjs");
    expect(claudeRun).not.toContain("claude -p");
    expect(claudeRun).not.toContain("claude --version");
  });
});

describe("GitVibe workflow repository selection", () => {
  it("keeps repository and branch selection deterministic", () => {
    const files = [...reusableWorkflows, ...consumerWorkflows, ...actionFiles];

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content, `${file} should not expose a source/base branch input`).not.toContain(
        "base-branch",
      );
      expect(content, `${file} should not expose target owner/repo input`).not.toContain(
        "owner/repo",
      );
      expect(content, `${file} should not pass repository env overrides`).not.toContain(
        "GITVIBE_REPOSITORY",
      );
      expect(content, `${file} should not expose GitVibe config path overrides`).not.toContain(
        "config-path",
      );
      expect(content, `${file} should not pass GitVibe config path env`).not.toContain(
        "GITVIBE_CONFIG_PATH",
      );
    }
  });
});

describe("GitVibe action runtime setup", () => {
  it("builds generated action runtime inside composite actions", () => {
    for (const file of actionFiles) {
      const content = readFileSync(file, "utf8");
      const buildStep = content.indexOf("Build GitVibe action runtime");
      const setupStep = content.indexOf("dist/actions/setup-ai-cli.js");
      const runEntrypoint =
        file === "mark-blocked/action.yml"
          ? "dist/actions/mark-blocked.js"
          : file === "plan-stage/action.yml"
            ? "dist/actions/plan-stage.js"
            : "dist/actions/run-action.js";
      const runStep = content.indexOf(runEntrypoint);
      const needsAiSetup = !["mark-blocked/action.yml", "plan-stage/action.yml"].includes(file);

      expect(buildStep, `${file} should build dist from source on the runner`).toBeGreaterThan(-1);
      if (needsAiSetup) {
        expect(setupStep, `${file} should set up configured AI CLIs`).toBeGreaterThan(-1);
      }
      expect(content, `${file} should prefer Corepack when available`).toContain(
        "command -v corepack",
      );
      expect(content, `${file} should support installed pnpm on self-hosted runners`).toContain(
        "command -v pnpm",
      );
      expect(content, `${file} should install dependencies`).toContain(
        '"${pnpm_cmd[@]}" install --frozen-lockfile',
      );
      expect(content, `${file} should build generated runtime`).toContain('"${pnpm_cmd[@]}" build');
      expect(content, `${file} should explain missing runner package manager`).toContain(
        "GitVibe requires pnpm or Corepack on the runner.",
      );
      expect(buildStep, `${file} should build before running generated entrypoint`).toBeLessThan(
        runStep,
      );
      if (needsAiSetup) {
        expect(setupStep, `${file} should set up CLIs before stage execution`).toBeLessThan(
          runStep,
        );
        expect(buildStep, `${file} should build before setting up CLIs`).toBeLessThan(setupStep);
      }
    }
  });

  it("sets up Node and pnpm before local GitVibe actions run", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
        const steps = job.steps || [];
        const localActionIndex = steps.findIndex((step) =>
          String(step.uses || "").startsWith("./.git-vibe/actions/"),
        );
        if (localActionIndex === -1) continue;

        const setupSteps = steps.slice(0, localActionIndex);
        const pnpmStep = setupSteps.find((step) => step.uses === "pnpm/action-setup@v4");
        const nodeStep = setupSteps.find((step) => step.uses === "actions/setup-node@v4");

        expect(pnpmStep, `${file} ${jobName} installs pnpm before GitVibe action`).toMatchObject({
          with: { run_install: false, version: "10.33.3" },
        });
        expect(nodeStep, `${file} ${jobName} installs Node before GitVibe action`).toMatchObject({
          with: { "node-version": 22 },
        });
      }
    }
  });
});

describe("GitVibe workflow numeric inputs", () => {
  it("coerces workflow-dispatch timeout inputs before assigning job timeouts", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
        const timeout = job["timeout-minutes"];
        if (String(job.uses || "").startsWith("./.github/workflows/")) continue;
        if (
          file === ".github/workflows/develop.yml" &&
          jobName === "implementation-blocked-cleanup"
        ) {
          expect(timeout).toBe(10);
          continue;
        }
        if (jobName.startsWith("plan-")) {
          expect(timeout).toBe(10);
          continue;
        }
        expect(timeout, `${file} ${jobName} timeout uses fromJSON`).toMatch(
          /^\$\{\{ fromJSON\(inputs\.[a-z_]+_minutes\) \}\}$/,
        );
      }
    }
  });

  it("keeps implementation validation repair defaults aligned", () => {
    const workflow = readWorkflow(".github/workflows/develop.yml");
    const action = readWorkflow("implement/action.yml");

    expect(workflow.on?.workflow_dispatch?.inputs?.validation_repair_attempts?.default).toBe(3);
    expect(workflow.on?.workflow_dispatch?.inputs?.validation_repair_max_turns?.default).toBe(45);
    expect(workflow.on?.workflow_dispatch?.inputs?.implementation_max_turns?.default).toBe(200);
    expect(workflow.on?.workflow_call?.inputs?.validation_repair_attempts?.default).toBe(3);
    expect(workflow.on?.workflow_call?.inputs?.validation_repair_max_turns?.default).toBe(45);
    expect(workflow.on?.workflow_call?.inputs?.implementation_max_turns?.default).toBe(200);
    expect(action.inputs?.["validation-repair-attempts"]?.default).toBe("3");
    expect(action.inputs?.["validation-repair-max-turns"]?.default).toBe("45");
    expect(action.inputs?.["max-turns"]?.default).toBe("200");
  });
});

describe("GitVibe workflow write permissions", () => {
  it("grants write permissions where stage result comments are published", () => {
    expect(
      readWorkflow(".github/workflows/validate.yml").jobs?.validate?.permissions,
    ).toMatchObject({
      discussions: "write",
      issues: "write",
    });
    expect(
      readWorkflow(".github/workflows/develop.yml").jobs?.implement?.permissions,
    ).toMatchObject({
      issues: "write",
    });
  });

  it("keeps full final results in run summaries instead of standalone artifacts", () => {
    expect(
      readWorkflow(".github/workflows/investigate.yml").jobs?.investigate?.steps?.find(
        (step) => step.name === "Upload investigation result",
      ),
    ).toBeUndefined();
    expect(
      readWorkflow(".github/workflows/validate.yml").jobs?.validate?.steps?.find(
        (step) => step.name === "Upload validation result",
      ),
    ).toBeUndefined();
    expect(
      readWorkflow(".github/workflows/develop.yml").jobs?.["review-matrix"]?.steps?.find(
        (step) => step.name === "Upload review handoff",
      ),
    ).toBeUndefined();
    expect(
      readWorkflow(".github/workflows/address-feedback.yml").jobs?.[
        "address-feedback"
      ]?.steps?.find((step) => step.name === "Upload feedback remediation result"),
    ).toBeUndefined();
  });
});

describe("GitVibe automatic PR review workflow", () => {
  it("keeps PR-open automation in a repo-local wrapper around review.yml", () => {
    const wrapper = readWorkflow(".github/workflows/review-dev-pr.yml");
    const source = readWorkflow(".github/workflows/review.yml");
    const consumer = readWorkflow("examples/consumer/.github/workflows/review.yml");

    expect(source.on?.pull_request_target).toBeUndefined();
    expect(consumer.on?.pull_request_target).toBeUndefined();
    expect(wrapper.on?.pull_request_target).toMatchObject({
      branches: ["dev"],
      types: ["opened", "reopened", "synchronize", "ready_for_review"],
    });
    expect(wrapper.jobs?.review).toMatchObject({
      if: "${{ !github.event.pull_request.draft }}",
      secrets: {
        GITVIBE_AI_ENV_JSON: "${{ secrets.GITVIBE_AI_ENV_JSON }}",
        GITVIBE_GITHUB_TOKEN: "${{ secrets.GITVIBE_GITHUB_TOKEN }}",
      },
      uses: "./.github/workflows/review.yml",
      with: {
        "action-ref": "${{ github.event.pull_request.base.ref }}",
        "action-repository": "${{ github.repository }}",
        "dry-run": false,
        max_turns: 90,
        "pr-number": "${{ format('{0}', github.event.pull_request.number) }}",
        runner: "docker-runner",
        "source-comment": "",
        timeout_minutes: 60,
      },
    });
  });

  it("cancels older in-progress review runs for the same pull request", () => {
    const source = readWorkflow(".github/workflows/review.yml");
    const wrapper = readWorkflow(".github/workflows/review-dev-pr.yml");

    expect(source.concurrency).toMatchObject({
      group: "git-vibe-review-${{ inputs.pr-number }}",
      "cancel-in-progress": true,
    });
    expect(wrapper.concurrency).toMatchObject({
      group: "git-vibe-review-dev-pr-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
  });
});

describe("GitVibe develop workflow", () => {
  it("starts at implementation after issue-label investigation approval", () => {
    const workflow = readWorkflow(".github/workflows/develop.yml");
    const implement = workflow.jobs?.implement;
    const cleanup = workflow.jobs?.["implementation-blocked-cleanup"];
    const planReview = workflow.jobs?.["plan-review-matrix"];
    const reviewMembers = workflow.jobs?.["review-matrix-members"];
    const reviewMatrix = workflow.jobs?.["review-matrix"];
    const createPr = workflow.jobs?.["create-pr"];

    expect(workflow.on?.workflow_dispatch?.inputs?.investigation_timeout_minutes).toBeUndefined();
    expect(workflow.on?.workflow_call?.inputs?.investigation_timeout_minutes).toBeUndefined();
    expect(workflow.jobs?.investigate).toBeUndefined();
    expect(implement?.needs).toBeUndefined();
    expect(implement?.if).toBeUndefined();
    expect(
      implement?.steps?.find((step) => step.uses === "actions/download-artifact@v4"),
    ).toBeUndefined();
    expect(
      implement?.steps?.find((step) => step.uses === "./.git-vibe/actions/implement"),
    ).toMatchObject({
      with: expect.objectContaining({
        "fail-on-blocked": "true",
        "validation-repair-attempts": "${{ inputs.validation_repair_attempts }}",
      }),
    });
    expect(
      implement?.steps?.find((step) => step.uses === "./.git-vibe/actions/implement")?.with,
    ).not.toHaveProperty("handoff-dir");
    expect(cleanup).toMatchObject({
      if: "always() && (needs.implement.result == 'failure' || needs.implement.result == 'cancelled')",
      needs: "implement",
      permissions: expect.objectContaining({ issues: "write" }),
    });
    expect(
      cleanup?.steps?.find((step) => step.uses === "./.git-vibe/actions/mark-blocked"),
    ).toMatchObject({
      with: expect.objectContaining({
        "dry-run": "${{ inputs.dry-run }}",
        "issue-number": "${{ inputs.issue-number }}",
      }),
    });
    expect(createPr).toMatchObject({
      needs: "implement",
      outputs: expect.objectContaining({
        "pr-number": "${{ steps.create.outputs.pr-number }}",
        "pr-url": "${{ steps.create.outputs.pr-url }}",
      }),
    });
    expect(
      createPr?.steps?.find((step) => step.uses === "./.git-vibe/actions/create-pr"),
    ).toMatchObject({
      id: "create",
    });
    expect(planReview).toMatchObject({
      if: "needs.create-pr.outputs.pr-number != ''",
      needs: "create-pr",
    });
    expect(reviewMembers).toMatchObject({
      "continue-on-error": true,
      if: "needs.create-pr.outputs.pr-number != '' && needs.plan-review-matrix.result == 'success'",
      needs: ["create-pr", "plan-review-matrix"],
      strategy: expect.objectContaining({
        "max-parallel": "${{ fromJSON(needs.plan-review-matrix.outputs.max-parallel || '1') }}",
        matrix: {
          index: "${{ fromJSON(needs.plan-review-matrix.outputs.indexes || '[0]') }}",
        },
      }),
    });
    expect(planReview?.outputs).toHaveProperty("indexes", "${{ steps.plan.outputs.indexes }}");
    expect(planReview?.outputs).not.toHaveProperty("matrix");
    expect(reviewMatrix).toMatchObject({
      if: "always() && needs.create-pr.outputs.pr-number != '' && needs.plan-review-matrix.result == 'success'",
      needs: ["create-pr", "plan-review-matrix", "review-matrix-members"],
      outputs: expect.objectContaining({
        "next-state": "${{ steps.review.outputs.next-state }}",
      }),
    });
    expect(
      reviewMatrix?.steps?.find((step) => step.uses === "./.git-vibe/actions/review-matrix"),
    ).toMatchObject({
      id: "review",
      with: expect.objectContaining({
        "execution-mode": "finalizer",
        "fail-on-blocked": "true",
        "pr-number": "${{ needs.create-pr.outputs.pr-number }}",
      }),
    });
    expect(workflow.jobs?.["review-changes-required"]).toBeUndefined();
  });
});

describe("GitVibe address feedback workflow", () => {
  it("investigates before conditionally implementing and reviewing PR feedback", () => {
    const workflow = readWorkflow(".github/workflows/address-feedback.yml");
    const investigateMembers = workflow.jobs?.["investigate-feedback-members"];
    const investigate = workflow.jobs?.["investigate-feedback"];
    const address = workflow.jobs?.["address-feedback"];

    expect(workflow.jobs?.["create-pr"]).toBeUndefined();
    expect(workflow.jobs?.["plan-review-matrix"]).toBeUndefined();
    expect(workflow.jobs?.["review-matrix-members"]).toBeUndefined();
    expect(workflow.jobs?.["review-matrix"]).toBeUndefined();
    expect(investigateMembers).toMatchObject({
      "continue-on-error": true,
      needs: "plan-investigate-feedback",
      strategy: expect.objectContaining({
        matrix: {
          index: "${{ fromJSON(needs.plan-investigate-feedback.outputs.indexes || '[0]') }}",
        },
      }),
    });
    expect(
      investigateMembers?.steps?.find((step) => step.uses === "./.git-vibe/actions/investigate"),
    ).toMatchObject({
      with: expect.objectContaining({
        "execution-mode": "member",
        "member-index": "${{ matrix.index }}",
        "pr-number": "${{ inputs.pr-number }}",
      }),
    });
    expect(investigate?.outputs).toMatchObject({
      "next-state": "${{ steps.investigate.outputs.next-state }}",
    });
    expect(investigate).toMatchObject({
      if: "always() && needs.plan-investigate-feedback.result == 'success'",
      needs: ["plan-investigate-feedback", "investigate-feedback-members"],
    });
    expect(
      investigate?.steps?.find((step) => step.uses === "./.git-vibe/actions/investigate"),
    ).toMatchObject({
      id: "investigate",
      with: expect.objectContaining({
        "execution-mode": "finalizer",
        "fail-on-blocked": "true",
        "pr-number": "${{ inputs.pr-number }}",
      }),
    });
    expect(address).toMatchObject({
      if: "needs.investigate-feedback.outputs.next-state == 'fixes-required'",
      needs: "investigate-feedback",
    });
    expect(
      address?.steps?.find((step) => step.uses === "./.git-vibe/actions/address-pr-feedback"),
    ).toMatchObject({
      id: "address",
      with: expect.objectContaining({
        "handoff-dir": "${{ runner.temp }}/git-vibe-feedback-handoff",
        "pr-number": "${{ inputs.pr-number }}",
      }),
    });
  });
});

/** @param {Workflow} workflow @param {(uses: string) => boolean} matchesUse @returns {SimulatedStep[]} */
function gitVibeActionSteps(workflow, matchesUse) {
  return Object.values(workflow.jobs || {}).flatMap((job) =>
    (job.steps || [])
      .filter((step) => matchesUse(String(step.uses || "")))
      .map((step) => ({
        env: { ...(workflow.env || {}), ...(job.env || {}), ...(step.env || {}) },
        name: step.name,
        uses: step.uses,
      })),
  );
}

/** @param {Workflow} workflow @param {string} jobName @param {string} stepName @returns {WorkflowStep | undefined} */
function workflowStep(workflow, jobName, stepName) {
  return workflow.jobs?.[jobName]?.steps?.find((step) => step.name === stepName);
}

/** @param {string} file @returns {Workflow} */
function readWorkflow(file) {
  return /** @type {Workflow} */ (parse(readFileSync(file, "utf8")));
}
