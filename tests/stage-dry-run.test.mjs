import { describe, expect, it, vi } from "vitest";
import { dryRunContent, stageContract } from "../src/runner/stage-dry-run.ts";

describe("stage dry-run contracts", () => {
  it("includes deterministic branch guidance only when the stage prepares a branch", () => {
    expect(stageContract("implement", context("issue"))).toContain(
      "GitVibe has already prepared branch git-vibe/12",
    );
    expect(stageContract("validate", context("discussion"))).not.toContain("prepared branch");
  });

  it("renders decompose and pull-request investigation dry-run output", () => {
    const log = logger();
    const decompose = JSON.parse(dryRunContent("decompose", context("discussion"), log));
    const investigatePr = JSON.parse(dryRunContent("investigate", context("pull-request"), log));

    expect(decompose).toMatchObject({
      next_state: "ready-for-materialization",
      story_units: [{ parallel_group: "default" }],
    });
    expect(investigatePr).toMatchObject({
      feedback_items: [],
      next_state: "no-fixes-needed",
      questions: [],
    });
    expect(log.event).toHaveBeenCalledTimes(2);
  });

  it("renders specialized dry-run output for write and discussion stages", () => {
    const log = logger();
    const createPr = JSON.parse(dryRunContent("create-pr", context("issue"), log));
    const materialize = JSON.parse(dryRunContent("materialize", context("discussion"), log));
    const implement = JSON.parse(dryRunContent("implement", context("issue"), log));
    const feedback = JSON.parse(dryRunContent("address-pr-feedback", context("pull-request"), log));
    const investigateIssue = JSON.parse(dryRunContent("investigate", context("issue"), log));

    expect(createPr).toMatchObject({ branch: "git-vibe/12" });
    expect(materialize.issue_title).toBe("GitVibe dry run: Discussion title");
    expect(implement.tests).toEqual([]);
    expect(feedback).toMatchObject({ skipped_feedback: [], tests: [] });
    expect(investigateIssue).toMatchObject({
      implementation_plan: [],
      next_state: "needs-info",
    });
  });

  it("omits empty artifact URLs from dry-run references", () => {
    const output = JSON.parse(
      dryRunContent("materialize", context("discussion", { url: "" }), logger()),
    );

    expect(output.references).toEqual([]);
  });

  it("uses blocked as the fallback next state for unknown stages", () => {
    const output = JSON.parse(dryRunContent("unknown", context("issue"), logger()));

    expect(output.next_state).toBe("blocked");
  });
});

/**
 * @param {import("../src/shared/types.ts").ContextPacket["artifact"]["type"]} type
 * @param {Partial<import("../src/shared/types.ts").ContextPacket["artifact"]>} [overrides]
 * @returns {import("../src/shared/types.ts").ContextPacket}
 */
function context(type, overrides = {}) {
  return {
    artifact: {
      body: "Body",
      number: "12",
      title: type === "discussion" ? "Discussion title" : "Issue title",
      type,
      url: `https://github.com/example/repo/${type}s/12`,
      ...overrides,
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  };
}

function logger() {
  return { event: vi.fn() };
}
