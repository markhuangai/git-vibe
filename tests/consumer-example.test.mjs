import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../src/runner/config.ts";
import { stageExecutionPlan } from "../src/runner/role-groups.ts";

/**
 * @typedef {import("../src/shared/types.ts").GitVibeConfig} GitVibeConfig
 * @typedef {import("../src/shared/types.ts").Stage} Stage
 */

const consumerRoot = join(process.cwd(), "examples", "consumer");
const roleGroupStages = /** @type {Stage[]} */ (["investigate", "validate", "review-matrix"]);
const profileStages = /** @type {Stage[]} */ ([
  "summarize",
  "materialize",
  "implement",
  "create-pr",
  "address-pr-feedback",
]);

describe("consumer examples", () => {
  it("include wrappers for every reusable GitVibe workflow", () => {
    const reusableWorkflowNames = reusableWorkflowFiles().map((file) => basename(file));
    const consumerWorkflowNames = workflowFiles(join(consumerRoot, ".github", "workflows")).map(
      (file) => basename(file),
    );

    expect(consumerWorkflowNames.sort()).toEqual(reusableWorkflowNames.sort());
  });

  it("keeps the starter config compatible with role-group routing", () => {
    const configText = readFileSync(join(consumerRoot, ".github", "git-vibe.yml"), "utf8");
    const config = loadConfig(consumerRoot);

    assertStarterRouting(configText, config, consumerRoot);
  });

  it("keeps the root example config compatible with role-group routing", () => {
    const configText = readFileSync(join(process.cwd(), ".github", "git-vibe.example.yml"), "utf8");
    const config = /** @type {GitVibeConfig} */ (parse(configText));

    assertStarterRouting(configText, config, process.cwd());
  });
});

/**
 * @param {string} configText
 * @param {GitVibeConfig} config
 * @param {string} cwd
 */
function assertStarterRouting(configText, config, cwd) {
  expect(configText).not.toContain("      profiles:");
  for (const role of ["correctness.md", "security.md", "maintainability.md"]) {
    expect(existsSync(join(cwd, ".git-vibe", "role-group", role))).toBe(true);
  }

  for (const stage of roleGroupStages) {
    const plan = stageExecutionPlan(config, stage, cwd);
    expect(plan).toMatchObject({ mode: "role-group", roleGroup: "review_gate" });
    expect(plan.matrix.include).toHaveLength(3);
  }

  for (const stage of profileStages) {
    expect(stageExecutionPlan(config, stage, cwd)).toMatchObject({ mode: "profile" });
  }
}

function reusableWorkflowFiles() {
  return workflowFiles(join(process.cwd(), ".github", "workflows")).filter((file) => {
    const workflow = parse(readFileSync(file, "utf8"));
    return Boolean(workflow?.on?.workflow_call?.secrets?.GITVIBE_AI_ENV_JSON);
  });
}

/**
 * @param {string} directory
 */
function workflowFiles(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".yml"))
    .map((file) => join(directory, file));
}
