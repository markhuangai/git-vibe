import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { workflowBudgetInputsFor } from "../src/shared/budgets.ts";

/**
 * @typedef {{ default?: unknown, required?: boolean, type?: string }} WorkflowInput
 * @typedef {{ concurrency?: { group?: string, ["cancel-in-progress"]?: boolean }, env?: Record<string, string>, inputs?: Record<string, WorkflowInput>, jobs?: Record<string, WorkflowJob>, name?: string, on?: { pull_request_target?: { branches?: string[], types?: string[] }, push?: { paths?: string[] }, workflow_call?: { inputs?: Record<string, WorkflowInput>, secrets?: Record<string, { required?: boolean }> }, workflow_dispatch?: { inputs?: Record<string, WorkflowInput> } }, outputs?: Record<string, { description?: string, value?: string }>, permissions?: Record<string, string>, ["run-name"]?: string }} Workflow
 * @typedef {{ env?: Record<string, string>, if?: string, name?: string, needs?: string, outputs?: Record<string, string>, permissions?: Record<string, string>, secrets?: Record<string, string>, steps?: WorkflowStep[], ["timeout-minutes"]?: string, uses?: string, with?: Record<string, unknown> }} WorkflowJob
 * @typedef {{ env?: Record<string, string>, id?: string, if?: string, name?: string, run?: string, uses?: string, with?: Record<string, unknown> }} WorkflowStep
 * @typedef {{ env: Record<string, string>, name?: string, uses?: string, with?: Record<string, unknown> }} SimulatedStep
 */

