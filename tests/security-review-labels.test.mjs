// @ts-nocheck
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStageSecurityReview } from "../src/runner/stage-runner.ts";
import { workspaceConfigWithTestAi } from "./support/ai-config.mjs";
import { queueAllowedSafetyFinding } from "./support/safety-ai.mjs";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      GITVIBE_AI_API_KEY: "test-key",
    }),
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe("security review labels", () => {
  it("marks pull request review running before review matrix jobs start", async () => {
    const cwd = await workspace();
    queueAllowedSafetyFinding();
    const fetch = fetchMock([
      issueResponse("PR body"),
      commentsResponse([]),
      pullRequestResponse("git-vibe/12"),
      reviewThreadsResponse(),
      pullRequestReviewsResponse(),
      pullRequestFilesResponse([]),
    ]);
    globalThis.fetch = fetch;

    const result = await runStageSecurityReview({
      cwd,
      dryRun: false,
      issueNumber: "",
      maxTurns: 1,
      prNumber: "12",
      repository: "example/repo",
      stage: "review-matrix",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    expect(result).toMatchObject({ allowed: true, status: "allowed" });
    expect(labelRemovalPath(fetch, "gvi:ready-for-approval")).toBeTruthy();
    expect(labelRequestBody(fetch, "gvi:reviewing")?.labels).toEqual(["gvi:reviewing"]);
    expect(globalThis.__gitVibeSdkMocks.codexRun).toHaveBeenCalledTimes(1);
  });

  it("leaves pull request review labels untouched during dry runs", async () => {
    const cwd = await workspace();
    queueAllowedSafetyFinding();
    const fetch = fetchMock([
      issueResponse("PR body"),
      commentsResponse([]),
      pullRequestResponse("git-vibe/12"),
      reviewThreadsResponse(),
      pullRequestReviewsResponse(),
      pullRequestFilesResponse([]),
    ]);
    globalThis.fetch = fetch;

    await runStageSecurityReview({
      cwd,
      dryRun: true,
      issueNumber: "",
      maxTurns: 1,
      prNumber: "12",
      repository: "example/repo",
      stage: "review-matrix",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    expect(labelCalls(fetch)).toHaveLength(0);
  });

  it("does not mark issue-backed security reviews as pull request reviews", async () => {
    const cwd = await workspace();
    queueAllowedSafetyFinding();
    const fetch = fetchMock([issueResponse("Issue body"), commentsResponse([])]);
    globalThis.fetch = fetch;

    await runStageSecurityReview({
      cwd,
      dryRun: false,
      issueNumber: "12",
      maxTurns: 1,
      prNumber: "",
      repository: "example/repo",
      stage: "review-matrix",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    expect(labelCalls(fetch)).toHaveLength(0);
  });
});

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-security-review-labels-"));
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "git-vibe-runner-"));
  mkdirSync(join(cwd, ".github"));
  writeFileSync(
    join(cwd, ".github", "git-vibe.yml"),
    workspaceConfigWithTestAi(`safety:
  prompt_injection_gate: true
`),
  );
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

function issueResponse(body) {
  return response(200, {
    body,
    created_at: "2026-01-02T00:00:00Z",
    html_url: "https://github.com/example/repo/issues/12",
    number: 12,
    title: "PR title",
    updated_at: "2026-01-02T00:00:00Z",
    user: { login: "octocat" },
  });
}

const commentsResponse = (comments) => response(200, comments);

const pullRequestResponse = (branch) =>
  response(200, { head: { ref: branch, repo: { full_name: "example/repo" } } });

const reviewThreadsResponse = () =>
  graphqlResponse({ repository: { pullRequest: { reviewThreads: { nodes: [] } } } });

const pullRequestReviewsResponse = () => response(200, []);

const pullRequestFilesResponse = (files) => response(200, files);

const response = (status, value) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(value),
});

const graphqlResponse = (data) => response(200, { data });

function labelRequestBody(fetch, label) {
  const call = fetch.mock.calls.find(([url, init]) => {
    if (!String(url).includes("/repos/example/repo/issues/12/labels")) return false;
    if (String(init?.method || "GET").toUpperCase() !== "POST") return false;
    return JSON.parse(String(init?.body || "{}")).labels?.[0] === label;
  });
  return call ? JSON.parse(String(call[1]?.body || "{}")) : undefined;
}

function labelRemovalPath(fetch, label) {
  return fetch.mock.calls.find(([url, init]) => {
    return (
      String(url).includes(`/labels/${encodeURIComponent(label)}`) &&
      String(init?.method || "GET").toUpperCase() === "DELETE"
    );
  })?.[0];
}

function labelCalls(fetch) {
  return fetch.mock.calls.filter(([url, init]) => isLabelRequest(url, init));
}
