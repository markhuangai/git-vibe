// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { blockUnvalidatedDecompose } from "../src/runner/decompose-gate.ts";
import { cleanupPriorDecomposeResultComments } from "../src/runner/decompose-results.ts";
import {
  applyDiscussionStageLabelTransition,
  applyDiscussionStageStartLabelTransition,
} from "../src/runner/stage-discussion-labels.ts";
import { gitVibeLabels } from "../src/shared/labels.ts";

describe("decompose validation gate", () => {
  it("skips non-decompose and already validated discussions", async () => {
    const buildResult = vi.fn();

    await expect(
      blockUnvalidatedDecompose({
        buildResult,
        client: createClient(),
        context: context({ labels: [] }),
        logger: logger(),
        runner: runner({ stage: "summarize" }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      blockUnvalidatedDecompose({
        buildResult,
        client: createClient(),
        context: context({ labels: [gitVibeLabels.validated.name] }),
        logger: logger(),
        runner: runner({ stage: "decompose" }),
      }),
    ).resolves.toBeUndefined();

    expect(buildResult).not.toHaveBeenCalled();
  });

  it("accepts legacy validation labels and missing label lists", async () => {
    const buildResult = vi.fn(async () => ({
      parsedOutput: { status: "blocked" },
      schemaId: "decompose.v1",
      status: "blocked",
      summary: "blocked",
      validationErrors: [],
    }));

    await expect(
      blockUnvalidatedDecompose({
        buildResult,
        client: createClient(),
        context: context({ labels: ["git-vibe:validated"] }),
        logger: logger(),
        runner: runner({ stage: "decompose" }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      blockUnvalidatedDecompose({
        buildResult,
        client: createClient(),
        context: context({ labels: undefined }),
        logger: logger(),
        runner: runner({ dryRun: true, stage: "decompose" }),
      }),
    ).resolves.toMatchObject({ status: "blocked" });

    expect(buildResult).toHaveBeenCalledTimes(1);
  });

  it("returns a blocked dry-run result without publishing", async () => {
    const buildResult = vi.fn(async () => ({
      parsedOutput: { status: "blocked" },
      schemaId: "decompose.v1",
      status: "blocked",
      summary: "blocked",
      validationErrors: [],
    }));
    const client = createClient();

    await expect(
      blockUnvalidatedDecompose({
        buildResult,
        client,
        context: context({ labels: [] }),
        logger: logger(),
        runner: runner({ dryRun: true, stage: "decompose" }),
      }),
    ).resolves.toMatchObject({ status: "blocked" });

    expect(buildResult.mock.calls[0][0]).toContain('"story_units":[]');
    expect(client.graphql).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe("decompose result cleanup", () => {
  it("deletes only matching prior decompose comments", async () => {
    const client = createClient();

    await cleanupPriorDecomposeResultComments({
      client,
      context: context({
        timeline: [
          decomposeComment("old-1", "12"),
          decomposeComment("other-discussion", "99"),
          { body: "human comment", id: "human", kind: "comment" },
        ],
      }),
      logger: logger(),
      runner: runner({ stage: "decompose" }),
    });

    expect(deletedCommentIds(client)).toEqual(["old-1"]);
  });

  it("deduplicates matching prior decompose comment ids", async () => {
    const client = createClient();

    await cleanupPriorDecomposeResultComments({
      client,
      context: context({
        timeline: [decomposeComment("old-1", "12"), decomposeComment("old-1", "12")],
      }),
      logger: logger(),
      runner: runner({ stage: "decompose" }),
    });

    expect(deletedCommentIds(client)).toEqual(["old-1"]);
  });

  it("skips cleanup outside decompose discussions and ignores missing comments", async () => {
    const client = createClient({ deleteError: new Error("GitHub GraphQL failed: 404") });

    await cleanupPriorDecomposeResultComments({
      client,
      context: context({ timeline: [decomposeComment("old-1", "12")] }),
      logger: logger(),
      runner: runner({ stage: "summarize" }),
    });
    await expect(
      cleanupPriorDecomposeResultComments({
        client,
        context: context({ timeline: [decomposeComment("old-1", "12")] }),
        logger: logger(),
        runner: runner({ stage: "decompose" }),
      }),
    ).resolves.toBeUndefined();

    expect(deletedCommentIds(client)).toEqual(["old-1"]);
  });

  it("rethrows unexpected delete failures", async () => {
    const client = createClient({ deleteError: new Error("delete unavailable") });
    const log = logger();

    await expect(
      cleanupPriorDecomposeResultComments({
        client,
        context: context({ timeline: [decomposeComment("old-1", "12")] }),
        logger: log,
        runner: runner({ stage: "decompose" }),
      }),
    ).rejects.toThrow("delete unavailable");
    expect(log.event).toHaveBeenCalledWith(
      "github.decompose_result.delete.failed",
      expect.objectContaining({ discussion: "12" }),
    );
  });

  it("logs non-error delete failures before rethrowing", async () => {
    const client = createClient({ deleteError: "delete unavailable" });
    const log = logger();

    await expect(
      cleanupPriorDecomposeResultComments({
        client,
        context: context({ timeline: [decomposeComment("old-1", "12")] }),
        logger: log,
        runner: runner({ stage: "decompose" }),
      }),
    ).rejects.toBe("delete unavailable");
    expect(log.event).toHaveBeenCalledWith(
      "github.decompose_result.delete.failed",
      expect.objectContaining({ error: "delete unavailable" }),
    );
  });
});

describe("discussion stage label helpers", () => {
  it("applies start transitions for validate", async () => {
    const client = createClient();

    await applyDiscussionStageStartLabelTransition({
      client,
      context: context(),
      logger: logger(),
      runner: runner({ stage: "validate" }),
    });

    expect(resolvedLabels(client)).toEqual([
      "gvi:validated",
      "git-vibe:validated",
      "gvi:blocked",
      "git-vibe:blocked",
      "gvi:validating",
    ]);
  });

  it("applies start transitions for decompose", async () => {
    const client = createClient();

    await applyDiscussionStageStartLabelTransition({
      client,
      context: context(),
      logger: logger(),
      runner: runner({ stage: "decompose" }),
    });

    expect(resolvedLabels(client)).toEqual([
      "gvi:decomposed",
      "git-vibe:decomposed",
      "gvi:blocked",
      "git-vibe:blocked",
      "git-vibe:decompose",
      "gvi:decomposing",
    ]);
  });

  it("applies blocked validation and decomposition transitions", async () => {
    const client = createClient();

    await applyDiscussionStageLabelTransition({
      client,
      context: context(),
      logger: logger(),
      parsedOutput: { next_state: "blocked", status: "blocked" },
      runner: runner({ stage: "validate" }),
    });
    await applyDiscussionStageLabelTransition({
      client,
      context: context(),
      logger: logger(),
      parsedOutput: { next_state: "blocked", status: "blocked" },
      runner: runner({ stage: "decompose" }),
    });

    expect(addedLabelIds(client)).toEqual(["gvi:blocked-id", "gvi:blocked-id"]);
  });
});

describe("discussion stage label ready states", () => {
  it("applies completed validation and decomposition transitions", async () => {
    const client = createClient();

    await applyDiscussionStageLabelTransition({
      client,
      context: context(),
      logger: logger(),
      parsedOutput: { next_state: "ready_for_approval", status: "completed" },
      runner: runner({ stage: "validate" }),
    });
    await applyDiscussionStageLabelTransition({
      client,
      context: context(),
      logger: logger(),
      parsedOutput: { status: "completed" },
      runner: runner({ stage: "decompose" }),
    });

    expect(addedLabelIds(client)).toEqual(["gvi:validated-id", "gvi:decomposed-id"]);
  });

  it("recognizes supported ready states for validation", async () => {
    const client = createClient();

    for (const nextState of [
      " ready ",
      "discussion:ready",
      "ready-for-implementation",
      "awaiting ready for approval",
    ]) {
      await applyDiscussionStageLabelTransition({
        client,
        context: context(),
        logger: logger(),
        parsedOutput: { next_state: nextState },
        runner: runner({ stage: "validate" }),
      });
    }

    expect(addedLabelIds(client)).toEqual([
      "gvi:validated-id",
      "gvi:validated-id",
      "gvi:validated-id",
      "gvi:validated-id",
    ]);
  });

  it("skips unsupported discussion stages", async () => {
    const client = createClient();

    await applyDiscussionStageStartLabelTransition({
      client,
      context: context(),
      logger: logger(),
      runner: runner({ stage: "summarize" }),
    });
    await applyDiscussionStageLabelTransition({
      client,
      context: context(),
      logger: logger(),
      parsedOutput: { status: "completed" },
      runner: runner({ stage: "summarize" }),
    });

    expect(client.graphql).not.toHaveBeenCalled();
  });
});

describe("discussion stage label helper errors", () => {
  it("skips labels when the discussion id is missing", async () => {
    const client = createClient();
    const log = logger();

    await applyDiscussionStageStartLabelTransition({
      client,
      context: context({ id: undefined }),
      logger: log,
      runner: runner({ stage: "validate" }),
    });

    expect(client.graphql).not.toHaveBeenCalled();
    expect(log.event).toHaveBeenCalledWith(
      "github.discussion.label.skip",
      expect.objectContaining({ reason: "missing-discussion-id" }),
    );
  });

  it("ignores missing labels and rethrows unexpected removal failures", async () => {
    await expect(
      applyDiscussionStageStartLabelTransition({
        client: createClient({ removeError: new Error("GitHub GraphQL failed: 404") }),
        context: context(),
        logger: logger(),
        runner: runner({ stage: "validate" }),
      }),
    ).resolves.toBeUndefined();

    const log = logger();
    await expect(
      applyDiscussionStageStartLabelTransition({
        client: createClient({ removeError: new Error("remove unavailable") }),
        context: context(),
        logger: log,
        runner: runner({ stage: "validate" }),
      }),
    ).rejects.toThrow("remove unavailable");
    expect(log.event).toHaveBeenCalledWith(
      "github.discussion.label.remove.failed",
      expect.objectContaining({ label: "gvi:validated" }),
    );
  });

  it("logs non-error label removal failures before rethrowing", async () => {
    const log = logger();

    await expect(
      applyDiscussionStageStartLabelTransition({
        client: createClient({ removeError: "remove unavailable" }),
        context: context(),
        logger: log,
        runner: runner({ stage: "validate" }),
      }),
    ).rejects.toBe("remove unavailable");
    expect(log.event).toHaveBeenCalledWith(
      "github.discussion.label.remove.failed",
      expect.objectContaining({ error: "remove unavailable" }),
    );
  });
});

function context(options = {}) {
  const artifact = {
    body: "Body",
    id: options.id === undefined && !("id" in options) ? "discussion-node" : options.id,
    number: "12",
    title: "Title",
    type: "discussion",
    url: "https://github.com/example/repo/discussions/12",
  };
  if (!("labels" in options) || options.labels !== undefined) {
    artifact.labels = options.labels || [];
  }

  return {
    artifact,
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: options.timeline || [],
  };
}

function runner(overrides = {}) {
  return {
    cwd: "/repo",
    dryRun: false,
    issueNumber: "",
    maxTurns: 2,
    prNumber: "",
    repository: "example/repo",
    stage: "decompose",
    stageTimeoutMinutes: 1,
    token: "token",
    ...overrides,
  };
}

function createClient(options = {}) {
  return {
    graphql: vi.fn(async (query, variables) => {
      if (query.includes("GitVibeDiscussionLabelId")) {
        return { repository: { label: { id: `${variables.label}-id` } } };
      }
      if (query.includes("GitVibeRemoveDiscussionLabel")) {
        if (options.removeError) throw options.removeError;
        return { removeLabelsFromLabelable: { clientMutationId: null } };
      }
      if (query.includes("GitVibeDeleteDiscussionComment")) {
        if (options.deleteError) throw options.deleteError;
        return { deleteDiscussionComment: { clientMutationId: null } };
      }
      return { addLabelsToLabelable: { clientMutationId: null } };
    }),
    request: vi.fn(),
  };
}

function logger() {
  return { event: vi.fn() };
}

function decomposeComment(id, number) {
  return {
    body: `<!-- git-vibe:decompose-result artifact=discussion number=${number} schema=decompose.v1 -->`,
    createdAt: "2026-01-01T00:00:00Z",
    id,
    kind: "comment",
    url: `https://github.com/example/repo/discussions/12#discussioncomment-${id}`,
  };
}

function deletedCommentIds(client) {
  return client.graphql.mock.calls
    .filter(([query]) => query.includes("GitVibeDeleteDiscussionComment"))
    .map(([, variables]) => variables.id);
}

function resolvedLabels(client) {
  return client.graphql.mock.calls
    .filter(([query]) => query.includes("GitVibeDiscussionLabelId"))
    .map(([, variables]) => variables.label);
}

function addedLabelIds(client) {
  return client.graphql.mock.calls
    .filter(([query]) => query.includes("GitVibeAddDiscussionLabel"))
    .map(([, variables]) => variables.labelIds[0]);
}
