// @ts-nocheck
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createGitVibeApp, isDirectRun, startServerFromEnv } from "../src/app/server.ts";
import { gitVibeLabels } from "../src/shared/labels.ts";

describe("GitVibe app server", () => {
  it("handles health, not found, signature errors, and accepted webhooks", async () => {
    const client = createClient();
    const app = createApp({ client });

    await withHttpServer(app.handleRequest, async (url) => {
      await expect(requestJson(url, "GET", "/health")).resolves.toMatchObject({
        body: { ok: true },
        status: 200,
      });
      await expect(requestJson(url, "GET", "/missing")).resolves.toMatchObject({
        body: { error: "not_found" },
        status: 404,
      });
      await expect(requestJson(url, "POST", "/webhooks", "{}")).resolves.toMatchObject({
        body: { error: "missing GitHub signature" },
        status: 401,
      });

      const body = JSON.stringify({ action: "ignored", repository: repositoryPayload() });
      await expect(
        requestJson(url, "POST", "/webhooks", body, {
          "x-github-event": "ping",
          "x-hub-signature-256": signature(body),
        }),
      ).resolves.toMatchObject({
        body: { accepted: true, event: "ping" },
        status: 202,
      });
    });
  });

  it("checks discussion setup during startup preflight", async () => {
    const log = vi.fn();
    const errorLog = vi.fn();
    const matching = createApp({
      client: createClient(),
      configuredRepository: "example/repo",
      errorLog,
      log,
    });

    await matching.runStartupPreflight();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("startup preflight ok"));

    const fallback = createApp({
      client: createClient({ categories: [{ id: "general", name: "General", slug: "general" }] }),
      configuredRepository: "example/repo",
      log,
    });
    await fallback.runStartupPreflight();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("startup preflight warning"));

    const missing = createApp({ client: createClient(), log });
    await missing.runStartupPreflight();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("startup preflight skipped"));

    const failing = createApp({
      client: createClient({ categories: [] }),
      configuredRepository: "example/repo",
      errorLog,
    });
    await failing.runStartupPreflight();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("startup preflight failed"));
  });
});

describe("GitVibe app server issue intake", () => {
  it("converts feature issue forms into discussions", async () => {
    const client = createClient();
    const app = createApp({ client });

    await app.handleWebhook("issues", {
      action: "opened",
      issue: featureIssue(),
      repository: repositoryPayload(),
      sender: { login: "owner" },
    });

    expect(client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("GitVibeCreateDiscussion"),
      expect.objectContaining({
        body: expect.stringContaining("git-vibe:source-issue"),
        title: "[Feature]: Add workflows",
      }),
      "token",
    );
    expect(requestBodies(client, "POST", "/issues/2/comments")[0].body).toContain(
      "converted-to-discussion",
    );
    expect(requestBodies(client, "PATCH", "/issues/2")[0]).toMatchObject({
      state: "closed",
      state_reason: "completed",
    });
  });

  it("comments setup guidance when discussion conversion fails", async () => {
    const client = createClient({ categories: [] });
    const app = createApp({ client });

    await app.handleWebhook("issues", {
      action: "opened",
      issue: featureIssue(),
      repository: repositoryPayload(),
      sender: { login: "owner" },
    });

    expect(requestBodies(client, "POST", "/issues/2/comments")[0].body).toContain(
      "could not move this feature request",
    );
  });

  it("ignores non-feature and already converted issues", async () => {
    const client = createClient();
    const app = createApp({ client });

    await app.handleWebhook("issues", {
      action: "opened",
      issue: { body: "### Request type\n\nBug report", number: 2 },
      repository: repositoryPayload(),
    });
    await app.handleWebhook("issues", {
      action: "opened",
      issue: { ...featureIssue(), body: "<!-- git-vibe:converted-to-discussion -->" },
      repository: repositoryPayload(),
    });

    expect(requestBodies(client, "POST", "/issues/2/comments")).toEqual([]);
  });
});

