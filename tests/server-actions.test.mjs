import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryActionsVariable = vi.fn();
const repositoryDefaultBranch = vi.fn();
const addDiscussionComment = vi.fn();
const deleteDiscussionComment = vi.fn();
const discussionComments = vi.fn();
const removeDiscussionLabel = vi.fn();
const removeIssueLabel = vi.fn();

vi.mock("../src/shared/github.js", () => ({
  GitHubClient: class GitHubClient {},
  repositoryActionsVariable,
  repositoryDefaultBranch,
}));
vi.mock("../src/shared/discussions.js", () => ({
  addDiscussionComment,
  deleteDiscussionComment,
  discussionComments,
  removeDiscussionLabel,
}));
vi.mock("../src/app/labels.js", () => ({ removeIssueLabel }));

const actions = await import("../src/app/server-actions.ts");

beforeEach(() => {
  for (const mock of [
    repositoryActionsVariable,
    repositoryDefaultBranch,
    addDiscussionComment,
    deleteDiscussionComment,
    discussionComments,
    removeDiscussionLabel,
    removeIssueLabel,
  ]) {
    mock.mockReset();
  }
  repositoryActionsVariable.mockResolvedValue("main");
  repositoryDefaultBranch.mockResolvedValue("default");
  removeIssueLabel.mockResolvedValue(undefined);
});

describe("server action workflow dispatch", () => {
  it("falls back when dispatch run details are unsupported", async () => {
    const context = actionContext();
    context.client.request
      .mockRejectedValueOnce(new Error("return_run_details is not a permitted key"))
      .mockResolvedValueOnce({});

    await expect(
      actions.dispatchWorkflow(context, "investigate.yml", { "issue-number": "12" }),
    ).resolves.toEqual({ ref: "main" });

    expect(context.client.request).toHaveBeenCalledTimes(2);
    expect(context.log).toHaveBeenCalledWith(
      expect.stringContaining("workflow dispatch run details unavailable"),
    );
  });

  it("falls back when dispatch run details rejection is not an Error object", async () => {
    const context = actionContext();
    context.client.request.mockRejectedValueOnce("not a permitted key").mockResolvedValueOnce({});

    await expect(actions.dispatchWorkflow(context, "investigate.yml", {})).resolves.toEqual({
      ref: "main",
    });
  });

  it("uses the repository default branch when no action ref variable is configured", async () => {
    repositoryActionsVariable.mockResolvedValueOnce("");
    const context = actionContext();
    context.client.request.mockResolvedValueOnce({ html_url: "run-url" });

    await expect(actions.dispatchWorkflow(context, "validate.yml", {})).resolves.toMatchObject({
      html_url: "run-url",
      ref: "default",
    });
  });

  it("rethrows workflow dispatch failures unrelated to run detail compatibility", async () => {
    const context = actionContext();
    context.client.request.mockRejectedValueOnce(new Error("network down"));

    await expect(actions.dispatchWorkflow(context, "validate.yml", {})).rejects.toThrow(
      "network down",
    );
    expect(context.client.request).toHaveBeenCalledTimes(1);
  });
});

describe("server action command acknowledgements", () => {
  it("acknowledges commands only when a comment node id is available", async () => {
    const missing = actionContext({ payload: { comment: {}, repository: repositoryPayload() } });
    await expect(actions.acknowledgeCommand(missing)).resolves.toBe(false);
    expect(missing.log).toHaveBeenCalledWith(expect.stringContaining("missing comment node_id"));

    const context = actionContext({ payload: { comment: { node_id: "node" } } });
    await expect(actions.acknowledgeCommand(context)).resolves.toBe(true);
    expect(context.client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("GitVibeAddReaction"),
      { content: "ROCKET", subjectId: "node" },
      "token",
    );

    context.client.graphql.mockRejectedValueOnce(new Error("boom"));
    await expect(actions.acknowledgeCommand(context)).resolves.toBe(false);
  });
});

