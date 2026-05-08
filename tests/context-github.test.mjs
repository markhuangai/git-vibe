// @ts-nocheck
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureGitVibeLabels,
  isProtectedGitVibeLabel,
  removeIssueLabel,
} from "../src/app/labels.ts";
import { loadConfig, testCommandsFor } from "../src/runner/config.ts";
import { buildDiscussionContext, buildIssueContext } from "../src/runner/context.ts";
import { GitHubClient, splitRepository } from "../src/shared/github.ts";
import { gitVibeLabelList } from "../src/shared/labels.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GitHub context builders", () => {
  it("builds issue context from issue body and sorted comments", async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          body: "Issue body",
          created_at: "2026-01-02T00:00:00Z",
          html_url: "https://github.com/example/repo/issues/4",
          number: 4,
          title: "Issue title",
          user: { login: "author" },
        })
        .mockResolvedValueOnce([
          {
            body: "Second",
            created_at: "2026-01-04T00:00:00Z",
            html_url: "comment-2",
            id: 2,
            user: { login: "b" },
          },
          {
            body: "First",
            created_at: "2026-01-03T00:00:00Z",
            html_url: "comment-1",
            id: 1,
            user: { login: "a" },
          },
        ])
        .mockResolvedValueOnce([
          {
            body: "Review feedback",
            created_at: "2026-01-05T00:00:00Z",
            diff_hunk: "@@ -1 +1 @@",
            html_url: "review-comment",
            id: 9,
            in_reply_to_id: 8,
            path: "src/file.ts",
            user: { login: "reviewer" },
          },
        ]),
    };

    const context = await buildIssueContext({
      client,
      issueNumber: "4",
      repository: "example/repo",
      token: "token",
      type: "pull-request",
    });

    expect(context.artifact).toMatchObject({
      number: "4",
      title: "Issue title",
      type: "pull-request",
    });
    expect(context.timeline.map((item) => item.body)).toEqual([
      "Issue body",
      "First",
      "Second",
      "Path: src/file.ts\nDiff:\n@@ -1 +1 @@\n\nReview feedback",
    ]);
    expect(context.timeline.at(-1)).toMatchObject({
      id: "9",
      kind: "pull-request-review-comment",
      parentId: "8",
    });
  });

  it("uses stable fallbacks for sparse issue payloads", async () => {
    const client = {
      request: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce([{}]),
    };

    const context = await buildIssueContext({
      client,
      issueNumber: "6",
      repository: "example/repo",
      token: "token",
    });

    expect(context.artifact).toMatchObject({
      body: "",
      number: "6",
      title: "",
      type: "issue",
      url: "",
    });
    expect(context.timeline[0]).toMatchObject({ author: "<unknown>", id: "issue-6" });
  });
});

describe("GitHub discussion context builders", () => {
  it("builds discussion context with replies and parent ids", async () => {
    const client = {
      graphql: vi.fn().mockResolvedValueOnce({
        repository: {
          discussion: {
            author: { login: "author" },
            body: "Discussion body",
            comments: {
              nodes: [
                {
                  author: { login: "commenter" },
                  body: "Comment",
                  createdAt: "2026-01-03T00:00:00Z",
                  id: "comment-id",
                  replies: {
                    nodes: [
                      {
                        author: { login: "reply" },
                        body: "Reply",
                        createdAt: "2026-01-04T00:00:00Z",
                        id: "reply-id",
                        url: "reply-url",
                      },
                    ],
                  },
                  url: "comment-url",
                },
              ],
            },
            createdAt: "2026-01-02T00:00:00Z",
            id: "discussion-id",
            title: "Discussion title",
            url: "discussion-url",
          },
        },
      }),
    };

    const context = await buildDiscussionContext({
      client,
      discussionNumber: "5",
      repository: "example/repo",
      token: "token",
    });

    expect(context.artifact).toMatchObject({ id: "discussion-id", type: "discussion" });
    expect(context.timeline.map((item) => [item.kind, item.id, item.parentId])).toEqual([
      ["body", "discussion-5", undefined],
      ["comment", "comment-id", undefined],
      ["reply", "reply-id", "comment-id"],
    ]);
  });

  it("uses stable fallbacks for sparse discussion payloads", async () => {
    const client = {
      graphql: vi.fn().mockResolvedValueOnce({
        repository: {
          discussion: {
            comments: {
              nodes: [{ id: "comment-id" }],
            },
            id: "discussion-id",
          },
        },
      }),
    };

    const context = await buildDiscussionContext({
      client,
      discussionNumber: "8",
      repository: "example/repo",
      token: "token",
    });

    expect(context.artifact).toMatchObject({ body: "", title: "", url: "" });
    expect(context.timeline.map((item) => item.author)).toEqual(["<unknown>", "<unknown>"]);
  });
});

