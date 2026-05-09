// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { workflowQueuedMarker } from "../src/shared/status-comments.ts";
import {
  createApp,
  createClient,
  repositoryPayload,
  requestBodies,
  requestPaths,
} from "./support/server-app.mjs";

describe("GitVibe app server status comment cleanup", () => {
  it("cleans previous queued workflow comments before posting a new queued comment", async () => {
    const client = createClient({
      comments: [
        {
          body: workflowQueuedMarker({
            artifact: "issue",
            number: "2",
            workflow: "investigate.yml",
          }),
          id: 77,
        },
        {
          body: "<!-- git-vibe:stage-result stage=investigate artifact=issue number=2 -->",
          id: 78,
        },
      ],
    });
    const app = createApp({ client });

    await app.handleWebhook("issue_comment", {
      action: "created",
      comment: { body: "/git-vibe investigate" },
      issue: { number: 2 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "DELETE")).toEqual(["/repos/example/repo/issues/comments/77"]);
    expect(requestBodies(client, "POST", "/issues/2/comments").at(-1).body).toContain(
      "GitVibe Workflow Queued",
    );
  });

  it("logs cleanup failures and still posts the queued workflow comment", async () => {
    const log = vi.fn();
    const client = createClient({ commentsError: new Error("comments unavailable") });
    const app = createApp({ client, log });

    await app.handleWebhook("issue_comment", {
      action: "created",
      comment: { body: "/git-vibe investigate" },
      issue: { number: 2 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(log).toHaveBeenCalledWith(
      "workflow queued comment cleanup failed: comments unavailable",
    );
    expect(requestBodies(client, "POST", "/issues/2/comments").at(-1).body).toContain(
      "GitVibe Workflow Queued",
    );
  });
});
