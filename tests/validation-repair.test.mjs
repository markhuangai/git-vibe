// @ts-nocheck
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
  stepCountIs: vi.fn((count) => ({ count })),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));

const { runStage } = await import("../src/runner/stage-runner.ts");
const { buildValidationRepairPrompt, validationRepairAttemptsFor, validationRepairMaxTurnsFor } =
  await import("../src/runner/validation.ts");

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
    GITVIBE_AI_MODEL: "test-model",
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe("implementation validation repair", () => {
  it("feeds validation failures back into implementation before retrying checks", async () => {
    const cwd = await workspace("tests:\n  commands:\n    - 'test -f repaired && rm repaired'\n");
    commitAll(cwd);
    generateText.mockResolvedValueOnce(aiOutput("Initial implementation."));
    generateText.mockImplementationOnce(async () => {
      writeFileSync(join(cwd, "repaired"), "ok");
      return aiOutput("Repaired validation failure.");
    });
    globalThis.fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([]),
      response(200, { default_branch: "main" }),
      response(200, {}),
    ]);

    await expect(
      runStage({
        cwd,
        dryRun: false,
        issueNumber: "12",
        maxTurns: 5,
        prNumber: "",
        repository: "example/repo",
        stage: "implement",
        stageTimeoutMinutes: 1,
        token: "token",
        validationRepairAttempts: 1,
        validationRepairMaxTurns: 3,
      }),
    ).resolves.toMatchObject({ summary: "Repaired validation failure." });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[1][0]).toMatchObject({ stopWhen: { count: 3 } });
    expect(generateText.mock.calls[1][0].prompt).toContain("gitvibe_validation_repair");
    expect(generateText.mock.calls[1][0].prompt).toContain("test -f repaired && rm repaired");
  });

  it("stops without committing when validation repair returns blocked", async () => {
    const cwd = await workspace("tests:\n  commands:\n    - 'false'\n");
    commitAll(cwd);
    generateText.mockResolvedValueOnce(aiOutput("Initial implementation."));
    generateText.mockResolvedValueOnce(
      aiOutput("Repair blocked.", { next_state: "blocked", status: "blocked" }),
    );
    const fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([]),
      response(200, { default_branch: "main" }),
      response(200, {}),
      response(200, {}),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    await expect(
      runStage({
        cwd,
        dryRun: false,
        issueNumber: "12",
        maxTurns: 5,
        prNumber: "",
        repository: "example/repo",
        stage: "implement",
        stageTimeoutMinutes: 1,
        token: "token",
        validationRepairAttempts: 1,
        validationRepairMaxTurns: 3,
      }),
    ).resolves.toMatchObject({ status: "blocked" });

    expect(fetch.mock.calls[4][0]).toContain("/repos/example/repo/issues/12/comments");
    expect(JSON.parse(fetch.mock.calls[5][1].body).labels).toEqual(["git-vibe:blocked"]);
  });
});

describe("validation repair helpers", () => {
  it("resolves repair budgets from runner options, tests config, AI budgets, and defaults", () => {
    const runner = { maxTurns: 120, token: "token" };

    expect(
      validationRepairAttemptsFor(
        { ai: { budgets: { validation_repair_attempts: 4 } }, tests: {} },
        { ...runner, validationRepairAttempts: 3 },
      ),
    ).toBe(3);
    expect(
      validationRepairAttemptsFor(
        {
          ai: { budgets: { validation_repair_attempts: 4 } },
          tests: { validation_repair_attempts: 2 },
        },
        runner,
      ),
    ).toBe(2);
    expect(
      validationRepairAttemptsFor({ ai: { budgets: { validation_repair_attempts: 4 } } }, runner),
    ).toBe(4);
    expect(validationRepairAttemptsFor({}, runner)).toBe(3);

    expect(validationRepairMaxTurnsFor({}, { ...runner, validationRepairMaxTurns: 9 })).toBe(9);
    expect(
      validationRepairMaxTurnsFor({ ai: { budgets: { validation_repair_max_turns: 7 } } }, runner),
    ).toBe(7);
    expect(validationRepairMaxTurnsFor({}, runner)).toBe(45);
  });

  it("builds bounded redacted repair prompts when git metadata is unavailable", () => {
    process.env.GITVIBE_AI_ENV_JSON = JSON.stringify({ MINIMAX_API_KEY: "bundle-secret" });
    const prompt = buildValidationRepairPrompt({
      attempt: 1,
      basePrompt: "base",
      cwd: "/does/not/exist",
      failure: {
        command: "pnpm check",
        exitCode: 1,
        stderr: `secret-value bundle-secret ${"x".repeat(5000)}`,
        stdout: "secret-value bundle-secret stdout",
      },
      maxAttempts: 2,
      runner: { maxTurns: 5, token: "secret-value" },
    });

    expect(prompt).toContain("gitvibe_validation_repair");
    expect(prompt).toContain("output truncated");
    expect(prompt).not.toContain("secret-value");
    expect(prompt).not.toContain("bundle-secret");
  });
});

function aiOutput(summary, overrides = {}) {
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
                tests: ["test -f repaired && rm repaired"],
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

async function workspace(config = "") {
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-repair-"));
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

function fetchMock(responses) {
  return vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
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

function response(status, body) {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}
