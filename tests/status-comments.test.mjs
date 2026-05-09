import { describe, expect, it } from "vitest";
import {
  matchesTransientStatusScope,
  parseTransientStatusMarker,
  stageStartMarker,
  workflowQueuedMarker,
  workflowRunIdFromUrl,
} from "../src/shared/status-comments.ts";

describe("transient status comment markers", () => {
  it("parses and matches queued workflow markers", () => {
    const body = [
      workflowQueuedMarker({
        artifact: "issue",
        number: "12",
        run: "99",
        workflow: "investigate workflow>.yml",
      }),
      "## GitVibe Workflow Queued",
    ].join("\n");

    const marker = parseTransientStatusMarker(body);

    expect(marker).toMatchObject({
      artifact: "issue",
      kind: "workflow-queued",
      number: "12",
      run: "99",
      workflow: "investigate-workflow.yml",
    });
    expect(
      matchesTransientStatusScope(marker, {
        artifact: "issue",
        kind: "workflow-queued",
        number: "12",
        run: "99",
      }),
    ).toBe(true);
    expect(
      matchesTransientStatusScope(marker, {
        artifact: "issue",
        kind: "workflow-queued",
        number: "12",
        run: "100",
      }),
    ).toBe(false);
  });

  it("parses stage-start markers and ignores durable result markers", () => {
    expect(
      parseTransientStatusMarker(
        stageStartMarker({
          artifact: "pull-request",
          number: "7",
          run: "44",
          stage: "address-pr-feedback",
        }),
      ),
    ).toMatchObject({
      artifact: "pull-request",
      kind: "stage-start",
      number: "7",
      run: "44",
      stage: "address-pr-feedback",
    });
    expect(
      parseTransientStatusMarker(
        "<!-- git-vibe:stage-result stage=validate artifact=issue number=12 -->",
      ),
    ).toBeUndefined();
  });
});

describe("transient status comment marker validation", () => {
  it("rejects malformed transient markers and mismatched scopes", () => {
    expect(
      parseTransientStatusMarker("<!-- git-vibe:workflow-queued artifact=issue number=12 -->"),
    ).toBeUndefined();
    expect(
      parseTransientStatusMarker("<!-- git-vibe:stage-start artifact=issue number=12 -->"),
    ).toBeUndefined();
    expect(
      parseTransientStatusMarker(
        "<!-- git-vibe:workflow-queued artifact=project number=12 workflow=run.yml -->",
      ),
    ).toBeUndefined();
    expect(parseTransientStatusMarker(null)).toBeUndefined();

    const marker = parseTransientStatusMarker(
      "<!-- git-vibe:stage-start artifact=issue number=12 stage=validate -->",
    );
    expect(
      matchesTransientStatusScope(marker, {
        artifact: "issue",
        kind: "workflow-queued",
        number: "12",
      }),
    ).toBe(false);
    expect(
      matchesTransientStatusScope(marker, {
        artifact: "issue",
        kind: "stage-start",
        number: "13",
      }),
    ).toBe(false);
    expect(
      matchesTransientStatusScope(marker, {
        artifact: "issue",
        kind: "stage-start",
        number: "12",
        stage: "investigate",
      }),
    ).toBe(false);
    const queued = parseTransientStatusMarker(
      "<!-- git-vibe:workflow-queued artifact=issue number=12 workflow=validate.yml -->",
    );
    expect(
      matchesTransientStatusScope(queued, {
        artifact: "issue",
        kind: "workflow-queued",
        number: "12",
        workflow: "investigate.yml",
      }),
    ).toBe(false);
    expect(
      matchesTransientStatusScope(undefined, {
        artifact: "issue",
        kind: "stage-start",
        number: "12",
      }),
    ).toBe(false);
  });

  it("extracts workflow run ids from GitHub run URLs", () => {
    expect(workflowRunIdFromUrl("https://github.com/example/repo/actions/runs/123456")).toBe(
      "123456",
    );
    expect(workflowRunIdFromUrl("https://github.com/example/repo/actions")).toBeUndefined();
  });
});
