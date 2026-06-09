// @ts-nocheck
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptedRiskArtifactContentSha,
  acceptedRiskMetadataBlock,
} from "../src/shared/accepted-risk.ts";
import { gitVibeLabels } from "../src/shared/labels.ts";
import { workspaceConfigWithTestAi } from "./support/ai-config.mjs";

const mocks = vi.hoisted(() => ({ buildMcpPromptContext: vi.fn() }));
const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));

vi.mock("ai", () => ({
  generateText,
  hasToolCall: vi.fn((toolName) => ({ toolName })),
  stepCountIs: vi.fn((count) => ({ count })),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn() }));
vi.mock("../src/runner/mcp-context.js", () => ({
  buildMcpPromptContext: mocks.buildMcpPromptContext,
}));

const { runStage } = await import("../src/runner/stage-runner.ts");
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  generateText.mockReset();
  mocks.buildMcpPromptContext.mockReset();
  mocks.buildMcpPromptContext.mockResolvedValue({ promptAddition: "" });
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

describe("direct accepted-risk stage runs", () => {
  it("publishes the audit and removes the accept-risk label", async () => {
    const cwd = await workspace();
    generateText.mockResolvedValueOnce(investigateAiOutput("Ready to implement."));
    const fetch = fetchMock([
      issueResponse("Issue body", [gitVibeLabels.acceptRisk.name]),
      commentsResponse([acceptedRiskMetadataComment({ body: "Issue body" })]),
      response(200, { id: 4 }),
      response(200, { id: 5 }),
      response(200, { id: 6 }),
      response(200, { id: 7 }),
    ]);
    globalThis.fetch = fetch;

    const result = await runStage({
      cwd,
      dryRun: false,
      issueNumber: "12",
      maxTurns: 2,
      prNumber: "",
      repository: "example/repo",
      stage: "investigate",
      stageTimeoutMinutes: 1,
      token: "token",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    });

    expect(result).toMatchObject({
      parsedOutput: { comment_body: "Ready to implement.", findings: [] },
      status: "completed",
      summary: "Ready.",
    });
    expect(issueCommentBodies(fetch).join("\n")).toContain("GitVibe Risk Accepted");
    expect(labelRemovalPath(fetch, gitVibeLabels.acceptRisk.name)).toBeTruthy();
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-accepted-risk-stage-"));
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "git-vibe-runner-"));
  mkdirSync(join(cwd, ".github"));
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), workspaceConfigWithTestAi());
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  return cwd;
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
  return method === "POST"
    ? /\/issues\/\d+\/labels$/.test(String(url))
    : method === "DELETE" && String(url).includes("/labels/");
}

function issueResponse(body, labels = []) {
  return response(200, {
    body,
    created_at: "2026-01-02T00:00:00Z",
    html_url: "https://github.com/example/repo/issues/12",
    labels,
    number: 12,
    title: "Issue title",
    updated_at: "2026-01-02T00:00:00Z",
    user: { login: "octocat" },
  });
}

const commentsResponse = (comments) => response(200, comments);

function investigateAiOutput(commentBody) {
  return {
    steps: [
      {
        toolCalls: [
          {
            input: {
              content: JSON.stringify({
                assumptions: [],
                blocking_questions: [],
                comment_body: commentBody,
                findings: [],
                implementation_plan: ["Implement the verified change."],
                next_state: "ready-for-implementation",
                references: [],
                stage: "investigate",
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
  };
}

function acceptedRiskMetadataComment({ body, title = "Issue title" }) {
  const metadata = {
    actor: "maintainer",
    artifact: "issue",
    artifactContentSha: acceptedRiskArtifactContentSha({ body, title }),
    cutoff: "2026-01-04T00:00:00Z",
    number: "12",
    run: "99",
    stage: "investigate",
    stages: ["investigate"],
  };
  return {
    author_association: "OWNER",
    body: [
      "<!-- git-vibe:stage-result stage=investigate artifact=issue number=12 -->",
      "## GitVibe Investigation",
      "",
      "**Status:** `blocked`",
      acceptedRiskMetadataBlock(metadata),
    ].join("\n"),
    created_at: "2026-01-03T00:00:00Z",
    html_url: "https://github.com/example/repo/issues/12#issuecomment-3",
    id: 3,
    updated_at: "2026-01-04T00:00:00Z",
    user: { login: "github-actions[bot]" },
  };
}

const response = (status, value) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(value),
});

function issueCommentBodies(fetch) {
  return fetch.mock.calls
    .filter(([url, init]) => {
      return (
        String(url).includes("/repos/example/repo/issues/12/comments") &&
        String(init?.method || "GET").toUpperCase() === "POST"
      );
    })
    .map(([, init]) => JSON.parse(String(init?.body || "{}")).body);
}

function labelRemovalPath(fetch, label) {
  return fetch.mock.calls.find(([url, init]) => {
    return (
      String(url).includes(`/labels/${encodeURIComponent(label)}`) &&
      String(init?.method || "GET").toUpperCase() === "DELETE"
    );
  })?.[0];
}
