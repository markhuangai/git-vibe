// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { createGitVibeApp, isDirectRun, startServerFromEnv } from "../src/app/server.ts";
import {
  createApp,
  createClient,
  discussionCommentBodies,
  featureIssue,
  reactionVariables,
  repositoryPayload,
  requestBodies,
  requestJson,
  requestPaths,
  requestSignedWebhook,
  signature,
  sourceCommentKinds,
  sourceComments,
  withHttpServer,
  workflowDispatches,
} from "./support/server-app.mjs";

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

  it("logs startup label bootstrap failures with the default error logger", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = createGitVibeApp({
      client: createClient({ labelError: new Error("label write failed") }),
      configuredRepository: "example/repo",
      githubToken: "token",
      log: vi.fn(),
      webhookSecret: "secret",
    });

    await app.runStartupPreflight();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("startup label bootstrap failed for example/repo"),
    );
    consoleError.mockRestore();
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
      comment: { body: "/git-vibe investigate", id: 44, node_id: "issue-investigate-comment" },
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
      comment: { body: "/git-vibe summarize", node_id: "discussion-summarize-comment" },
      discussion: { node_id: "discussion-node", number: 5 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({ inputs: expect.objectContaining({ "issue-number": "2" }) }),
      expect.objectContaining({ inputs: expect.objectContaining({ "pr-number": "3" }) }),
      expect.objectContaining({ inputs: expect.objectContaining({ "discussion-number": "5" }) }),
    ]);
    expect(sourceCommentKinds(client)).toEqual([
      "issue-comment",
      "pull-request-comment",
      "discussion-comment",
    ]);
    expect(reactionVariables(client)).toEqual([
      { content: "ROCKET", subjectId: "issue-investigate-comment" },
      { content: "ROCKET", subjectId: "pr-feedback-comment" },
      { content: "ROCKET", subjectId: "discussion-summarize-comment" },
    ]);
    expect(requestBodies(client, "POST", "/issues/2/comments").at(-1).body).toContain(
      "investigate.yml",
    );
    expect(requestBodies(client, "POST", "/issues/3/comments").at(-1).body).toContain(
      "address-feedback.yml",
    );
    expect(discussionCommentBodies(client).at(-1)).toContain("summarize.yml");
    expect(discussionCommentBodies(client).at(-1)).toContain(
      "Workflow run: https://github.com/example/repo/actions/runs/1",
    );
  });
});