describe("GitVibe app server command dispatch", () => {
  it("dispatches trusted issue and discussion commands", async () => {
    const client = createClient();
    const app = createApp({ client });

    await app.handleWebhook("issue_comment", {
      action: "created",
      comment: { body: "/git-vibe approve", node_id: "issue-approve-comment" },
      issue: { number: 2 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });
    await app.handleWebhook("issue_comment", {
      action: "created",
      comment: { body: "/git-vibe address-feedback", node_id: "pr-feedback-comment" },
      issue: { number: 3, pull_request: {} },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });
    await app.handleWebhook("discussion_comment", {
      action: "created",
      comment: { body: "/git-vibe materialize", node_id: "discussion-materialize-comment" },
      discussion: { number: 5 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      { inputs: expect.objectContaining({ "issue-number": "2" }), ref: "main" },
      { inputs: expect.objectContaining({ "pr-number": "3" }), ref: "main" },
      { inputs: expect.objectContaining({ "discussion-number": "5" }), ref: "main" },
    ]);
    expect(sourceCommentKinds(client)).toEqual([
      "issue-comment",
      "pull-request-comment",
      "discussion-comment",
    ]);
    expect(reactionVariables(client)).toEqual([
      { content: "ROCKET", subjectId: "issue-approve-comment" },
      { content: "ROCKET", subjectId: "pr-feedback-comment" },
      { content: "ROCKET", subjectId: "discussion-materialize-comment" },
    ]);
  });

  it("continues dispatching when command acknowledgement fails", async () => {
    const log = vi.fn();
    const client = createClient({ reactionError: new Error("reaction unavailable") });
    const app = createApp({ client, log });

    await app.handleWebhook("discussion_comment", {
      action: "created",
      comment: { body: "/git-vibe validate", node_id: "discussion-validate-comment" },
      discussion: { number: 6 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      { inputs: expect.objectContaining({ "discussion-number": "6" }), ref: "main" },
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("command acknowledgement failed: reaction unavailable"),
    );
  });

  it("rejects untrusted commands and logs unsupported commands", async () => {
    await expect(
      requestSignedWebhook(
        createApp({
          client: createClient({
            permission: new Error("GitHub API GET permission failed: 404"),
          }),
        }),
        {
          action: "created",
          comment: { body: "/git-vibe investigate" },
          issue: { number: 2 },
          repository: repositoryPayload(),
          sender: { login: "guest" },
        },
        "issue_comment",
      ),
    ).resolves.toMatchObject({
      body: expect.objectContaining({ error: expect.stringContaining("does not have permission") }),
      status: 403,
    });

    const log = vi.fn();
    const client = createClient();
    await createApp({ client, log }).handleWebhook("issue_comment", {
      action: "created",
      comment: { body: "/git-vibe summarize" },
      issue: { number: 3, pull_request: {} },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("recognized command"));
  });
});

describe("GitVibe app server label handling", () => {
  it("rejects untrusted protected labels and dispatches trusted approved labels", async () => {
    const client = createClient({ permission: new Error("GitHub API GET permission failed: 404") });
    const app = createApp({ client });

    await app.handleWebhook("issues", {
      action: "labeled",
      issue: { number: 2 },
      label: { name: gitVibeLabels.approved.name },
      repository: repositoryPayload(),
      sender: { login: "guest" },
    });

    expect(requestPaths(client, "DELETE")).toContain(
      "/repos/example/repo/issues/2/labels/git-vibe%3Aapproved",
    );
    expect(requestBodies(client, "POST", "/issues/2/comments")[0].body).toContain("removed");

    const trustedClient = createClient({ permission: { role_name: "maintain" } });
    await createApp({ client: trustedClient }).handleWebhook("issues", {
      action: "labeled",
      issue: { number: 9 },
      label: { name: gitVibeLabels.approved.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });
    expect(workflowDispatches(trustedClient)).toEqual([
      { inputs: { "issue-number": "9" }, ref: "main" },
    ]);
  });

  it("ignores unprotected and non-approved labels", async () => {
    const client = createClient();
    const app = createApp({ client });

    await app.handleWebhook("issues", {
      action: "labeled",
      issue: { number: 2 },
      label: { name: "bug" },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });
    await app.handleWebhook("issues", {
      action: "labeled",
      issue: { number: 2 },
      label: { name: gitVibeLabels.needsDiscussion.name },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
  });
});

describe("GitVibe app server dispatch edge cases", () => {
  it("handles ignored events and non-command comments without dispatching workflows", async () => {
    const log = vi.fn();
    const client = createClient();
    const app = createApp({ client, log });

    await app.handleWebhook("issues", { action: "edited" });
    await app.handleWebhook("issues", { action: "edited", repository: repositoryPayload() });
    await app.handleWebhook("pull_request", {
      action: "opened",
      repository: repositoryPayload(),
    });
    await app.handleWebhook("issue_comment", {
      action: "created",
      comment: { body: "not a command" },
      issue: { number: 2 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });
    await app.handleWebhook("discussion_comment", {
      action: "created",
      comment: { body: "" },
      discussion: { number: 5 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(log).toHaveBeenCalledWith("ignored issues.edited");
    expect(log).toHaveBeenCalledWith("ignored pull_request.opened");
    expect(log).toHaveBeenCalledWith("ignored issues: missing repository");
    expect(workflowDispatches(client)).toEqual([]);
  });

  it("dispatches the supported issue command workflow variants", async () => {
    const client = createClient();
    const app = createApp({ client });

    for (const command of ["investigate", "validate", "start"]) {
      await app.handleWebhook("issue_comment", {
        action: "created",
        comment: { body: `/git-vibe ${command}` },
        issue: { number: 2 },
        repository: repositoryPayload(),
        sender: { login: "maintainer" },
      });
    }
    await app.handleWebhook("discussion_comment", {
      action: "created",
      comment: { body: "/git-vibe validate" },
      discussion: { number: 5 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(requestPaths(client, "POST")).toEqual(
      expect.arrayContaining([
        "/repos/example/repo/actions/workflows/investigate.yml/dispatches",
        "/repos/example/repo/actions/workflows/validate.yml/dispatches",
        "/repos/example/repo/actions/workflows/develop.yml/dispatches",
      ]),
    );
    expect(workflowDispatches(client).at(-1)).toEqual({
      inputs: expect.objectContaining({ "discussion-number": "5" }),
      ref: "main",
    });
  });
});

describe("GitVibe app server PR review command dispatch", () => {
  it("dispatches PR review comment commands with threaded reply metadata", async () => {
    const client = createClient();
    const app = createApp({ client });

    await app.handleWebhook("pull_request_review_comment", {
      action: "created",
      comment: {
        body: "/git-vibe address-feedback",
        html_url: "https://github.com/example/repo/pull/12#discussion_r55",
        id: 55,
        node_id: "review-comment-node",
      },
      pull_request: { number: 12 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      { inputs: expect.objectContaining({ "pr-number": "12" }), ref: "main" },
    ]);
    expect(sourceComments(client)[0]).toMatchObject({
      id: "55",
      kind: "pull-request-review-comment",
      nodeId: "review-comment-node",
      url: "https://github.com/example/repo/pull/12#discussion_r55",
    });
  });

  it("logs unsupported PR review comment commands", async () => {
    const log = vi.fn();
    const client = createClient();
    const app = createApp({ client, log });

    await app.handleWebhook("pull_request_review_comment", {
      action: "created",
      comment: { body: "/git-vibe validate", node_id: "review-comment-node" },
      pull_request: { number: 12 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("recognized command"));
  });
});

describe("GitVibe app server rejection paths", () => {
  it("rejects invalid signatures, missing actors, and non-404 permission failures", async () => {
    const app = createApp();
    await withHttpServer(app.handleRequest, async (url) => {
      await expect(
        requestJson(url, "POST", "/webhooks", "{}", {
          "x-github-event": "ping",
          "x-hub-signature-256": "sha256=bad",
        }),
      ).resolves.toMatchObject({ body: { error: "invalid GitHub signature" }, status: 401 });
    });

    await expect(
      requestSignedWebhook(
        createApp(),
        {
          action: "created",
          comment: { body: "/git-vibe investigate" },
          issue: { number: 2 },
          repository: repositoryPayload(),
        },
        "issue_comment",
      ),
    ).resolves.toMatchObject({
      body: { error: "actor <missing> does not have permission to run GitVibe commands" },
      status: 403,
    });

    await expect(
      requestSignedWebhook(
        createApp({
          client: createClient({ permission: new Error("permission service unavailable") }),
        }),
        {
          action: "created",
          comment: { body: "/git-vibe investigate" },
          issue: { number: 2 },
          repository: repositoryPayload(),
          sender: { login: "maintainer" },
        },
        "issue_comment",
      ),
    ).resolves.toMatchObject({
      body: { error: "permission service unavailable" },
      status: 500,
    });
  });
});

describe("GitVibe app server runtime edge cases", () => {
  it("does not repeat discussion setup guidance once the marker already exists", async () => {
    const client = createClient({
      categories: [],
      comments: [{ body: "<!-- git-vibe:discussion-setup-error -->" }],
    });

    await createApp({ client }).handleWebhook("issues", {
      action: "opened",
      issue: featureIssue(),
      repository: repositoryPayload(),
      sender: { login: "owner" },
    });

    expect(requestBodies(client, "POST", "/issues/2/comments")).toEqual([]);
  });

  it("converts non-error webhook failures into HTTP 500 responses", async () => {
    const client = {
      graphql: vi.fn(),
      request: vi.fn(async () => {
        throw "plain bootstrap failure";
      }),
    };

    await expect(
      requestSignedWebhook(
        createApp({ client }),
        { action: "opened", repository: repositoryPayload() },
        "pull_request",
      ),
    ).resolves.toMatchObject({
      body: { error: "plain bootstrap failure" },
      status: 500,
    });
  });

  it("starts from environment configuration and validates required server secrets", async () => {
    expect(() => startServerFromEnv({ GITVIBE_GITHUB_TOKEN: "token" })).toThrow(
      "GITHUB_WEBHOOK_SECRET is required",
    );

    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = startServerFromEnv({
      GITHUB_WEBHOOK_SECRET: "secret",
      GITVIBE_GITHUB_TOKEN: "token",
      PORT: "0",
    });
    await new Promise((resolve) => server.on("listening", resolve));
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    consoleLog.mockRestore();
  });

  it("detects direct execution by module URL", () => {
    expect(isDirectRun(new URL("../src/app/server.ts", import.meta.url).href, undefined)).toBe(
      false,
    );
    expect(isDirectRun("", "/tmp/server.js")).toBe(true);
  });
});

function createApp(options = {}) {
  return createGitVibeApp({
    client: options.client || createClient(),
    configuredRepository: options.configuredRepository || "",
    errorLog: options.errorLog || vi.fn(),
    githubToken: "token",
    log: options.log || vi.fn(),
    webhookSecret: "secret",
  });
}

function createClient(options = {}) {
  const categories = options.categories || [{ id: "ideas", name: "Ideas", slug: "ideas" }];
  const client = {
    graphql: vi.fn(async (query, _variables) => {
      if (query.includes("GitVibeDiscussionCategories")) {
        return { repository: { discussionCategories: { nodes: categories }, id: "repo-id" } };
      }
      if (query.includes("GitVibeAddReaction")) {
        if (options.reactionError) throw options.reactionError;
        return { addReaction: { reaction: { content: "ROCKET" } } };
      }
      return {
        createDiscussion: {
          discussion: {
            id: "discussion-id",
            number: 7,
            url: "https://github.com/example/repo/discussions/7",
          },
        },
      };
    }),
    request: vi.fn(async (request) => {
      if (request.path.includes("/collaborators/")) {
        const permission = options.permission || { permission: "write" };
        if (permission instanceof Error) throw permission;
        return permission;
      }
      if (request.method === "GET" && request.path.includes("/comments?")) {
        return options.comments || [];
      }
      if (request.method === "POST" && request.path.endsWith("/labels")) return {};
      if (request.method === "POST" && request.path.includes("/actions/workflows/")) return {};
      if (request.method === "POST" && request.path.includes("/issues/")) return {};
      if (request.method === "PATCH" && request.path.includes("/issues/")) return {};
      if (request.method === "DELETE" && request.path.includes("/labels/")) return {};
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    }),
  };
  return client;
}

function featureIssue() {
  return {
    body: "### Request type\n\nFeature request\n\n### Background story\n\nNeed it.",
    html_url: "https://github.com/example/repo/issues/2",
    number: 2,
    title: "[Feature]: Add workflows",
    user: { login: "octocat" },
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

function sourceComments(client) {
  return workflowDispatches(client)
    .map((dispatch) => dispatch.inputs["source-comment"])
    .filter(Boolean)
    .map((value) => JSON.parse(value));
}

function sourceCommentKinds(client) {
  return sourceComments(client).map((comment) => comment.kind);
}

function reactionVariables(client) {
  return client.graphql.mock.calls
    .filter(([query]) => query.includes("GitVibeAddReaction"))
    .map(([, variables]) => variables);
}

function signature(body) {
  const digest = createHmac("sha256", "secret").update(body).digest("hex");
  return `sha256=${digest}`;
}

async function withHttpServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    return await run(url);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function requestJson(baseUrl, method, path, body = "", headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    body: method === "GET" ? undefined : body,
    headers,
    method,
  });
  return { body: await response.json(), status: response.status };
}

async function requestSignedWebhook(app, payload, event) {
  return withHttpServer(app.handleRequest, (url) => {
    const body = JSON.stringify(payload);
    return requestJson(url, "POST", "/webhooks", body, {
      "x-github-event": event,
      "x-hub-signature-256": signature(body),
    });
  });
}
