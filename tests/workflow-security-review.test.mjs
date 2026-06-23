import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * @typedef {{ id?: string, uses?: string, with?: Record<string, unknown> }} WorkflowStep
 * @typedef {{ if?: string, needs?: string, outputs?: Record<string, string>, permissions?: Record<string, string>, steps?: WorkflowStep[], ["timeout-minutes"]?: number }} WorkflowJob
 * @typedef {{ jobs?: Record<string, WorkflowJob> }} Workflow
 */

/** @type {Array<[string, string, string]>} */
const specs = [
  [".github/workflows/investigate.yml", "plan-investigate", "investigate"],
  [".github/workflows/materialize.yml", "plan-materialize", "materialize"],
  [".github/workflows/review.yml", "plan-review-matrix", "review-matrix"],
  [".github/workflows/validate.yml", "plan-validate", "validate"],
];

describe("GitVibe workflow security review topology", () => {
  it("gates every reusable workflow before planner or stage LLM jobs", () => {
    for (const [file, firstLlmJobName, securityStage] of specs) {
      const workflow = readWorkflow(file);
      const securityReview = workflow.jobs?.["security-review"];
      const securityStep = securityReview?.steps?.find(
        (step) => step.uses === "./.git-vibe/actions/security-review",
      );
      const firstLlmJob = workflow.jobs?.[firstLlmJobName];

      expect(securityReview, `${file} declares a first security-review job`).toMatchObject({
        outputs: expect.objectContaining({
          allowed: "${{ steps.security.outputs.allowed }}",
          status: "${{ steps.security.outputs.status }}",
        }),
        permissions: expect.objectContaining({ contents: "read" }),
        "timeout-minutes": 10,
      });
      expect(securityStep, `${file} runs the no-AI security review action`).toMatchObject({
        id: "security",
        with: expect.objectContaining({ stage: securityStage }),
      });
      expect(firstLlmJob?.needs, `${file} gates ${firstLlmJobName}`).toBe("security-review");
      expect(firstLlmJob?.if, `${file} checks security allowed output`).toBe(
        "needs.security-review.outputs.allowed == 'true'",
      );
    }
  });
});

/** @param {string} file @returns {Workflow} */
function readWorkflow(file) {
  return /** @type {Workflow} */ (parse(readFileSync(file, "utf8")));
}
