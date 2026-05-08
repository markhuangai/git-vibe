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
        implementation_plan: ["src/app/server.ts: add command routing test coverage"],
        missing_capabilities: ["Threaded PR review replies are not implemented"],
        next_state: "git-vibe:ready-for-approval",
        partial_capabilities: ["Issue comments are flat replies with source links"],
        pr_body: "Refs #12",
        pr_title: "GitVibe: implement feature",
        proposed_labels: ["git-vibe:ready-for-approval"],
        questions: ["Confirm copy text"],
        references: ["https://github.com/example/repo/issues/12"],
        stage: "validate",
        status: "completed",
        summary: "Validation finished.",
        tests: ["corepack pnpm test"],
        working_capabilities: ["Discussion comments can be posted"],
      },
      stage: "validate",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    });

    expect(body).toContain(
      "<!-- git-vibe:stage-result stage=validate artifact=issue number=12 -->",
    );
    expect(body).toContain("## GitVibe Validation");
    expect(body).toContain("**Status:** `completed`");
    expect(body).toContain("### Already Working\n- Discussion comments can be posted");
    expect(body).toContain("### Not Working Yet\n- Threaded PR review replies are not implemented");
    expect(body).toContain(
      "### Partial Or Unclear\n- Issue comments are flat replies with source links",
    );
    expect(body).toContain("### Findings\n- The request is implementable");
    expect(body).toContain(
      "### Implementation Plan\n- src/app/server.ts: add command routing test coverage",
    );
    expect(body).toContain("### Pull Request");
    expect(body).toContain("- Workflow run: https://github.com/example/repo/actions/runs/99");
    expect(body).not.toContain('"findings"');
  });

  it("renders retry guidance when investigation has blocking questions", () => {
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
      parsedOutput: {
        assumptions: [],
        blocking_questions: ["Which config key should be used?"],
        comment_body: "Blocked on maintainer input.",
        findings: [],
        implementation_plan: [],
        next_state: "needs-info",
        references: [],
        stage: "investigate",
        status: "completed",
        summary: "Investigation needs maintainer input.",
      },
      stage: "investigate",
    });

    expect(body).toContain("### Blocking Questions\n- Which config key should be used?");
    expect(body).toContain("### Next Human Action");
    expect(body).toContain("re-add `git-vibe:approved`");
  });
});
