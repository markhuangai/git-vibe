// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { createGitVibeApp } from "../src/app/server.ts";
import { gitVibeInternalLabels } from "../src/shared/labels.ts";
import { reviewFixIssueMarker } from "../src/shared/traceability.ts";

describe("GitVibe app server review-fix labels", () => {
  it("accepts valid review-fix labels and rejects manual internal labels", async () => {
    const client = createClient();
    await createApp(client).handleWebhook("issues", {
      action: "labeled",
      issue: {
        body: reviewFixIssueMarker({
          branch: "git-vibe/7",
          depth: 1,
          parent: "7",
          root: "7",
        }),
        number: 8,
      },
      label: { name: gitVibeInternalLabels.reviewFix.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "DELETE")).toEqual([]);
    expect(workflowDispatches(client)).toEqual([]);

    const invalidClient = createClient();
    await createApp(invalidClient).handleWebhook("issues", {
      action: "labeled",
      issue: { body: "manual label", number: 10 },
      label: { name: gitVibeInternalLabels.reviewFix.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(invalidClient, "DELETE")).toContain(
      "/repos/example/repo/issues/10/labels/gvi%3Areview-fix",
    );
    expect(requestBodies(invalidClient, "POST", "/issues/10/comments")[0].body).toContain(
      "internal runtime labels",
    );
    expect(workflowDispatches(invalidClient)).toEqual([]);
  });
});

function createApp(client) {
  return createGitVibeApp({
    client,
    errorLog: vi.fn(),
    githubToken: "token",
    log: vi.fn(),
    webhookSecret: "secret",
  });
}

function createClient() {
  return {
    graphql: vi.fn(),
    request: vi.fn(async (request) => {
      if (request.path.includes("/collaborators/")) return { permission: "write" };
      if (request.method === "POST" && request.path.endsWith("/labels")) return {};
      if (request.method === "POST" && request.path.includes("/actions/workflows/")) return {};
      if (request.method === "DELETE" && request.path.includes("/labels/")) return {};
      if (request.method === "POST" && request.path.includes("/issues/")) return {};
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    }),
  };
}

function repositoryPayload() {
  return { name: "repo", owner: { login: "example" } };
}

function requestBodies(client, method, pathPart) {
  return client.request.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === method && request.path.includes(pathPart))
    .map((request) => request.body);
}

function requestPaths(client, method) {
  return client.request.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === method)
    .map((request) => request.path);
}

function workflowDispatches(client) {
  return client.request.mock.calls
    .map(([request]) => request)
    .filter((request) => request.path.includes("/actions/workflows/"))
    .map((request) => request.body);
}
