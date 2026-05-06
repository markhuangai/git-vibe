import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * @typedef {{ env?: Record<string, string>, jobs?: Record<string, WorkflowJob>, on?: { push?: { paths?: string[] }, workflow_call?: { secrets?: Record<string, { required?: boolean }> }, workflow_dispatch?: unknown } }} Workflow
 * @typedef {{ env?: Record<string, string>, permissions?: Record<string, string>, secrets?: Record<string, string>, steps?: WorkflowStep[], ["timeout-minutes"]?: string, uses?: string }} WorkflowJob
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
    }
  });
});

describe("GitVibe workflow numeric inputs", () => {
  it("coerces workflow-dispatch timeout inputs before assigning job timeouts", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
        const timeout = job["timeout-minutes"];
        expect(timeout, `${file} ${jobName} timeout uses fromJSON`).toMatch(
          /^\$\{\{ fromJSON\(inputs\.[a-z_]+_minutes\) \}\}$/,
        );
      }
    }
  });
});

describe("GitVibe workflow write permissions", () => {
  it("grants write permissions where stage result comments are published", () => {
    expect(
      readWorkflow(".github/workflows/summarize.yml").jobs?.summarize?.permissions,
    ).toMatchObject({
      discussions: "write",
    });
    expect(
      readWorkflow(".github/workflows/validate.yml").jobs?.validate?.permissions,
    ).toMatchObject({
      discussions: "write",
      issues: "write",
    });
    expect(
      readWorkflow(".github/workflows/develop.yml").jobs?.investigate?.permissions,
    ).toMatchObject({
      issues: "write",
    });
  });
});

describe("GitVibe app deployment boundary", () => {
  it("deploys the app only when app, shared, package, or deploy files change", () => {
    const paths = readWorkflow(".github/workflows/app-deploy.yml").on?.push?.paths || [];

    expect(paths).toContain("src/app/**");
    expect(paths).toContain("src/shared/**");
    expect(paths).not.toContain("src/**");
    expect(paths).not.toContain("src/runner/**");
    expect(paths).not.toContain("prompts/**");
    expect(paths).not.toContain("schemas/**");
  });

  it("builds the app image without bundled runner runtime assets", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

    expect(packageJson.scripts["build:app"]).toBe("tsc --project tsconfig.build.json");
    expect(dockerfile).toContain("corepack pnpm build:app");
    expect(dockerfile).toContain("COPY --from=build /app/dist/app ./dist/app");
    expect(dockerfile).toContain("COPY --from=build /app/dist/shared ./dist/shared");
    expect(dockerfile).not.toContain("COPY --from=build /app/dist ./dist");
    expect(dockerfile).not.toContain("COPY --from=build /app/prompts ./prompts");
    expect(dockerfile).not.toContain("COPY --from=build /app/schemas ./schemas");
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
