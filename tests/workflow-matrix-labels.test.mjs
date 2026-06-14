import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("GitVibe matrix workflow labels", () => {
  it("names member jobs with role-profile labels", () => {
    const cases = [
      [
        ".github/workflows/review.yml",
        "review-matrix-members",
        "plan-review-matrix",
        "git-vibe-review-member-${{ matrix.index }} / ",
      ],
      [
        ".github/workflows/investigate.yml",
        "investigate-members",
        "plan-investigate",
        "git-vibe-investigate-member-${{ matrix.index }} / ",
      ],
      [
        ".github/workflows/validate.yml",
        "validate-members",
        "plan-validate",
        "git-vibe-validate-member-${{ matrix.index }} / ",
      ],
    ];

    for (const [file, job, plan, prefix] of cases) {
      const expected = [
        prefix,
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
