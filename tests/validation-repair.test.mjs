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
  hasToolCall: vi.fn((toolName) => ({ toolName })),
  stepCountIs: vi.fn((count) => ({ count })),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));

const { runStage } = await import("../src/runner/stage-runner.ts");
const {
  buildValidationRepairPrompt,
  runValidationCommand,
  validationRepairAttemptsFor,
  validationRepairMaxTurnsFor,
} = await import("../src/runner/validation.ts");

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
  delete process.env.GITVIBE_BASE_BRANCH;
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
    expect(generateText.mock.calls[1][0]).toMatchObject({
      stopWhen: [expect.any(Function), { count: 3 }],
    });
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

    expect(fetch.mock.calls.some(([url]) => String(url).includes("/issues/12/comments"))).toBe(
      true,
    );
    expect(labelBodies(fetch)).toContainEqual(["gvi:blocked"]);
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

  it("runs validation commands without runner secrets in the child environment", () => {
    process.env.GITVIBE_GITHUB_TOKEN = "repo-token";
    process.env.GITVIBE_AI_ENV_JSON = JSON.stringify({ MINIMAX_API_KEY: "bundle-secret" });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const script = [
      "process.stdout.write(process.env.GITVIBE_GITHUB_TOKEN || 'missing-token')",
      "process.stderr.write(process.env.GITVIBE_AI_ENV_JSON || 'missing-bundle')",
    ].join(";");

    try {
      runValidationCommand(
        process.cwd(),
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      );
      expect(stdout).toHaveBeenCalledWith("missing-token");
      expect(stderr).toHaveBeenCalledWith("missing-bundle");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
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

function labelBodies(fetch) {
  return fetch.mock.calls
    .filter(
      ([url, init]) => isLabelRequest(url, init) && String(init.method).toUpperCase() === "POST",
    )
    .map(([, init]) => JSON.parse(init.body).labels);
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
