import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * @typedef {{ env?: Record<string, string>, jobs?: Record<string, WorkflowJob>, on?: { workflow_call?: { secrets?: Record<string, { required?: boolean }> }, workflow_dispatch?: unknown } }} Workflow
 * @typedef {{ env?: Record<string, string>, secrets?: Record<string, string>, steps?: WorkflowStep[], uses?: string }} WorkflowJob
 * @typedef {{ env?: Record<string, string>, name?: string, uses?: string }} WorkflowStep
 * @typedef {{ env: Record<string, string>, name?: string, uses?: string }} SimulatedStep
 */

const aiEnv = {
  GITVIBE_AI_API_KEY: "${{ secrets.GITVIBE_AI_API_KEY }}",
  GITVIBE_AI_BASE_URL: "${{ vars.GITVIBE_AI_BASE_URL }}",
  GITVIBE_AI_MODEL: "${{ vars.GITVIBE_AI_MODEL }}",
};

const reusableWorkflows = [
  ".github/workflows/address-feedback.yml",
  ".github/workflows/develop.yml",
  ".github/workflows/investigate.yml",
  ".github/workflows/materialize.yml",
  ".github/workflows/summarize.yml",
  ".github/workflows/validate.yml",
];

const consumerWorkflows = [
  "examples/consumer/.github/workflows/address-feedback.yml",
  "examples/consumer/.github/workflows/develop.yml",
  "examples/consumer/.github/workflows/investigate.yml",
  "examples/consumer/.github/workflows/materialize.yml",
  "examples/consumer/.github/workflows/summarize.yml",
  "examples/consumer/.github/workflows/validate.yml",
];

const actionFiles = [
  "address-pr-feedback/action.yml",
  "create-pr/action.yml",
  "implement/action.yml",
  "investigate/action.yml",
  "materialize/action.yml",
  "review-matrix/action.yml",
  "summarize/action.yml",
  "validate/action.yml",
];

describe("GitVibe workflow wiring", () => {
  it("passes AI environment into reusable action source runs", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      const steps = gitVibeActionSteps(workflow, (uses) => uses.startsWith("./.git-vibe/actions/"));

      expect(
        steps.length,
        `${file} should invoke at least one checked-out GitVibe action`,
      ).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.env, `${file} ${step.uses} receives AI env`).toMatchObject(aiEnv);
      }
    }
  });

  it("makes reusable workflows callable and manually dispatchable", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      const workflowCall = workflow.on?.workflow_call;
      const checkoutSteps = gitVibeActionSteps(workflow, (uses) => uses === "actions/checkout@v4");

      expect(workflow.on?.workflow_dispatch, `${file} declares workflow_dispatch`).toBeTruthy();
      expect(workflowCall?.secrets?.GITVIBE_AI_API_KEY, `${file} declares AI key`).toMatchObject({
        required: true,
      });
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
        String(job.uses || "").startsWith("git-vibe/actions/.github/workflows/"),
      );

      const reusableJob = reusableJobs[0];
      expect(reusableJobs.length, `${file} should call a GitVibe reusable workflow`).toBe(1);
      expect(reusableJob?.secrets).toMatchObject({
        GITVIBE_AI_API_KEY: "${{ secrets.GITVIBE_AI_API_KEY }}",
        GITVIBE_GITHUB_TOKEN: "${{ secrets.GITVIBE_GITHUB_TOKEN }}",
      });
    }
  });

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

  it("builds generated action runtime inside composite actions", () => {
    for (const file of actionFiles) {
      const content = readFileSync(file, "utf8");
      const buildStep = content.indexOf("Build GitVibe action runtime");
      const runStep = content.indexOf("dist/actions/run-action.js");

      expect(buildStep, `${file} should build dist from source on the runner`).toBeGreaterThan(-1);
      expect(content, `${file} should enable Corepack`).toContain("corepack enable");
      expect(content, `${file} should install dependencies`).toContain(
        "corepack pnpm install --frozen-lockfile",
      );
      expect(content, `${file} should build generated runtime`).toContain("corepack pnpm build");
      expect(buildStep, `${file} should build before running generated entrypoint`).toBeLessThan(
        runStep,
      );
    }
  });
});

/**
 * @param {Workflow} workflow
 * @param {(uses: string) => boolean} matchesUse
 * @returns {SimulatedStep[]}
 */
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

/**
 * @param {string} file
 * @returns {Workflow}
 */
function readWorkflow(file) {
  return /** @type {Workflow} */ (parse(readFileSync(file, "utf8")));
}
