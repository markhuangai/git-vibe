// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import {
  addDiscussionComment,
  addDiscussionLabel,
  closeDiscussion,
  deleteDiscussionComment,
  discussionComments,
  discussionLabels,
  removeDiscussionLabel,
} from "../src/shared/discussions.ts";

describe("discussion label helpers", () => {
  it("adds labels with the resolved label node ID", async () => {
    const client = createClient();

    await addDiscussionLabel({
      client,
      discussionId: "discussion-node",
      label: "gvi:validated",
      repository: "example/repo",
      token: "token",
    });

    expect(client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("GitVibeDiscussionLabelId"),
      { label: "gvi:validated", name: "repo", owner: "example" },
      "token",
    );
    expect(client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("GitVibeAddDiscussionLabel"),
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
      "token",
    );
  });

  it("removes labels with the supplied label node ID", async () => {
    const client = createClient();

    await removeDiscussionLabel({
      client,
      discussionId: "discussion-node",
      label: "git-vibe:validate",
      labelId: "label-node",
      repository: "example/repo",
      token: "token",
    });

    expect(client.graphql).toHaveBeenCalledTimes(1);
    expect(client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("GitVibeRemoveDiscussionLabel"),
      { discussionId: "discussion-node", labelIds: ["label-node"] },
      "token",
    );
    const mutation = client.graphql.mock.calls[0][0];
    expect(mutation).toContain("clientMutationId");
    expect(mutation).not.toContain("labelable {");
  });

  it("resolves missing label node IDs before removing labels", async () => {
    const client = createClient();

    await removeDiscussionLabel({
      client,
      discussionId: "discussion-node",
      label: "git-vibe:validate",
      repository: "example/repo",
      token: "token",
    });

    expect(client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("GitVibeDiscussionLabelId"),
      { label: "git-vibe:validate", name: "repo", owner: "example" },
      "token",
    );
    expect(client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("GitVibeRemoveDiscussionLabel"),
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
      "token",
    );
  });

  it("fails when GitHub cannot resolve a label node ID", async () => {
    const client = createClient({ missingLabel: true });

    await expect(
      removeDiscussionLabel({
        client,
        discussionId: "discussion-node",
        label: "git-vibe:missing",
        repository: "example/repo",
        token: "token",
      }),
    ).rejects.toThrow("GitHub label git-vibe:missing was not found in example/repo");
  });

  it("closes discussions as resolved", async () => {
    const client = createClient();

    await closeDiscussion({ client, discussionId: "discussion-node", token: "token" });

    expect(client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("GitVibeCloseDiscussion"),
      { discussionId: "discussion-node" },
      "token",
    );
  });
});

describe("discussion comment helpers", () => {
  it("adds, lists, and deletes discussion comments", async () => {
    const client = createClient();

    await expect(
      addDiscussionComment({
        body: "Queued.",
        client,
        discussionId: "discussion-node",
        token: "token",
      }),
    ).resolves.toEqual({ id: "comment-node", url: "comment-url" });
    await expect(
      discussionComments({ client, discussionId: "discussion-node", token: "token" }),
    ).resolves.toEqual([
      {
        body: "Top-level",
        id: "comment-node",
        replies: { nodes: [{ body: "Reply", id: "reply-node", url: "reply-url" }] },
        url: "comment-url",
      },
      { body: "Reply", id: "reply-node", url: "reply-url" },
    ]);
    await deleteDiscussionComment({ client, commentId: "comment-node", token: "token" });

    expect(client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("GitVibeDeleteDiscussionComment"),
      { id: "comment-node" },
      "token",
    );
  });

  it("returns an empty list when discussion comments are unavailable", async () => {
    const client = createClient({ missingDiscussionComments: true });

    await expect(
      discussionComments({ client, discussionId: "discussion-node", token: "token" }),
    ).resolves.toEqual([]);
  });

  it("lists discussion comments that have no replies", async () => {
    const client = createClient({ noDiscussionReplies: true });

    await expect(
      discussionComments({ client, discussionId: "discussion-node", token: "token" }),
    ).resolves.toEqual([{ body: "Top-level", id: "comment-node", url: "comment-url" }]);
  });

  it("paginates discussion comments and replies", async () => {
    const client = createClient({ paginatedDiscussionComments: true });

    await expect(
      discussionComments({ client, discussionId: "discussion-node", token: "token" }),
    ).resolves.toEqual([
      {
        body: "Top-level 1",
        id: "comment-1",
        replies: {
          nodes: [
            { body: "Reply 1", id: "reply-1", url: "reply-url-1" },
            { body: "Reply 2", id: "reply-2", url: "reply-url-2" },
          ],
        },
        url: "comment-url-1",
      },
      { body: "Reply 1", id: "reply-1", url: "reply-url-1" },
      { body: "Reply 2", id: "reply-2", url: "reply-url-2" },
      {
        body: "Top-level 2",
        id: "comment-2",
        replies: { nodes: [] },
        url: "comment-url-2",
      },
    ]);
  });
});

