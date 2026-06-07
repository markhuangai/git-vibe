import { describe, expect, it } from "vitest";
import { parseStageResultMarker, stageResultStatus } from "../src/shared/stage-result-markers.ts";

describe("stage result markers", () => {
  it("parses valid markers and normalizes result status", () => {
    const body = [
      "<!-- git-vibe:stage-result stage=review-matrix artifact=pull-request number=12 run=99 -->",
      "**Status:** `READY_FOR_REVIEW`",
    ].join("\n");

    expect(parseStageResultMarker(body)).toEqual({
      artifact: "pull-request",
      number: "12",
      run: "99",
      stage: "review-matrix",
    });
    expect(stageResultStatus(body)).toBe("ready-for-review");
  });

  it("ignores malformed markers and missing status lines", () => {
    expect(parseStageResultMarker("")).toBeUndefined();
    expect(parseStageResultMarker("<!-- git-vibe:stage-result -->")).toBeUndefined();
    expect(
      parseStageResultMarker(
        "<!-- git-vibe:stage-result stage=missing artifact=issue number=12 -->",
      ),
    ).toBeUndefined();
    expect(
      parseStageResultMarker(
        "<!-- git-vibe:stage-result stage=validate artifact=unknown number=12 -->",
      ),
    ).toBeUndefined();
    expect(parseStageResultMarker("<!-- git-vibe:stage-result stage=validate -->")).toBeUndefined();
    expect(stageResultStatus("**Status:** blocked")).toBe("");
    expect(stageResultStatus("## GitVibe Result")).toBe("");
  });
});