describe("server action queued issue comments", () => {
  it("posts queued issue comments and removes matching stale comments", async () => {
    const context = actionContext();
    context.client.request
      .mockResolvedValueOnce([
        {
          body: "<!-- git-vibe:workflow-queued workflow=investigate.yml artifact=issue number=12 -->",
          id: 99,
        },
      ])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await actions.postQueuedWorkflowComment(context, {
      artifact: "issue",
      number: "12",
      reason: actions.commandReason("/git-vibe investigate"),
      ref: "main",
      workflow: "investigate.yml",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/1",
    });

    expect(context.client.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: expect.stringContaining("/99") }),
    );
    expect(context.client.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: expect.stringContaining("/comments") }),
    );
  });

  it("skips stale queued issue comments without ids", async () => {
    const context = actionContext();
    context.client.request
      .mockResolvedValueOnce([
        {
          body: "<!-- git-vibe:workflow-queued workflow=investigate.yml artifact=issue number=12 -->",
        },
      ])
      .mockResolvedValueOnce({});

    await actions.postQueuedWorkflowComment(context, {
      artifact: "issue",
      number: "12",
      reason: actions.commandReason("/git-vibe investigate"),
      ref: "main",
      workflow: "investigate.yml",
    });

    expect(context.client.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("server action queued discussion comments", () => {
  it("posts queued discussion comments and removes matching stale comments", async () => {
    const context = actionContext({ payload: { discussion: { node_id: "discussion-node" } } });
    discussionComments.mockResolvedValueOnce([
      {
        body: "<!-- git-vibe:workflow-queued workflow=decompose.yml artifact=discussion number=3 -->",
        id: "comment-node",
      },
      {
        body: "<!-- git-vibe:workflow-queued workflow=investigate.yml artifact=issue number=12 -->",
        id: "other-comment-node",
      },
    ]);

    await actions.postQueuedWorkflowComment(context, {
      artifact: "discussion",
      number: "3",
      reason: actions.labelReason("git-vibe:decompose"),
      ref: "main",
      workflow: "decompose.yml",
    });

    expect(deleteDiscussionComment).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: "comment-node" }),
    );
    expect(addDiscussionComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("GitVibe queued `decompose.yml`"),
        discussionId: "discussion-node",
      }),
    );
  });

  it("logs queued comment creation failures after cleanup", async () => {
    const context = actionContext();
    context.client.request.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("denied"));

    await actions.postQueuedWorkflowComment(context, {
      artifact: "issue",
      number: "12",
      reason: actions.commandReason("/git-vibe investigate"),
      ref: "main",
      workflow: "investigate.yml",
    });

    expect(context.log).toHaveBeenCalledWith(expect.stringContaining("queued comment failed"));
  });

  it("skips queued discussion cleanup and creation when the discussion id is missing", async () => {
    const context = actionContext({ payload: { discussion: {} } });

    await actions.postQueuedWorkflowComment(context, {
      artifact: "discussion",
      number: "3",
      reason: actions.labelReason("git-vibe:decompose"),
      ref: "main",
      workflow: "decompose.yml",
    });

    expect(discussionComments).not.toHaveBeenCalled();
    expect(addDiscussionComment).not.toHaveBeenCalled();
    expect(context.log).toHaveBeenCalledWith(expect.stringContaining("missing discussion node_id"));
  });
});

describe("server action discussion and issue labels", () => {
  it("handles discussion comments and labels by node id", async () => {
    const context = actionContext({
      payload: {
        discussion: { node_id: "discussion-node", number: 3 },
        label: { id: "label-node", name: "git-vibe:approved" },
      },
    });

    await actions.createDiscussionComment(context, "body");
    await actions.removeDiscussionLabelFromPayload(context, "git-vibe:approved");

    expect(addDiscussionComment).toHaveBeenCalledWith(
      expect.objectContaining({ discussionId: "discussion-node" }),
    );
    expect(removeDiscussionLabel).toHaveBeenCalledWith(
      expect.objectContaining({ labelId: "label-node" }),
    );
  });

  it("logs best-effort discussion label cleanup failures", async () => {
    const context = actionContext({ payload: { discussion: {}, label: {} } });

    await expect(
      actions.removeDiscussionLabelBestEffort(context, "git-vibe:approved"),
    ).resolves.toBeUndefined();

    expect(context.log).toHaveBeenCalledWith(expect.stringContaining("discussion label cleanup"));
  });

  it("skips missing discussion ids when creating discussion comments", async () => {
    const context = actionContext({ payload: { discussion: {} } });

    await actions.createDiscussionComment(context, "body");

    expect(addDiscussionComment).not.toHaveBeenCalled();
    expect(context.log).toHaveBeenCalledWith(expect.stringContaining("missing discussion node_id"));
  });

  it("ignores missing issue labels and rethrows other removal errors", async () => {
    const context = actionContext();
    removeIssueLabel.mockRejectedValueOnce(new Error("404 Not Found"));

    await expect(
      actions.removeIssueLabelIfPresent(context, "12", "gvi:ready-for-approval"),
    ).resolves.toBeUndefined();

    removeIssueLabel.mockRejectedValueOnce(new Error("permission denied"));
    await expect(
      actions.removeIssueLabelIfPresent(context, "12", "gvi:ready-for-approval"),
    ).rejects.toThrow("permission denied");
  });
});

