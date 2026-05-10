import { describe, expect, it } from "vitest";
import {
  renderStageResultComment,
  renderStageStartComment,
} from "../src/runner/result-comments.ts";

describe("stage result comments", () => {
  it("renders non-compact structured AI output as human-readable Markdown", () => {
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
        issue_body: "Create the implementation tracking issue.",
        issue_title: "Implement GitVibe command routing",
        missing_capabilities: ["Threaded PR review replies are not implemented"],
        next_state: "pr-draft-ready",
        partial_capabilities: ["Issue comments are flat replies with source links"],
        pr_body: "Refs #12",
        pr_title: "GitVibe: implement feature",
        proposed_labels: ["git-vibe:ready-for-approval"],
        questions: ["Confirm copy text"],
        references: ["https://github.com/example/repo/issues/12"],
        stage: "create-pr",
        status: "completed",
        summary: "Validation finished.",
        tests: ["corepack pnpm test"],
        working_capabilities: ["Discussion comments can be posted"],
      },
      stage: "create-pr",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    });

    expect(body).toContain(
      "<!-- git-vibe:stage-result stage=create-pr artifact=issue number=12 -->",
    );
    expect(body).toContain("## GitVibe Pull Request Update");
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
    expect(body).toContain("### Proposed Implementation Issue");
    expect(body).toContain("### Pull Request");
    expect(body).toContain("- Workflow run: https://github.com/example/repo/actions/runs/99");
    expect(body).not.toContain('"findings"');
  });
});

describe("pull request feedback result comments", () => {
  it("renders investigation feedback items for pull request artifacts", () => {
    const body = renderStageResultComment({
      context: context("pull-request"),
      parsedOutput: {
        feedback_items: [
          {
            id: "review-comment-1",
            status: "answered",
            summary: "Resolved the null handling feedback.",
          },
          "loose feedback summary",
        ],
        next_state: "fixes-required",
        references: ["https://github.com/example/repo/pull/12#discussion_r1"],
        skipped_feedback: ["Outdated thread was ignored"],
        status: "completed",
        summary: "Open PR feedback requires code changes.",
      },
      stage: "investigate",
    });

    expect(body).toContain("## GitVibe PR Feedback Investigation");
    expect(body).toContain("### Feedback Items");
    expect(body).toContain("`review-comment-1` `answered`: Resolved the null handling feedback.");
    expect(body).toContain("- loose feedback summary");
    expect(body).toContain("### Skipped Feedback\n- Outdated thread was ignored");
  });

  it("renders default fields for incomplete structured feedback items", () => {
    const body = renderStageResultComment({
      context: context("pull-request"),
      parsedOutput: {
        feedback_items: [{}],
        status: "completed",
        summary: "Feedback item shape was incomplete.",
      },
      stage: "investigate",
    });

    expect(body).toContain("`unknown` `unknown`: No summary provided.");
  });
});

describe("stage start comments", () => {
  it("renders start markers and optional workflow links", () => {
    const body = renderStageStartComment({
      context: context("pull-request"),
      stage: "address-pr-feedback",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    });

    expect(body).toContain(
      "<!-- git-vibe:stage-start artifact=pull-request number=12 run=99 stage=address-pr-feedback -->",
    );
    expect(body).toContain("Workflow run: https://github.com/example/repo/actions/runs/99");

    expect(renderStageStartComment({ context: context("issue"), stage: "validate" })).not.toContain(
      "Workflow run:",
    );
  });
});

describe("compact stage result comments", () => {
  it("renders validation results in a compact form", () => {
    const body = renderStageResultComment({
      context: context("issue"),
      parsedOutput: {
        assumptions: ["Existing API remains stable"],
        findings: ["The request is implementable"],
        missing_capabilities: ["Threaded PR review replies are not implemented"],
        next_state: "ready-for-implementation",
        partial_capabilities: ["Issue comments are flat replies with source links"],
        references: ["https://github.com/example/repo/issues/12"],
        stage: "validate",
        status: "completed",
        summary: "Validation finished.",
        working_capabilities: ["Discussion comments can be posted"],
      },
      stage: "validate",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    });

    expect(body).toContain("## GitVibe Validation");
    expect(body).toContain(
      "### Capability Status\n- Working: 1\n- Missing: 1\n- Partial or unclear: 1",
    );
    expect(body).toContain("### Key Findings\n- The request is implementable");
    expect(body).not.toContain("Threaded PR review replies are not implemented");
  });

  it("renders retry guidance when investigation has blocking questions", () => {
    const body = renderStageResultComment({
      context: context("issue"),
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
    expect(body).toContain("add `git-vibe:investigate`");
  });

  it("renders next action and limits long compact sections", () => {
    const body = renderStageResultComment({
      context: context("issue"),
      parsedOutput: {
        findings: ["one", "two", "three", "four", "five", "six"],
        next_state: "ready-for-implementation",
        status: "completed",
        summary: "Investigation is ready.",
      },
      stage: "investigate",
    });

    expect(body).toContain("### Next Action\nContinue with `ready-for-implementation`.");
    expect(body).toContain("- 1 more in the stage result artifact.");
  });
});

describe("optional result comment sections", () => {
  it("omits next action when the next state is blocked", () => {
    const body = renderStageResultComment({
      context: context("issue"),
      parsedOutput: {
        next_state: "blocked",
        status: "completed",
        summary: "Investigation is blocked.",
      },
      stage: "investigate",
    });

    expect(body).not.toContain("### Next Action");
  });
});

/**
 * @param {import("../src/shared/types.ts").ContextPacket["artifact"]["type"]} type
 * @returns {import("../src/shared/types.ts").ContextPacket}
 */
function context(type) {
  return {
    artifact: {
      body: "Issue body",
      number: "12",
      title: "Issue title",
      type,
      url: `https://github.com/example/repo/${type}s/12`,
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  };
}
