import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * @typedef {{ steps?: WorkflowStep[] }} WorkflowJob
 * @typedef {{ uses?: string, with?: Record<string, unknown> }} WorkflowStep
 * @typedef {{ jobs?: Record<string, WorkflowJob> }} Workflow
 */

describe("GitVibe review workflow finalizer", () => {
  it("fails on blocked and changes-required review results", () => {
    const workflow = /** @type {Workflow} */ (
      parse(readFileSync(".github/workflows/review.yml", "utf8"))
    );
    const reviewStep = workflow.jobs?.["review-matrix"]?.steps?.find(
      (step) => step.uses === "./.git-vibe/actions/review-matrix",
    );

    expect(reviewStep?.with).toMatchObject({
      "fail-on-blocked": "true",
      "fail-on-changes-required": "true",
    });
  });
});