describe("discussion label listing", () => {
  it("returns discussion label names", async () => {
    const client = createClient();

    await expect(
      discussionLabels({ client, discussionId: "discussion-node", token: "token" }),
    ).resolves.toEqual(["gvi:validated", "git-vibe:approved"]);
  });

  it("paginates discussion label names", async () => {
    const client = createClient({ paginatedDiscussionLabels: true });

    await expect(
      discussionLabels({ client, discussionId: "discussion-node", token: "token" }),
    ).resolves.toEqual(["first", "second"]);
  });

  it("returns an empty label list when labels are unavailable", async () => {
    const client = createClient({ missingDiscussionLabels: true });

    await expect(
      discussionLabels({ client, discussionId: "discussion-node", token: "token" }),
    ).resolves.toEqual([]);
  });
});

function createClient(options = {}) {
  return {
    graphql: vi.fn(async (query, variables = {}) =>
      discussionGraphqlResponse(query, variables, options),
    ),
  };
}

function discussionGraphqlResponse(query, variables, options) {
  if (query.includes("GitVibeDiscussionLabelId")) {
    return {
      repository: { label: options.missingLabel ? null : { id: "resolved-label-node" } },
    };
  }
  if (query.includes("GitVibeAddDiscussionComment")) {
    return { addDiscussionComment: { comment: { id: "comment-node", url: "comment-url" } } };
  }
  if (query.includes("GitVibeDiscussionCommentReplies")) return paginatedRepliesResponse();
  if (query.includes("GitVibeDiscussionComments")) {
    return discussionCommentsResponse(options, variables);
  }
  if (query.includes("GitVibeDiscussionLabels")) {
    return discussionLabelsResponse(options, variables);
  }
  if (query.includes("GitVibeAddDiscussionLabel")) {
    return { addLabelsToLabelable: { clientMutationId: null } };
  }
  return {};
}

function paginatedRepliesResponse() {
  return {
    node: {
      replies: {
        nodes: [{ body: "Reply 2", id: "reply-2", url: "reply-url-2" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

function discussionCommentsResponse(options, variables) {
  if (options.missingDiscussionComments) return { node: null };
  if (options.paginatedDiscussionComments && variables.commentsAfter) {
    return {
      node: {
        comments: {
          nodes: [
            {
              body: "Top-level 2",
              id: "comment-2",
              replies: { nodes: [] },
              url: "comment-url-2",
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  }
  if (options.paginatedDiscussionComments) return paginatedCommentsResponse();
  return standardCommentsResponse(options);
}

function paginatedCommentsResponse() {
  return {
    node: {
      comments: {
        nodes: [
          {
            body: "Top-level 1",
            id: "comment-1",
            replies: {
              nodes: [{ body: "Reply 1", id: "reply-1", url: "reply-url-1" }],
              pageInfo: { hasNextPage: true, endCursor: "reply-cursor" },
            },
            url: "comment-url-1",
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "comment-cursor" },
      },
    },
  };
}

function standardCommentsResponse(options) {
  return {
    node: {
      comments: {
        nodes: [
          {
            body: "Top-level",
            id: "comment-node",
            replies: options.noDiscussionReplies
              ? undefined
              : { nodes: [{ body: "Reply", id: "reply-node", url: "reply-url" }] },
            url: "comment-url",
          },
        ],
      },
    },
  };
}

function discussionLabelsResponse(options, variables) {
  if (options.missingDiscussionLabels) return { node: null };
  if (options.paginatedDiscussionLabels && variables.labelsAfter) {
    return {
      node: {
        labels: {
          nodes: [{ name: "second" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  }
  if (options.paginatedDiscussionLabels) {
    return {
      node: {
        labels: {
          nodes: [{ name: "first" }],
          pageInfo: { hasNextPage: true, endCursor: "label-cursor" },
        },
      },
    };
  }
  return {
    node: {
      labels: {
        nodes: [{ name: "gvi:validated" }, { name: "git-vibe:approved" }],
      },
    },
  };
}
