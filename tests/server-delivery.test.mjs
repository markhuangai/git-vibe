// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  createApp,
  createClient,
  repositoryPayload,
  requestJson,
  signature,
  withHttpServer,
  workflowDispatches,
} from "./support/server-app.mjs";

describe("GitVibe app delivery de-duplication", () => {
  it("deduplicates repeated GitHub deliveries before dispatching workflows", async () => {
    const client = createClient();
    const app = createApp({ client });
    const payload = {
      action: "created",
      comment: {
        body: "/git-vibe investigate",
        html_url: "https://github.com/example/repo/issues/9#issuecomment-1",
        id: 1,
        node_id: "issue-comment-node",
      },
      issue: { number: 9 },
      repository: repositoryPayload(),
      sender: { login: "owner" },
    };
    const body = JSON.stringify(payload);
    const headers = {
      "x-github-delivery": "delivery-1",
      "x-github-event": "issue_comment",
      "x-hub-signature-256": signature(body),
    };

    await withHttpServer(app.handleRequest, async (url) => {
      await expect(requestJson(url, "POST", "/webhooks", body, headers)).resolves.toMatchObject({
        body: { accepted: true, event: "issue_comment" },
        status: 202,
      });
      await expect(requestJson(url, "POST", "/webhooks", body, headers)).resolves.toMatchObject({
        body: { accepted: true, duplicate: true, event: "issue_comment" },
        status: 202,
      });
    });

    expect(workflowDispatches(client)).toHaveLength(1);
  });
});
