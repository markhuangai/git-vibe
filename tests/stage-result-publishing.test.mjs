import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceConfigWithTestAi } from "./support/ai-config.mjs";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));
const createAnthropic = vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") }));

vi.mock("ai", () => ({
  generateText,
  hasToolCall: vi.fn((toolName) => ({ toolName })),
  stepCountIs: vi.fn((count) => ({ count })),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));

const { runStage } = await import("../src/runner/stage-runner.ts");

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  generateText.mockReset();
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      GITVIBE_AI_API_KEY: "test-key",
      GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    }),
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe("stage result publishing", () => {
  it("publishes validate results to issues and marks ready issues for approval", async () => {
    const cwd = await workspace();
    generateText.mockResolvedValueOnce(aiResult(validateOutput()));
    const fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([]),
      response(200, {}),
      response(200, {}),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    const result = await runStage({
      cwd,
      dryRun: false,
      issueNumber: "12",
      maxTurns: 2,
      prNumber: "",
      repository: "example/repo",
      stage: "validate",
      stageTimeoutMinutes: 1,
      token: "token",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    });

    const startBody = JSON.parse(fetch.mock.calls[2][1].body).body;
    const commentBody = JSON.parse(fetch.mock.calls[3][1].body).body;
    expect(result.commentBody).toContain("## GitVibe Validation");
    expect(startBody).toContain("<!-- git-vibe:stage-start");
    expect(startBody).toContain("stage=validate");
    expect(startBody).toContain("run=99");
    expect(startBody).toContain("Workflow run: https://github.com/example/repo/actions/runs/99");
    expect(commentBody).toContain("<!-- git-vibe:stage-result stage=validate");
    expect(commentBody).toContain("Workflow run: https://github.com/example/repo/actions/runs/99");
    expect(JSON.parse(fetch.mock.calls[4][1].body).labels).toEqual(["gvi:ready-for-approval"]);
  });
});

/**
 * @param {string} [config]
 * @returns {Promise<string>}
 */
async function workspace(config = "") {
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-publish-"));
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "git-vibe-runner-"));
  mkdirSync(join(cwd, ".github"));
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), workspaceConfigWithTestAi(config));
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  return cwd;
}

/**
 * @param {Record<string, unknown>} output
 */
function aiResult(output) {
  return {
    steps: [
      { toolCalls: [{ input: { content: JSON.stringify(output) }, toolName: "output_validator" }] },
    ],
    text: "{}",
  };
}

function validateOutput() {
  return {
    assumptions: [],
    comment_body: "Ready for approval.",
    findings: ["Implementation scope is clear."],
    next_state: "ready-for-implementation",
    questions: [],
    references: [],
    stage: "validate",
    status: "completed",
    summary: "Validation complete.",
  };
}

/**
 * @param {any[]} responses
 */
function fetchMock(responses) {
  return vi.fn(
    /**
     * @param {any} url
     * @param {any} [init]
     */
    async (url, init = {}) => {
      if (isLabelRequest(url, init)) return response(200, {});
      const genericGraphql = genericGraphqlResponse(url, init);
      if (genericGraphql) return genericGraphql;
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      return next;
    },
  );
}

/**
 * @param {any} url
 * @param {any} init
 */
function genericGraphqlResponse(url, init) {
  if (!String(url).endsWith("/graphql")) return undefined;
  const query = String(JSON.parse(String(init.body || "{}")).query || "");
  if (query.includes("GitVibeDiscussionLabelId")) {
    return graphqlResponse({ repository: { label: { id: "label-node" } } });
  }
  if (query.includes("GitVibeAddDiscussionLabel")) {
    return graphqlResponse({ addLabelsToLabelable: { clientMutationId: null } });
  }
  if (query.includes("GitVibeRemoveDiscussionLabel")) {
    return graphqlResponse({ removeLabelsFromLabelable: { clientMutationId: null } });
  }
  if (query.includes("GitVibeDeleteDiscussionComment")) {
    return graphqlResponse({ deleteDiscussionComment: { clientMutationId: null } });
  }
  if (query.includes("GitVibeAddDiscussionComment")) {
    return graphqlResponse({ addDiscussionComment: { comment: { id: "comment", url: "url" } } });
  }
  return undefined;
}

/**
 * @param {any} url
 * @param {any} init
 */
function isLabelRequest(url, init) {
  const method = String(init.method || "GET").toUpperCase();
  return method === "POST"
    ? /\/issues\/\d+\/labels$/.test(String(url))
    : method === "DELETE" && String(url).includes("/labels/");
}

/**
 * @param {string} body
 */
function issueResponse(body) {
  return response(200, {
    body,
    created_at: "2026-01-02T00:00:00Z",
    html_url: "https://github.com/example/repo/issues/12",
    number: 12,
    title: "Issue title",
    user: { login: "octocat" },
  });
}

/**
 * @param {unknown[]} comments
 */
function commentsResponse(comments) {
  return response(200, comments);
}

/**
 * @param {Record<string, unknown>} data
 */
function graphqlResponse(data) {
  return response(200, { data });
}

/**
 * @param {number} status
 * @param {unknown} value
 * @returns {any}
 */
function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  };
}