describe("GitVibe app server command edge cases", () => {
  it("continues dispatching when command acknowledgement fails", async () => {
    const log = vi.fn();
    const client = createClient({ reactionError: new Error("reaction unavailable") });
    const app = createApp({ client, log });

    await app.handleWebhook("discussion_comment", {
      action: "created",
      comment: { body: "/git-vibe summarize", node_id: "discussion-summarize-comment" },
      discussion: { number: 6 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: expect.objectContaining({ "discussion-number": "6" }),
        ref: "main",
        return_run_details: true,
      }),
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

describe("GitVibe app server dispatch edge cases", () => {
  it("uses GITVIBE_BASE_BRANCH from repository variables for workflow dispatch", async () => {
    const client = createClient({ baseBranchVariable: "develop" });
    const app = createApp({ client });

    await app.handleWebhook("issue_comment", {
      action: "created",
      comment: { body: "/git-vibe investigate" },
      issue: { number: 2 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)[0]).toMatchObject({ ref: "develop" });
    expect(requestBodies(client, "POST", "/issues/2/comments").at(-1).body).toContain(
      "on `develop`",
    );
  });

  it("uses the GitHub default branch when GITVIBE_BASE_BRANCH is empty or missing", async () => {
    const payload = {
      action: "created",
      comment: { body: "/git-vibe investigate" },
      issue: { number: 2 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    };
    const clients = [
      createClient({ defaultBranch: "trunk" }),
      createClient({
        baseBranchVariable: "",
        defaultBranch: "trunk",
      }),
    ];

    for (const client of clients) {
      await createApp({ client }).handleWebhook("issue_comment", payload);
      expect(workflowDispatches(client)[0]).toMatchObject({ ref: "trunk" });
    }
    await expect(
      createApp({
        client: createClient({ baseBranchVariableError: new Error("variables permission denied") }),
      }).handleWebhook("issue_comment", payload),
    ).rejects.toThrow("variables permission denied");
  });

  it("falls back when workflow dispatch run details are unavailable", async () => {
    const log = vi.fn();
    const client = createClient({
      workflowDispatchError: new Error("return_run_details is not a permitted key"),
      workflowDispatchErrorCount: 1,
    });
    const app = createApp({ client, log });

    await app.handleWebhook("issue_comment", {
      action: "created",
      comment: { body: "/git-vibe investigate" },
      issue: { number: 2 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: expect.objectContaining({ "issue-number": "2" }),
        ref: "main",
        return_run_details: true,
      }),
      expect.objectContaining({
        inputs: expect.objectContaining({ "issue-number": "2" }),
        ref: "main",
      }),
    ]);
    expect(workflowDispatches(client)[1]).not.toHaveProperty("return_run_details");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("workflow dispatch run details unavailable for investigate.yml"),
    );
    expect(requestBodies(client, "POST", "/issues/2/comments").at(-1).body).not.toContain(
      "Workflow run:",
    );
  });

  it("logs queued workflow comment failures after dispatching", async () => {
    const log = vi.fn();
    const client = createClient({ issueCommentError: new Error("comments unavailable") });
    const app = createApp({ client, log });

    await app.handleWebhook("issue_comment", {
      action: "created",
      comment: { body: "/git-vibe investigate" },
      issue: { number: 2 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("workflow queued comment failed: comments unavailable");
  });
});

describe("GitVibe app server workflow dispatch compatibility", () => {
  it("falls back for generic dispatch permitted-key errors", async () => {
    const client = createClient({
      workflowDispatchError: new Error("body is not a permitted key"),
      workflowDispatchErrorCount: 1,
    });

    await createApp({ client }).handleWebhook("issue_comment", {
      action: "created",
      comment: { body: "/git-vibe investigate" },
      issue: { number: 2 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toHaveLength(2);
    expect(workflowDispatches(client)[1]).not.toHaveProperty("return_run_details");
  });
});

describe("GitVibe app server ignored dispatch paths", () => {
  it("omits queued workflow run links when dispatch does not return a run URL", async () => {
    const client = createClient({ workflowDispatchResponse: {} });
    const app = createApp({ client });

    await app.handleWebhook("issue_comment", {
      action: "created",
      comment: { body: "/git-vibe investigate" },
      issue: { number: 2 },
      repository: repositoryPayload(),
      sender: { login: "maintainer" },
    });

    const body = requestBodies(client, "POST", "/issues/2/comments").at(-1).body;
    expect(body).toContain("GitVibe Workflow Queued");
    expect(body).not.toContain("Workflow run:");
  });

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
});

describe("GitVibe app server command workflow variants", () => {
  it("dispatches only the supported command workflow variants", async () => {
    const client = createClient();
    const log = vi.fn();
    const app = createApp({ client, log });

    for (const command of ["investigate", "validate"]) {
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
      expect.arrayContaining(["/repos/example/repo/actions/workflows/investigate.yml/dispatches"]),
    );
    expect(requestPaths(client, "POST")).not.toContain(
      "/repos/example/repo/actions/workflows/validate.yml/dispatches",
    );
    expect(log).toHaveBeenCalledWith(
      "recognized command but no dispatch rule matched: /git-vibe validate",
    );
  });

  it("logs unsupported commands without dispatching workflows", async () => {
    const client = createClient();
    const log = vi.fn();
    const app = createApp({ client, log });

    for (const command of ["start", "approve", "materialize"]) {
      await app.handleWebhook("issue_comment", {
        action: "created",
        comment: { body: `/git-vibe ${command}`, node_id: `${command}-comment` },
        issue: { number: 2 },
        repository: repositoryPayload(),
        sender: { login: "maintainer" },
      });
    }

    expect(workflowDispatches(client)).toEqual([]);
    expect(reactionVariables(client)).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "recognized command but no dispatch rule matched: /git-vibe start",
    );
    expect(log).toHaveBeenCalledWith(
      "recognized command but no dispatch rule matched: /git-vibe approve",
    );
  });
});

describe("GitVibe app server PR review dispatch", () => {
  it("dispatches trusted changes-requested review submissions with review metadata", async () => {
    const client = createClient();
    const app = createApp({ client });

    await app.handleWebhook("pull_request_review", {
      action: "submitted",
      pull_request: { number: 12 },
      repository: repositoryPayload(),
      review: {
        body: "Please address these review comments.",
        html_url: "https://github.com/example/repo/pull/12#pullrequestreview-99",
        id: 99,
        node_id: "review-node",
        state: "changes_requested",
      },
      sender: { login: "maintainer" },
    });

    expect(workflowDispatches(client)).toEqual([
      expect.objectContaining({
        inputs: expect.objectContaining({ "pr-number": "12" }),
        ref: "main",
        return_run_details: true,
      }),
    ]);
    expect(sourceComments(client)[0]).toMatchObject({
      id: "99",
      kind: "pull-request-review",
      nodeId: "review-node",
      url: "https://github.com/example/repo/pull/12#pullrequestreview-99",
    });
    expect(requestBodies(client, "POST", "/issues/12/comments").at(-1).body).toContain(
      "GitVibe Workflow Queued",
    );
  });

  it("ignores non-change and untrusted PR review submissions", async () => {
    const log = vi.fn();
    const client = createClient();
    const app = createApp({ client, log });

    await app.handleWebhook("pull_request_review", {
      action: "submitted",
      pull_request: { number: 12 },
      repository: repositoryPayload(),
      review: { state: "commented" },
      sender: { login: "maintainer" },
    });
    await createApp({
      client: createClient({ permission: new Error("GitHub API GET permission failed: 404") }),
      log,
    }).handleWebhook("pull_request_review", {
      action: "submitted",
      pull_request: { number: 12 },
      repository: repositoryPayload(),
      review: { state: "changes_requested" },
      sender: { login: "guest" },
    });

    expect(workflowDispatches(client)).toEqual([]);
    expect(log).toHaveBeenCalledWith("ignored pull_request_review.commented for PR #12");
    expect(log).toHaveBeenCalledWith(
      "ignored changes_requested review from untrusted actor @guest on PR #12",
    );
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