describe("GitHub client", () => {
  it("requests REST and GraphQL responses", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(response(200, { ok: true }))
      .mockResolvedValueOnce(response(204, ""))
      .mockResolvedValueOnce(response(200, { data: { value: 3 } }));

    const client = new GitHubClient({ apiBaseUrl: "https://api.test", retryBaseDelayMs: 0 });
    await expect(
      client.request({ method: "GET", path: "/repos/a/b", token: "t" }),
    ).resolves.toEqual({
      ok: true,
    });
    await expect(
      client.request({ method: "DELETE", path: "/resource", token: "t" }),
    ).resolves.toEqual({});
    await expect(client.graphql("query", { n: 1 }, "t")).resolves.toEqual({ value: 3 });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.test/repos/a/b",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer t" }),
      }),
    );
  });

  it("throws clear REST, GraphQL, and repository parsing errors", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(response(500, { message: "boom" }, false))
      .mockResolvedValueOnce(response(200, { errors: [{ message: "bad query" }] }));

    const client = new GitHubClient({ apiBaseUrl: "https://api.test", retryBaseDelayMs: 0 });
    await expect(client.request({ method: "GET", path: "/bad", token: "t" })).rejects.toThrow(
      "GitHub API GET /bad failed",
    );
    await expect(client.graphql("query", {}, "t")).rejects.toThrow("GitHub GraphQL failed");
    expect(splitRepository("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(() => splitRepository("missing")).toThrow("repository must be owner/repo");
  });

  it("retries transient safe GitHub reads but not writes", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(response(504, { message: "timeout" }, false))
      .mockResolvedValueOnce(response(200, { ok: true }))
      .mockResolvedValueOnce(response(504, { message: "timeout" }, false))
      .mockResolvedValueOnce(response(200, { data: { value: 4 } }))
      .mockResolvedValueOnce(response(504, { message: "timeout" }, false));

    const client = new GitHubClient({ apiBaseUrl: "https://api.test", retryBaseDelayMs: 0 });
    await expect(
      client.request({ method: "GET", path: "/repos/a/b", token: "t" }),
    ).resolves.toEqual({ ok: true });
    await expect(client.graphql("query Test { viewer { login } }", {}, "t")).resolves.toEqual({
      value: 4,
    });
    await expect(client.graphql("mutation Test { noop }", {}, "t")).rejects.toThrow(
      "GitHub API POST /graphql failed: 504",
    );

    expect(globalThis.fetch).toHaveBeenCalledTimes(5);
  });
});

describe("GitVibe config and labels", () => {
  it("loads fixed-path config and filters blank test commands", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "git-vibe-config-"));
    mkdirSync(join(cwd, ".github"));
    writeFileSync(
      join(cwd, ".github", "git-vibe.yml"),
      "branches:\n  base: develop\ntests:\n  commands:\n    - pnpm test\n    - '  '\n",
    );

    const config = loadConfig(cwd);
    expect(config.branches?.base).toBe("develop");
    expect(testCommandsFor(config)).toEqual(["pnpm test"]);
    expect(loadConfig(join(cwd, "missing"))).toEqual({});
  });

  it("creates missing labels, ignores existing labels, and removes labels with encoded names", async () => {
    const requests = [];
    const client = {
      request: vi.fn(async (request) => {
        requests.push(request);
        if (request.body?.name === gitVibeLabelList[0].name) throw new Error("422 already exists");
        return {};
      }),
    };

    await ensureGitVibeLabels({ client, owner: "example", repo: "repo", token: "token" });
    await removeIssueLabel({
      client,
      issueNumber: "3",
      label: "git-vibe:approved",
      owner: "example",
      repo: "repo",
      token: "token",
    });

    expect(requests.filter((request) => request.method === "POST")).toHaveLength(
      gitVibeLabelList.length,
    );
    expect(requests.at(-1).path).toBe("/repos/example/repo/issues/3/labels/git-vibe%3Aapproved");
    expect(isProtectedGitVibeLabel("git-vibe:anything")).toBe(true);
    expect(isProtectedGitVibeLabel("gvi:review-fix")).toBe(true);
  });

  it("rethrows unexpected label creation failures", async () => {
    const client = {
      request: vi.fn(async () => {
        throw new Error("500 unavailable");
      }),
    };

    await expect(
      ensureGitVibeLabels({ client, owner: "example", repo: "repo", token: "token" }),
    ).rejects.toThrow("500 unavailable");
  });
});

function response(status, value, ok = status >= 200 && status < 300) {
  return {
    ok,
    status,
    text: async () => (typeof value === "string" ? value : JSON.stringify(value)),
  };
}
