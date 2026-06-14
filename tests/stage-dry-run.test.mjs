import { describe, expect, it, vi } from "vitest";
import { dryRunContent, stageContract } from "../src/runner/stage-dry-run.ts";

describe("stage dry-run contracts", () => {
  it("renders the generic schema contract", () => {
    expect(stageContract("validate", context("discussion"))).toBe(
      "Stage validate is running. Return only JSON matching the schema.",
    );
  });

  it("renders pull-request investigation dry-run output", () => {
    const log = logger();
    const investigatePr = JSON.parse(dryRunContent("investigate", context("pull-request"), log));

    expect(investigatePr).toMatchObject({
      feedback_items: [],
      next_state: "no-fixes-needed",
      questions: [],
    });
    expect(log.event).toHaveBeenCalledTimes(1);
  });

  it("renders specialized dry-run output for active stages", () => {
    const log = logger();
    const materialize = JSON.parse(dryRunContent("materialize", context("discussion"), log));
    const investigateIssue = JSON.parse(dryRunContent("investigate", context("issue"), log));
    const reviewMatrix = JSON.parse(dryRunContent("review-matrix", context("pull-request"), log));

    expect(materialize.issues[0].title).toBe("GitVibe dry run: Discussion title");
    expect(materialize.issues[0].parallel_group).toBe("default");
    expect(investigateIssue).toMatchObject({
      implementation_plan: [],
      next_state: "needs-info",
    });
    expect(reviewMatrix.next_state).toBe("review-passed");
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
