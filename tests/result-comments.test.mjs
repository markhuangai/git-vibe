import { describe, expect, it } from "vitest";
import { renderStageResultComment } from "../src/runner/result-comments.ts";

describe("stage result comments", () => {
  it("renders structured AI output as human-readable Markdown with a stable marker", () => {
    const body = renderStageResultComment({
      context: {
        artifact: {
          body: "Issue body",
          number: "12",
          title: "Issue title",
          type: "issue",
          url: "https://github.com/example/repo/issues/12",
        },
        generatedAt: "2026-01-01T00:00:00Z",
        repository: "example/repo",
        timeline: [],
      },
      links: [{ label: "Pull request #22", url: "https://github.com/example/repo/pull/22" }],
      parsedOutput: {
        assumptions: ["Existing API remains stable"],
        branch: "git-vibe/12",
        comment_body: "Detailed notes for reviewers.",
        findings: ["The request is implementable"],
        next_state: "git-vibe:ready-for-approval",
        pr_body: "Refs #12",
        pr_title: "GitVibe: implement feature",
        proposed_labels: ["git-vibe:ready-for-approval"],
        questions: ["Confirm copy text"],
        references: ["https://github.com/example/repo/issues/12"],
        stage: "validate",
        status: "completed",
        summary: "Validation finished.",
        tests: ["corepack pnpm test"],
      },
      stage: "validate",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    });

    expect(body).toContain(
      "<!-- git-vibe:stage-result stage=validate artifact=issue number=12 -->",
    );
    expect(body).toContain("## GitVibe Validation");
    expect(body).toContain("**Status:** `completed`");
    expect(body).toContain("### Findings\n- The request is implementable");
    expect(body).toContain("### Pull Request");
    expect(body).toContain("- Workflow run: https://github.com/example/repo/actions/runs/99");
    expect(body).not.toContain('"findings"');
  });
});
