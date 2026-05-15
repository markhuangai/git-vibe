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
    expect(workflow).toContain("PR gvi:ready-for-approval");
    expect(workflow).toContain("investigate` in PR-feedback mode");
  });

  it("documents the local git-vibe-setup installer behavior", () => {
    const readme = readFileSync("README.md", "utf8");
    const exampleReadme = readFileSync("examples/consumer/README.md", "utf8");

    expect(readme).toContain("git-vibe-setup");
    expect(readme).toContain("stops without writing if any target file");
    expect(readme).toContain("already exists.");
    expect(readme).toContain("pins generated reusable");
    expect(readme).toContain("workflow refs to that release tag");
    expect(exampleReadme).toContain("fails closed if GitHub release");
    expect(exampleReadme).toContain("lookup or target-file validation");
    expect(exampleReadme).toContain("It will not overwrite existing target files.");
  });
});