const aiEnv = {
  GITVIBE_AI_ENV_JSON: "${{ secrets.GITVIBE_AI_ENV_JSON }}",
};
const mcpEnv = {
  GITVIBE_MCP_ENV_JSON: "${{ secrets.GITVIBE_MCP_ENV_JSON }}",
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

const consumerWorkflowBudgetConfig = {
  ai: {
    budgets: Object.fromEntries(
      "create_pr_timeout_minutes default_max_turns default_timeout_minutes feedback_max_turns feedback_timeout_minutes implementation_max_turns implementation_timeout_minutes review_timeout_minutes validation_repair_attempts validation_repair_max_turns"
        .split(" ")
        .map((key) => [key, 1]),
    ),
  },
};

const actionFiles = [
  "address-pr-feedback/action.yml",
  "create-pr/action.yml",
  "implement/action.yml",
  "investigate/action.yml",
  "mark-blocked/action.yml",
  "materialize/action.yml",
  "plan-stage/action.yml",
  "review-matrix/action.yml",
  "security-review/action.yml",
  "validate/action.yml",
];

const workflowRunNameSpecs = [
  { file: ".github/workflows/release.yml", stage: "release" },
  { file: ".github/workflows/validate.yml", stage: "validate", multiArtifact: true },
  { file: ".github/workflows/materialize.yml", stage: "materialize", artifact: "Discussion" },
  { file: ".github/workflows/investigate.yml", stage: "investigate", artifact: "Issue" },
  { file: ".github/workflows/develop.yml", stage: "develop", artifact: "Issue" },
  { file: ".github/workflows/review.yml", stage: "review", artifact: "PR" },
  {
    file: ".github/workflows/automatic-pr-review.yml",
    stage: "automatic-pr-review",
    artifact: "PR",
  },
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
  ".github/workflows/automatic-pr-review.yml": "GitVibe automatic PR review",
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
  it("passes AI and MCP environment only into reusable AI action source runs", () => {
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
          expect(step.env?.GITVIBE_MCP_ENV_JSON, `${file} ${step.uses} omits MCP env`).toBe("");
          continue;
        }
        if (
          step.uses === "./.git-vibe/actions/mark-blocked" ||
          step.uses === "./.git-vibe/actions/security-review"
        ) {
          expect(
            step.env?.GITVIBE_AI_ENV_JSON,
            `${file} ${step.uses} omits AI env`,
          ).toBeUndefined();
          expect(
            step.env?.GITVIBE_MCP_ENV_JSON,
            `${file} ${step.uses} omits MCP env`,
          ).toBeUndefined();
          continue;
        }
        expect(step.env, `${file} ${step.uses} receives AI and MCP env`).toMatchObject({
          ...aiEnv,
          ...mcpEnv,
        });
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
      expect(
        workflow.env?.GITVIBE_MCP_ENV_JSON,
        `${file} omits MCP bundle at workflow scope`,
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
      const actionSourceSteps = checkoutSteps.filter(
        ({ name }) => name === "Checkout GitVibe action source",
      );

      expect(workflow.on?.workflow_dispatch, `${file} declares workflow_dispatch`).toBeTruthy();
      expect(workflow.on?.workflow_dispatch?.inputs?.["action-repository"]).toBeUndefined();
      expect(workflow.on?.workflow_dispatch?.inputs?.["action-ref"]).toBeUndefined();
      expect(workflowCall?.inputs?.["action-repository"]).toBeUndefined();
      expect(workflowCall?.inputs?.["action-ref"]).toBeUndefined();
      expect(workflowCall?.secrets?.GITVIBE_AI_ENV_JSON).toMatchObject({ required: true });
      expect(workflowCall?.secrets?.GITVIBE_MCP_ENV_JSON).toMatchObject({ required: false });
      expect(workflowCall?.secrets?.GITVIBE_AI_API_KEY, `${file} omits old AI key`).toBeUndefined();
      expect(actionSourceSteps.length).toBeGreaterThan(0);
      for (const step of actionSourceSteps) {
        expect(step.with?.repository).toBe("${{ job.workflow_repository }}");
        expect(step.with?.ref).toBe("${{ job.workflow_sha }}");
      }
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
        GITVIBE_MCP_ENV_JSON: "${{ secrets.GITVIBE_MCP_ENV_JSON }}",
      });
      expect(reusableJob?.secrets?.GITVIBE_AI_API_KEY, `${file} omits old AI key`).toBeUndefined();
      expect(reusableJob?.secrets?.CODEX_AUTH_JSON, `${file} omits old Codex auth`).toBeUndefined();
      expect(reusableJob?.secrets?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(reusableJob?.with?.["action-repository"]).toBeUndefined();
      expect(reusableJob?.with?.["action-ref"]).toBeUndefined();
    }
  });

  it("declares and forwards every budget input the server dispatches to consumer wrappers", () => {
    for (const file of consumerWorkflows) {
      const workflowName = file.slice(file.lastIndexOf("/") + 1);
      const workflow = readWorkflow(file);
      const budgetInputs = workflowBudgetInputsFor(consumerWorkflowBudgetConfig, workflowName);
      const reusableJob = Object.values(workflow.jobs || {}).find((job) =>
        String(job.uses || "").startsWith("markhuangai/git-vibe/.github/workflows/"),
      );

      for (const inputName of Object.keys(budgetInputs)) {
        expect(
          workflow.on?.workflow_dispatch?.inputs?.[inputName],
          `${file} declares dispatch input ${inputName}`,
        ).toMatchObject({
          required: false,
          type: "number",
        });
        expect(reusableJob?.with?.[inputName], `${file} forwards ${inputName}`).toBe(
          `\${{ fromJSON(github.event.inputs.${inputName}) }}`,
        );
      }
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
            : file === "security-review/action.yml"
              ? "dist/actions/security-review.js"
              : "dist/actions/run-action.js";
      const runStep = content.indexOf(runEntrypoint);
      const needsAiSetup = ![
        "mark-blocked/action.yml",
        "plan-stage/action.yml",
        "security-review/action.yml",
      ].includes(file);

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
        if (jobName === "security-review" || jobName.startsWith("plan-")) {
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
    const wrapper = readWorkflow(".github/workflows/automatic-pr-review.yml");
    const source = readWorkflow(".github/workflows/review.yml");
    const consumer = readWorkflow("examples/consumer/.github/workflows/review.yml");

    expect(source.on?.pull_request_target).toBeUndefined();
    expect(consumer.on?.pull_request_target).toBeUndefined();
    expect(wrapper.on?.pull_request_target).toMatchObject({
      branches: ["main", "dev"],
      types: ["opened", "reopened", "synchronize", "ready_for_review"],
    });
    expect(wrapper.jobs?.review).toMatchObject({
      if: "${{ !github.event.pull_request.draft }}",
      secrets: {
        GITVIBE_AI_ENV_JSON: "${{ secrets.GITVIBE_AI_ENV_JSON }}",
        GITVIBE_GITHUB_TOKEN: "${{ secrets.GITVIBE_GITHUB_TOKEN }}",
        GITVIBE_MCP_ENV_JSON: "${{ secrets.GITVIBE_MCP_ENV_JSON }}",
      },
      uses: "./.github/workflows/review.yml",
      with: {
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
    const wrapper = readWorkflow(".github/workflows/automatic-pr-review.yml");

    expect(source.concurrency).toMatchObject({
      group: "git-vibe-review-${{ inputs.pr-number }}",
      "cancel-in-progress": true,
    });
    expect(wrapper.concurrency).toMatchObject({
      group: "git-vibe-automatic-pr-review-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
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
        with: step.with,
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
