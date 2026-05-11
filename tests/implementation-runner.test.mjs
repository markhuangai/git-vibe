// @ts-nocheck
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
  createOpenAI.mockClear();
  createAnthropic.mockClear();
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      GITVIBE_AI_API_KEY: "test-key",
      GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    }),
  };
  delete process.env.GITVIBE_BASE_BRANCH;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  vi.unstubAllEnvs();
});

describe("implementation structured output recovery", () => {
  it("continues malformed implementation output with validator-only tools", async () => {
    const cwd = await workspace();
    commitAll(cwd);
    generateText.mockResolvedValueOnce({ steps: [], text: "not json" });
    generateText.mockResolvedValueOnce(implementAiOutput("Recovered structured output."));
    globalThis.fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([]),
      response(200, { default_branch: "main" }),
      response(200, {}),
    ]);

    await expect(runImplement(cwd, { maxTurns: 200 })).resolves.toMatchObject({
      summary: "Recovered structured output.",
    });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[0][0]).toMatchObject({
      stopWhen: [expect.any(Function), { count: 190 }],
    });
    expect(generateText.mock.calls[1][0]).toMatchObject({
      activeTools: ["output_validator"],
      stopWhen: [expect.any(Function), { count: 10 }],
      toolChoice: { type: "tool", toolName: "output_validator" },
    });
    expect(generateText.mock.calls[1][0].messages.at(-1).content).toContain(
      "Call output_validator with the exact final JSON.",
    );
    expect(Object.keys(generateText.mock.calls[1][0].tools).sort()).toEqual(["output_validator"]);
    expect(generateText.mock.calls[1][0].tools.edit).toBeUndefined();
    expect(generateText.mock.calls[1][0].tools.write).toBeUndefined();
    expect(generateText.mock.calls[1][0].tools.multi_edit).toBeUndefined();
  });

  it("publishes a blocked implementation result when structured output finalization fails", async () => {
    const cwd = await workspace();
    commitAll(cwd);
    generateText.mockResolvedValueOnce({ steps: [], text: "not json" });
    generateText.mockResolvedValueOnce({ steps: [], text: "still not json" });
    const fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([]),
      response(200, { default_branch: "main" }),
      response(200, {}),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    await expect(runImplement(cwd)).resolves.toMatchObject({
      status: "blocked",
      summary: "Implementation stopped because the stage did not return schema-valid JSON.",
    });

    expect(issueCommentCall(fetch)?.[0]).toContain("/repos/example/repo/issues/12/comments");
    expect(labelRequestBody(fetch, "gvi:blocked")?.labels).toEqual(["gvi:blocked"]);
  });
});

describe("implementation runtime artifact staging", () => {
  it("does not commit tracked runtime artifact modifications", async () => {
    const cwd = await workspace();
    mkdirSync(join(cwd, ".git-vibe", "actions"), { recursive: true });
    for (let index = 0; index < 13; index += 1) {
      writeFileSync(join(cwd, `.git-vibe/actions/runtime-${index}.txt`), "old\n");
    }
    commitAll(cwd);
    generateText.mockImplementationOnce(async () => {
      for (let index = 0; index < 13; index += 1) {
        writeFileSync(join(cwd, `.git-vibe/actions/runtime-${index}.txt`), "new\n");
      }
      return implementAiOutput("Only runtime artifacts changed.");
    });
    globalThis.fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([]),
      response(200, { default_branch: "main" }),
      response(200, {}),
    ]);

    await expect(runImplement(cwd)).resolves.toMatchObject({ status: "completed" });

    expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd }).toString().trim()).toBe(
      "1",
    );
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd }).toString()).toBe("");
    expect(
      execFileSync("git", ["diff", "--name-only", "--", ".git-vibe/actions/runtime-0.txt"], {
        cwd,
      }).toString(),
    ).toContain(".git-vibe/actions/runtime-0.txt");
  });
});

async function runImplement(cwd, overrides = {}) {
  return runStage({
    cwd,
    dryRun: false,
    issueNumber: "12",
    maxTurns: 5,
    prNumber: "",
    repository: "example/repo",
    stage: "implement",
    stageTimeoutMinutes: 1,
    token: "token",
    ...overrides,
  });
}

async function workspace(config = "") {
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-implementation-"));
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "git-vibe-runner-"));
  mkdirSync(join(cwd, ".github"));
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), workspaceConfigWithTestAi(config));
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  return cwd;
}

function commitAll(cwd) {
  execFileSync("git", ["config", "user.name", "tester"], { cwd });
  execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd });
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
}

function implementAiOutput(summary, overrides = {}) {
  return {
    steps: [
      {
        toolCalls: [
          {
            input: {
              content: JSON.stringify({
                assumptions: [],
                comment_body: summary,
                findings: [],
                next_state: "changes-ready-for-commit",
                references: [],
                stage: "implement",
                status: "completed",
                summary,
                tests: [],
                ...overrides,
              }),
            },
            toolName: "output_validator",
          },
        ],
      },
    ],
    text: "{}",
  };
}

function fetchMock(responses) {
  return vi.fn(async (url, init = {}) => {
    if (isLabelRequest(url, init)) return response(200, {});
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
}

function isLabelRequest(url, init) {
  const method = String(init.method || "GET").toUpperCase();
  const path = String(url);
  return (
    (method === "POST" && /\/issues\/\d+\/labels$/.test(path)) ||
    (method === "DELETE" && path.includes("/labels/"))
  );
}

function issueCommentCall(fetch) {
  return fetch.mock.calls.find(([url, init]) => {
    return (
      String(url).includes("/repos/example/repo/issues/12/comments") &&
      String(init?.method || "GET").toUpperCase() === "POST"
    );
  });
}

function labelRequestBody(fetch, label) {
  const call = fetch.mock.calls.find(([url, init]) => {
    if (!String(url).includes("/repos/example/repo/issues/12/labels")) return false;
    if (String(init?.method || "GET").toUpperCase() !== "POST") return false;
    return JSON.parse(String(init?.body || "{}")).labels?.[0] === label;
  });
  return call ? JSON.parse(String(call[1]?.body || "{}")) : undefined;
}

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

function commentsResponse(comments) {
  return response(200, comments);
}

function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  };
}