describe("server action pull request labels", () => {
  it("updates pull request lifecycle labels from traceability", async () => {
    const context = actionContext({
      payload: {
        pull_request: {
          body: "## GitVibe Traceability\n\nRefs #12",
          number: 5,
        },
      },
    });

    await actions.markPullRequestApproved(context, "5");
    await actions.markPullRequestMerged(context, "5");

    expect(context.client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { labels: ["gvi:pr-approved"] },
        path: "/repos/example/repo/issues/5/labels",
      }),
    );
    expect(removeIssueLabel.mock.calls.map(([request]) => request)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ issueNumber: "5", label: "gvi:ready-for-approval" }),
        expect.objectContaining({ issueNumber: "5", label: "git-vibe:ready-for-approval" }),
        expect.objectContaining({ issueNumber: "12", label: "gvi:pr-opened" }),
        expect.objectContaining({ issueNumber: "12", label: "git-vibe:pr-opened" }),
      ]),
    );
  });
});

describe("server action formatting helpers", () => {
  it("encodes source comment and review metadata", () => {
    expect(
      actions.commandInputs(
        actionContext({ payload: { comment: { id: 1, node_id: "node", url: "comment-url" } } }),
        { "issue-number": "12" },
        "issue-comment",
      ),
    ).toMatchObject({
      "issue-number": "12",
      "source-comment": expect.stringContaining("issue-comment"),
    });
    expect(actions.sourceReviewInput(actionContext())).toBe("");
    expect(
      actions.sourceReviewInput(
        actionContext({ payload: { review: { id: 2, node_id: "review-node" } } }),
      ),
    ).toContain("pull-request-review");
  });

  it("formats label and command decisions", () => {
    expect(actions.commandWorkflow("investigate")).toBe("investigate.yml");
    expect(actions.commandWorkflow("unknown")).toBeNull();
    expect(
      actions.issueHasLabel({ labels: [{ name: "gvi:investigated" }] }, "gvi:investigated"),
    ).toBe(true);
    expect(
      actions.issueHasLabel({ labels: [{ name: "git-vibe:investigated" }] }, "gvi:investigated"),
    ).toBe(true);
    expect(actions.issueHasLabel(undefined, "gvi:investigated")).toBe(false);
    expect(actions.labelReason("git-vibe:validate")).toContain("git-vibe:validate");
    expect(actions.protectedLabelRejectionBody(actionContext(), "git-vibe:approved")).toContain(
      "@alice",
    );
    expect(actions.internalLabelRejectionBody("gvi:internal")).toContain("internal");
    expect(actions.approvalRequiresInvestigationBody("git-vibe:approved")).toContain(
      "git-vibe:investigate",
    );
  });
});

/**
 * @param {Partial<import("../src/app/server-actions.ts").WebhookActionContext>} [overrides]
 * @returns {import("../src/app/server-actions.ts").WebhookActionContext & {
 *   client: {
 *     graphql: ReturnType<typeof vi.fn>;
 *     request: ReturnType<typeof vi.fn>;
 *   };
 *   log: ReturnType<typeof vi.fn>;
 * }}
 */
function actionContext(overrides = {}) {
  return /** @type {ReturnType<typeof actionContext>} */ ({
    client: {
      graphql: vi.fn().mockResolvedValue({}),
      request: vi.fn().mockResolvedValue({}),
    },
    log: vi.fn(),
    owner: "example",
    payload: {
      repository: repositoryPayload(),
      sender: { login: "alice" },
    },
    repo: "repo",
    token: "token",
    ...overrides,
  });
}

function repositoryPayload() {
  return { name: "repo", owner: { login: "example" } };
}
