// @ts-nocheck
import { describe, expect, it } from "vitest";
import { encodeSourceComment, parseSourceComment } from "../src/shared/source-comments.ts";

describe("source comment metadata", () => {
  it("round-trips valid source comment metadata", () => {
    const encoded = encodeSourceComment({
      body: "/git-vibe validate",
      id: "16830659",
      kind: "discussion-comment",
      nodeId: "DC_kwDOSUXJQM4BANDD",
      url: "https://github.com/example/repo/discussions/4#discussioncomment-16830659",
    });

    expect(parseSourceComment(encoded)).toEqual({
      body: "/git-vibe validate",
      id: "16830659",
      kind: "discussion-comment",
      nodeId: "DC_kwDOSUXJQM4BANDD",
      url: "https://github.com/example/repo/discussions/4#discussioncomment-16830659",
    });
  });

  it("accepts webhook-style field names and sparse empty input", () => {
    expect(parseSourceComment("")).toBeUndefined();
    expect(encodeSourceComment(undefined)).toBe("");
    expect(
      parseSourceComment(
        JSON.stringify({
          html_url: "https://github.com/example/repo/pull/12#discussion_r88",
          id: 88,
          kind: "pull-request-review-comment",
          node_id: "PRRC_kwDOK",
        }),
      ),
    ).toMatchObject({
      id: "88",
      kind: "pull-request-review-comment",
      nodeId: "PRRC_kwDOK",
      url: "https://github.com/example/repo/pull/12#discussion_r88",
    });
    expect(
      parseSourceComment(
        JSON.stringify({
          body: "Please address these changes.",
          html_url: "https://github.com/example/repo/pull/12#pullrequestreview-1",
          id: 99,
          kind: "pull-request-review",
          node_id: "PRR_kwDOK",
        }),
      ),
    ).toMatchObject({
      body: "Please address these changes.",
      id: "99",
      kind: "pull-request-review",
      nodeId: "PRR_kwDOK",
      url: "https://github.com/example/repo/pull/12#pullrequestreview-1",
    });
  });

  it("rejects malformed source comment metadata", () => {
    expect(() => parseSourceComment("{bad")).toThrow("GITVIBE_SOURCE_COMMENT must be valid JSON");
    expect(() => parseSourceComment(JSON.stringify({ kind: "unknown" }))).toThrow(
      "GITVIBE_SOURCE_COMMENT must describe a valid source comment",
    );
    expect(encodeSourceComment({ kind: "unknown" })).toBe("");
    expect(encodeSourceComment(null)).toBe("");
    expect(encodeSourceComment([])).toBe("");
    expect(
      encodeSourceComment({
        body: " ",
        id: null,
        kind: "issue-comment",
        nodeId: "",
        url: undefined,
      }),
    ).toBe('{"kind":"issue-comment"}');
  });
});
