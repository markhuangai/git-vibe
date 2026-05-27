import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * @typedef {{ uses?: string, with?: Record<string, unknown> }} WorkflowStep
 * @typedef {{ if?: string, needs?: string | string[], outputs?: Record<string, string>, permissions?: Record<string, string>, steps?: WorkflowStep[], strategy?: Record<string, unknown> }} WorkflowJob
 * @typedef {{ jobs?: Record<string, WorkflowJob>, on?: { workflow_call?: { inputs?: Record<string, unknown> }, workflow_dispatch?: { inputs?: Record<string, unknown> } } }} Workflow
 */

describe("GitVibe develop workflow", () => {
  it("starts with security review after issue-label investigation approval", () => {
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
    expect(implement?.needs).toBe("security-review");
    expect(implement?.if).toBe("needs.security-review.outputs.allowed == 'true'");
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

/** @param {string} file @returns {Workflow} */
function readWorkflow(file) {
  return /** @type {Workflow} */ (parse(readFileSync(file, "utf8")));
}
