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
    const lifecycle = workflow.slice(
      workflow.indexOf("## Lifecycle"),
      workflow.indexOf("## Key Behavior"),
    );

    expect(workflow).toContain("Feedback[address-feedback.yml]");
    expect(lifecycle.match(/```mermaid/g)).toHaveLength(1);
    expect(lifecycle).toContain("Develop --> DevelopSecurity[security-review job: issue context]");
    expect(lifecycle).toContain("DevelopSecurity -->|safe| Context");
    expect(lifecycle).toContain(
      "Context --> RuntimeGate{In-runner pre-LLM prompt-injection safety gate}",
    );
    expect(lifecycle).toContain("RuntimeGate -->|safe| AIStage[AI stage]");
    expect(lifecycle).toContain("ReviewSecurity[security-review job: PR context]");
    expect(lifecycle).toContain("OutputGate -->|safe| DevEngine");
    expect(lifecycle).toContain("RepairGate{Pre-repair LLM safety gate}");
    expect(lifecycle).toContain("FeedbackInvestigation -->|fixes required| DevEngine");
    expect(workflow).toContain("Pre-synthesis LLM safety gate");
    expect(workflow).toContain("gvi:blocked, remove git-vibe:approved");
    expect(workflow).toContain("UpdatePRBranch[Update existing PR branch]");
    expect(workflow).not.toContain("Feedback --> PR");
    expect(workflow).toContain("PR gvi:ready-for-approval");
    expect(workflow).toContain("investigate` in PR-feedback mode");
  });

  it("keeps Mermaid workflow docs aligned with PR-first review", () => {
    const readme = readFileSync("README.md", "utf8");
    const workflow = readFileSync("docs/WORKFLOW.md", "utf8");

    expect(readme).toContain("K[Create or update PR]");
    expect(readme).toContain("N[Update existing PR branch]");
    expect(readme).toContain("K --> L");
    expect(readme).toContain("N --> L");
    expect(workflow).toContain('PrOpened["Source issue gvi:pr-opened"]');
    expect(workflow).toContain("PrOpened -->|auto PR review| PrReviewStart");
    expect(workflow).toContain("PrInProgress -->|review starts| PrReviewing");
    expect(workflow).toContain("PR labeled git-vibe:review");
    expect(workflow).toContain("Dispatch review.yml");
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
