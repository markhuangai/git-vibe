// @ts-nocheck
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  globalThis.fetch = originalFetch;
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      GITVIBE_AI_API_KEY: "test-key",
      GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    }),
    RUNNER_TEMP: mkdtempSync(join(tmpdir(), "git-vibe-runner-")),
  };
});

describe("stage runner matrix member execution", () => {
  it("runs matrix members without deterministic publishing and persists role metadata", async () => {
    const cwd = await workspace(profileConfig());
    writeRole(cwd, "security.md", "Focus on token boundaries.");
    globalThis.fetch = fetchMock([issueResponse(), commentsResponse([])]);

    const result = await runStage({
      cwd,
      dryRun: true,
      executionMode: "member",
      issueNumber: "12",
      maxTurns: 2,
      prNumber: "",
      profileName: "test",
      repository: "example/repo",
      roleName: "security.md",
      stage: "review-matrix",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    expect(result.status).toBe("completed");
    expect(JSON.parse(readFileSync(result.resultFile, "utf8"))).toMatchObject({
      profile: "test",
      role: "security.md",
      stage: "review-matrix",
    });
  });

  it("blocks finalization when no matrix member results are available", async () => {
    const cwd = await workspace(roleGroupConfig());
    writeRole(cwd, "security.md", "Focus on token boundaries.");
    globalThis.fetch = fetchMock([issueResponse(), commentsResponse([])]);

    await expect(
      runStage({
        cwd,
        dryRun: true,
        executionMode: "finalizer",
        issueNumber: "12",
        maxTurns: 2,
        memberResultsDir: join(cwd, "missing-results"),
        prNumber: "",
        repository: "example/repo",
        stage: "review-matrix",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({
      parsedOutput: {
        findings: [expect.stringContaining("No review-matrix matrix member results")],
        next_state: "blocked",
        status: "blocked",
      },
    });
  });

  it("uses investigate-specific blocked output for empty matrix finalization", async () => {
    const cwd = await workspace(roleGroupConfig("investigate"));
    writeRole(cwd, "security.md", "Focus on missing information.");
    globalThis.fetch = fetchMock([issueResponse(), commentsResponse([])]);

    await expect(
      runStage({
        cwd,
        dryRun: true,
        executionMode: "finalizer",
        issueNumber: "12",
        maxTurns: 2,
        memberResultsDir: join(cwd, "missing-results"),
        prNumber: "",
        repository: "example/repo",
        stage: "investigate",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({
      parsedOutput: {
        blocking_questions: [
          {
            options: ["Rerun the stage after matrix member results are available."],
            question: expect.stringContaining("No investigate matrix member results"),
          },
        ],
        implementation_plan: [],
        questions: [],
      },
    });
  });
});

describe("stage runner matrix finalizer execution", () => {
  it("passes through single-profile member output during finalization", async () => {
    const cwd = await workspace(profileConfig());
    const resultsDir = join(cwd, "member-results");
    mkdirSync(resultsDir);
    writeFileSync(join(resultsDir, "git-vibe-review-matrix-result.json"), memberResult());
    globalThis.fetch = fetchMock([issueResponse(), commentsResponse([])]);

    await expect(
      runStage({
        cwd,
        dryRun: true,
        executionMode: "finalizer",
        issueNumber: "12",
        maxTurns: 2,
        memberResultsDir: resultsDir,
        prNumber: "",
        repository: "example/repo",
        stage: "review-matrix",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({
      parsedOutput: {
        comment_body: "Role reviewed.",
        next_state: "review-passed",
      },
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("does not synthesize role-group outputs in dry-run finalization", async () => {
    const cwd = await workspace(roleGroupConfig());
    writeRole(cwd, "security.md", "Focus on token boundaries.");
    const resultsDir = join(cwd, "member-results");
    mkdirSync(resultsDir);
    writeFileSync(join(resultsDir, "git-vibe-review-matrix-result.json"), memberResult());
    globalThis.fetch = fetchMock([issueResponse(), commentsResponse([])]);

    await expect(
      runStage({
        cwd,
        dryRun: true,
        executionMode: "finalizer",
        issueNumber: "12",
        maxTurns: 2,
        memberResultsDir: resultsDir,
        prNumber: "",
        repository: "example/repo",
        stage: "review-matrix",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({
      parsedOutput: {
        comment_body: "Role reviewed.",
        next_state: "review-passed",
      },
    });
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe("stage runner matrix finalizer synthesis", () => {
  it("synthesizes role-group member outputs into one final stage result", async () => {
    const cwd = await workspace(roleGroupConfig("validate"));
    writeRole(cwd, "security.md", "Focus on token boundaries.");
    const resultsDir = join(cwd, "member-results");
    mkdirSync(resultsDir);
    writeFileSync(join(resultsDir, "git-vibe-validate-result.json"), memberResult("validate"));
    generateText.mockResolvedValueOnce(aiResult("validate"));
    globalThis.fetch = fetchMock([
      issueResponse(),
      commentsResponse([]),
      response(200, {}),
      response(200, {}),
    ]);

    const result = await runStage({
      cwd,
      dryRun: false,
      executionMode: "finalizer",
      issueNumber: "",
      maxTurns: 2,
      memberResultsDir: resultsDir,
      prNumber: "",
      repository: "example/repo",
      stage: "validate",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    expect(result.summary).toBe("Synthesized.");
    expect(generateText.mock.calls[0][0].prompt).toContain("<role_group_results>");
    expect(generateText.mock.calls[0][0].prompt).toContain('"configured_members"');
    expect(generateText.mock.calls[0][0].prompt).toContain(
      '"role_definition": "Focus on token boundaries."',
    );
    expect(generateText.mock.calls[0][0].system).toContain("<role_group_synthesizer>");
    expect(generateText.mock.calls[0][0].system).toContain(
      "Inspect the repository and GitHub context",
    );
  });
});

async function workspace(config) {
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-stage-matrix-"));
  mkdirSync(join(cwd, ".github"), { recursive: true });
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), config);
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  return cwd;
}

function writeRole(cwd, file, content) {
  mkdirSync(join(cwd, ".git-vibe", "role-group"), { recursive: true });
  writeFileSync(join(cwd, ".git-vibe", "role-group", file), content);
}

function profileConfig() {
  return [
    "ai:",
    "  profiles:",
    "    test:",
    profileYaml(),
    "  stages:",
    "    review-matrix:",
    "      profile: test",
  ].join("\n");
}

function roleGroupConfig(stage = "review-matrix") {
  return [
    "ai:",
    "  profiles:",
    "    test:",
    profileYaml(),
    "  role_groups:",
    "    review_gate:",
    "      synthesizer: test",
    "      roles:",
    "        - role: security.md",
    "          profile: test",
    "  stages:",
    `    ${stage}:`,
    "      role_group: review_gate",
  ].join("\n");
}

function profileYaml() {
  return [
    "      provider:",
    "        type: openai-compatible",
    "        model: test-model",
    "        base_url:",
    "          from_bundle: GITVIBE_AI_BASE_URL",
    "        api_key:",
    "          from_bundle: GITVIBE_AI_API_KEY",
  ].join("\n");
}

function memberResult(stage = "review-matrix") {
  return JSON.stringify({
    parsedOutput: {
      assumptions: [],
      comment_body: "Role reviewed.",
      findings: [],
      next_state: nextStateForStage(stage),
      references: [],
      stage,
      status: "completed",
      summary: "Role reviewed.",
    },
    profile: "test",
    role: "security.md",
    schemaId: `${stage}.v1`,
    stage,
    status: "completed",
    summary: "Role reviewed.",
  });
}

function aiResult(stage) {
  const content = JSON.stringify({
    assumptions: [],
    comment_body: "Synthesized.",
    findings: [],
    next_state: nextStateForStage(stage),
    references: [],
    stage,
    status: "completed",
    summary: "Synthesized.",
  });
  return {
    steps: [{ toolCalls: [{ input: { content }, toolName: "output_validator" }] }],
    text: content,
  };
}

function nextStateForStage(stage) {
  if (stage === "validate") return "ready-for-implementation";
  return "review-passed";
}

const commentsResponse = (comments) => response(200, comments);
const issueResponse = () =>
  response(200, {
    body: "Issue body",
    created_at: "2026-01-02T00:00:00Z",
    html_url: "https://github.com/example/repo/issues/12",
    number: 12,
    title: "Issue title",
    user: { login: "octocat" },
  });

function fetchMock(responses) {
  return vi.fn(async () => responses.shift() || response(200, {}));
}

const response = (status, value) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(value),
});
