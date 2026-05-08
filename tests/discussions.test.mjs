// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { closeDiscussion, removeDiscussionLabel } from "../src/shared/discussions.ts";

describe("discussion label helpers", () => {
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

function createClient(options = {}) {
  return {
    graphql: vi.fn(async (query) => {
      if (query.includes("GitVibeDiscussionLabelId")) {
        return {
          repository: { label: options.missingLabel ? null : { id: "resolved-label-node" } },
        };
      }
      return {};
    }),
  };
}
