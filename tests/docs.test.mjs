import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("documentation workflow descriptions", () => {
  it("documents command acknowledgement without duplicate queued comments", () => {
    const readme = readFileSync("README.md", "utf8");
    const workflow = readFileSync("docs/WORKFLOW.md", "utf8");

    expect(readme).toContain("does not also post a queued comment");
    expect(workflow).toContain("successful `rocket` reaction is the acknowledgement");
  });

  it("keeps Mermaid workflow docs aligned with PR feedback investigation", () => {
    const workflow = readFileSync("docs/WORKFLOW.md", "utf8");

    expect(workflow).toContain("FeedbackInvestigation");
    expect(workflow).toContain("PR git-vibe:ready-for-approval");
    expect(workflow).toContain("investigate` in PR-feedback mode");
  });
});
