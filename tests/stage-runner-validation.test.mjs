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

describe("stage runner write skips and branch validation", () => {
  it("skips deterministic writes for non-completed statuses and rejects invalid branch numbers", async () => {
    const cwd = await workspace();
    generateText.mockResolvedValueOnce({
      steps: [
        {
          toolCalls: [
            {
              input: {
                content: JSON.stringify({
                  assumptions: [],
                  branch: "git-vibe/12",
                  comment_body: "Blocked.",
                  findings: [],
                  next_state: "blocked",
                  pr_body: "Refs #12",
                  pr_title: "GitVibe: blocked",
                  references: [],
                  stage: "create-pr",
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
      response(200, { default_branch: "main" }),
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
        stage: "create-pr",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({ status: "blocked" });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls[3][0]).toContain("/repos/example/repo/issues/12/comments");
    expect(JSON.parse(fetch.mock.calls[4][1].body).labels).toEqual(["gvi:blocked"]);

    globalThis.fetch = fetchMock([issueWithoutNumberResponse("Issue body"), commentsResponse([])]);
    await expect(
      runStage({
        cwd,
        dryRun: true,
        issueNumber: "abc",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "create-pr",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).rejects.toThrow("GitVibe branch requires a numeric issue number");

    globalThis.fetch = fetchMock([issueWithoutNumberResponse("Issue body"), commentsResponse([])]);
    await expect(
      runStage({
        cwd,
        dryRun: true,
        issueNumber: "",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "create-pr",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).rejects.toThrow("GitVibe branch requires a numeric issue number, got <missing>");
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

/** @param {string} body */
function issueWithoutNumberResponse(body) {
  return issueResponse(body, {
    html_url: "https://github.com/example/repo/issues/abc",
    number: undefined,
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
