import { describe, expect, it } from "vitest";
import {
  gitVibeBranchName,
  reviewFixIssueMarker,
  reviewFixIssueBody,
  reviewFixLinkComment,
  reviewFixLinkFromBody,
  reviewFixTraceFromBody,
} from "../src/shared/traceability.ts";

describe("GitVibe review-fix traceability", () => {
  it("parses review-fix issue and link markers", () => {
    const marker = reviewFixIssueMarker({
      branch: "git-vibe/7",
      depth: 1,
      parent: "7",
      root: "7",
    });

    expect(reviewFixTraceFromBody(`${marker}\n\nbody`)).toEqual({
      branch: "git-vibe/7",
      depth: 1,
      parent: "7",
      root: "7",
    });
    expect(
      reviewFixTraceFromBody("<!-- git-vibe:review-fix root=7 parent=7 branch=main depth=1 -->"),
    ).toBeUndefined();
    expect(
      reviewFixLinkFromBody(
        reviewFixLinkComment({
          depth: 1,
          issueNumber: "8",
          parent: "7",
          root: "7",
        }),
      ),
    ).toEqual({ depth: 1, issue: "8", parent: "7", root: "7" });
    expect(gitVibeBranchName("7")).toBe("git-vibe/7");
  });

  it("rejects malformed review-fix markers", () => {
    expect(reviewFixTraceFromBody("no marker")).toBeUndefined();
    expect(reviewFixTraceFromBody("<!-- git-vibe:review-fix root=7")).toBeUndefined();
    expect(
      reviewFixTraceFromBody(
        "<!-- git-vibe:review-fix root=abc parent=7 branch=git-vibe/7 depth=1 -->",
      ),
    ).toBeUndefined();
    expect(
      reviewFixTraceFromBody("<!-- git-vibe:review-fix parent=7 branch=git-vibe/7 depth=1 -->"),
    ).toBeUndefined();
    expect(
      reviewFixTraceFromBody("<!-- git-vibe:review-fix root=7 branch=git-vibe/7 depth=1 -->"),
    ).toBeUndefined();
    expect(
      reviewFixTraceFromBody(
        "<!-- git-vibe:review-fix root=7 parent=7 branch=git-vibe/7 depth=0 -->",
      ),
    ).toBeUndefined();
    expect(
      reviewFixTraceFromBody("<!-- git-vibe:review-fix root=7 parent=7 branch=git-vibe/7 -->"),
    ).toBeUndefined();
    expect(
      reviewFixLinkFromBody("<!-- git-vibe:review-fix-link parent=7 issue=8 depth=1 -->"),
    ).toBeUndefined();
    expect(
      reviewFixLinkFromBody("<!-- git-vibe:review-fix-link root=7 issue=8 depth=1 -->"),
    ).toBeUndefined();
    expect(
      reviewFixLinkFromBody("<!-- git-vibe:review-fix-link root=7 parent=7 depth=1 -->"),
    ).toBeUndefined();
    expect(
      reviewFixLinkFromBody("<!-- git-vibe:review-fix-link root=7 parent=7 issue=abc depth=1 -->"),
    ).toBeUndefined();
    expect(
      reviewFixLinkFromBody("<!-- git-vibe:review-fix-link root=7 parent=7 issue=8 depth=0 -->"),
    ).toBeUndefined();
    expect(
      reviewFixLinkFromBody("<!-- git-vibe:review-fix-link root=7 parent=7 issue=8 -->"),
    ).toBeUndefined();
  });

  it("renders optional review-fix body sections", () => {
    expect(
      reviewFixLinkComment({
        depth: 2,
        issueNumber: "9",
        parent: "8",
        root: "7",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/1",
      }),
    ).toContain("Workflow run:");

    const body = reviewFixIssueBody({
      branch: "git-vibe/7",
      commentBody: "",
      depth: 2,
      findings: [],
      parentIssue: "8",
      references: [],
      rootIssue: "7",
      summary: "Needs fixes.",
    });
    expect(body).toContain("Parent issue: #8");
    expect(body).not.toContain("Root issue:");
    expect(body).toContain("- None provided.");
  });
});
