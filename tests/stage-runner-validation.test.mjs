import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  vi.unstubAllEnvs();
});

describe("stage runner context coverage", () => {
  it("allows completed results when context chunks remain pending", async () => {
    const cwd = await workspace();
    generateText.mockResolvedValueOnce({
      steps: [
        {
          toolCalls: [
            {
              input: {
                content: JSON.stringify({
                  assumptions: [],
                  comment_body: "Ready.",
                  findings: [],
                  next_state: "ready-for-implementation",
                  references: [],
                  stage: "validate",
                  status: "completed",
                  summary: "Ready.",
                }),
              },
              toolName: "output_validator",
            },
          ],
        },
      ],
      text: "{}",
    });
    const fetch = fetchMock([
      issueResponse("x".repeat(120_000)),
      commentsResponse([]),
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
    });

    expect(result).toMatchObject({
      parsedOutput: {
        next_state: "ready-for-implementation",
        status: "completed",
        summary: "Ready.",
      },
      status: "completed",
    });
    expect(issueCommentCall(fetch)?.[0]).toContain("/repos/example/repo/issues/12/comments");
    expect(labelRequestBody(fetch, "gvi:ready-for-approval")?.labels).toEqual([
      "gvi:ready-for-approval",
    ]);
    expect(labelRequestBody(fetch, "gvi:blocked")).toBeUndefined();
  });
});

describe("stage runner blocked publishing", () => {
  it("publishes blocked deterministic results", async () => {
    const cwd = await workspace();
    generateText.mockResolvedValueOnce({
      steps: [
        {
          toolCalls: [
            {
              input: {
                content: JSON.stringify({
                  assumptions: [],
                  comment_body: "Blocked.",
                  findings: [],
                  next_state: "blocked",
                  questions: [],
                  references: [],
                  stage: "validate",
                  status: "blocked",
                  summary: "Blocked.",
                }),
              },
              toolName: "output_validator",
            },
          ],
        },
      ],
      text: "{}",
    });
    const fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([]),
      response(200, {}),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    await expect(
      runStage({
        cwd,
        dryRun: false,
        issueNumber: "12",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "validate",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({ status: "blocked" });
    expect(issueCommentCall(fetch)?.[0]).toContain("/repos/example/repo/issues/12/comments");
    expect(labelRequestBody(fetch, "gvi:blocked")?.labels).toEqual(["gvi:blocked"]);
  });
});

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-stage-"));
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "git-vibe-runner-"));
  mkdirSync(join(cwd, ".github"));
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), workspaceConfigWithTestAi());
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  return cwd;
}

/** @param {any[]} responses */
function fetchMock(responses) {
  return vi.fn(
    /**
     * @param {any} url
     * @param {any} [init]
     */
    async (url, init = {}) => {
      if (isLabelRequest(url, init)) return response(200, {});
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      return next;
    },
  );
}

/** @param {any} url @param {any} init */
function isLabelRequest(url, init) {
  const method = String(init.method || "GET").toUpperCase();
  return method === "POST"
    ? /\/issues\/\d+\/labels$/.test(String(url))
    : method === "DELETE" && String(url).includes("/labels/");
}

/** @param {ReturnType<typeof vi.fn>} fetch */
function issueCommentCall(fetch) {
  return fetch.mock.calls.find(([url, init]) => {
    return (
      String(url).includes("/repos/example/repo/issues/12/comments") &&
      String(init?.method || "GET").toUpperCase() === "POST"
    );
  });
}

/**
 * @param {ReturnType<typeof vi.fn>} fetch
 * @param {string} label
 */
function labelRequestBody(fetch, label) {
  const call = fetch.mock.calls.find(([url, init]) => {
    if (!String(url).includes("/repos/example/repo/issues/12/labels")) return false;
    if (String(init?.method || "GET").toUpperCase() !== "POST") return false;
    return JSON.parse(String(init?.body || "{}")).labels?.[0] === label;
  });
  return call ? JSON.parse(String(call[1]?.body || "{}")) : undefined;
}

/** @param {string} body @param {Record<string, unknown>} [overrides] */
function issueResponse(body, overrides = {}) {
  return response(200, {
    body,
    created_at: "2026-01-02T00:00:00Z",
    html_url: "https://github.com/example/repo/issues/12",
    number: 12,
    title: "Issue title",
    user: { login: "octocat" },
    ...overrides,
  });
}

/** @param {unknown[]} comments */
const commentsResponse = (comments) => response(200, comments);

/** @param {number} status @param {unknown} value @returns {any} */
const response = (status, value) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(value),
});
