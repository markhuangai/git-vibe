import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("GitVibe matrix workflow labels", () => {
  it("names member jobs with role-profile labels", () => {
    const cases = [
      [
        ".github/workflows/address-feedback.yml",
        "investigate-feedback-members",
        "plan-investigate-feedback",
      ],
      [".github/workflows/address-feedback.yml", "review-matrix-members", "plan-review-matrix"],
      [".github/workflows/develop.yml", "review-matrix-members", "plan-review-matrix"],
      [".github/workflows/review.yml", "review-matrix-members", "plan-review-matrix"],
      [".github/workflows/investigate.yml", "investigate-members", "plan-investigate"],
      [".github/workflows/decompose.yml", "decompose-members", "plan-decompose"],
      [".github/workflows/validate.yml", "validate-members", "plan-validate"],
    ];

    for (const [file, job, plan] of cases) {
      const expected = [
        "${{ fromJSON(needs.",
        plan,
        ".outputs.labels)[format('{0}', matrix.index)] }}",
      ].join("");
      expect(readWorkflow(file).jobs?.[job]?.name).toBe(expected);
    }
  });
});

/** @param {string} file @returns {any} */
function readWorkflow(file) {
  return parse(readFileSync(file, "utf8"));
}
