// @ts-nocheck
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    generateText,
    stepCountIs: vi.fn((count) => ({ count })),
  };
});
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") })),
}));

const { runAiStage } = await import("../src/runner/ai.ts");
const {
  domainInputAllowedByPolicy,
  domainPatternAllowed,
  filterToolsForWebPolicy,
  logCliWebPolicyNotice,
  urlAllowedByPolicy,
  webPolicyFor,
} = await import("../src/runner/ai-web-policy.ts");
const { createAllowlistedWebFetch, createAllowlistedWebSearch } =
  await import("../src/runner/ai-web-tools.ts");
const { createGitHubSearch } = await import("../src/runner/github-search.ts");
const { stageDefinitions } = await import("../src/shared/stages.ts");

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  generateText.mockReset();
  createOpenAI.mockClear();
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      OPENAI_BASE_URL: "https://proxy.test/v1",
      OPENAI_KEY: "openai-key",
    }),
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe("AI web policy", () => {
  it("uses GitHub-only search and disables website tools by default", async () => {
    generateText.mockResolvedValueOnce(aiResult("validate"));

    await expect(runAiStage(validateStageOptions(config()))).resolves.toBe(
      '{"stage":"validate","status":"completed"}',
    );

    expect(Object.keys(generateText.mock.calls[0][0].tools).sort()).toEqual([
      "agent",
      "github_search",
      "glob",
      "grep",
      "output_validator",
      "read",
    ]);
  });

  it("rejects explicit stage web tools when the policy blocks them", async () => {
    await expect(
      runAiStage(validateStageOptions(config({ validate: { tools: ["read", "web-fetch"] } }))),
    ).rejects.toThrow(
      "ai.stages.validate.tools includes tools blocked by ai.security.web: web-fetch.",
    );

    expect(generateText).not.toHaveBeenCalled();
  });

  it("allows website tools only through an explicit domain allowlist", async () => {
    generateText.mockResolvedValueOnce(aiResult("validate"));

    await expect(
      runAiStage(
        validateStageOptions(
          config(
            { validate: { tools: ["github-search", "web-search", "web-fetch"] } },
            {
              security: {
                web: {
                  allowed_domains: ["github.com", "*.github.com"],
                },
              },
            },
          ),
        ),
      ),
    ).resolves.toBe('{"stage":"validate","status":"completed"}');

    expect(Object.keys(generateText.mock.calls[0][0].tools).sort()).toEqual([
      "github_search",
      "output_validator",
      "web_fetch",
      "web_search",
    ]);
  });
});

describe("web policy domain validation", () => {
  it("validates exact and wildcard domain patterns", () => {
    const policy = webPolicyFor({
      ai: {
        security: {
          web: {
            allowed_domains: ["github.com", "*.github.com"],
          },
        },
      },
    });

    expect(domainPatternAllowed("docs.github.com", "*.github.com")).toBe(true);
    expect(domainPatternAllowed("github.com", "*.github.com")).toBe(false);
    expect(domainPatternAllowed("github.com.evil.example", "*.github.com")).toBe(false);
    expect(domainPatternAllowed("github.com", "github.com")).toBe(true);
    expect(domainInputAllowedByPolicy("docs.github.com", policy)).toBe(true);
    expect(domainInputAllowedByPolicy("*.github.com", policy)).toBe(true);
    expect(domainInputAllowedByPolicy("github.com.evil.example", policy)).toBe(false);
    expect(domainInputAllowedByPolicy("https://github.com", policy)).toBe(false);
    expect(urlAllowedByPolicy("https://docs.github.com/actions", policy)).toBe(true);
    expect(urlAllowedByPolicy("not a url", policy)).toBe(false);
    expect(() =>
      webPolicyFor({
        ai: { security: { web: { allowed_domains: ["https://github.com"] } } },
      }),
    ).toThrow("Invalid ai.security.web.allowed_domains entry: https://github.com.");
  });

  it("rejects malformed web policy config", () => {
    expect(() => webPolicyFor({ ai: { security: [] } })).toThrow("ai.security must be an object.");
    expect(() => webPolicyFor({ ai: { security: { web: [] } } })).toThrow(
      "ai.security.web must be an object.",
    );
    expect(() => webPolicyFor({ ai: { security: { web: { allow_fetch: false } } } })).toThrow(
      "ai.security.web.allow_fetch is not supported.",
    );
    expect(() =>
      webPolicyFor({ ai: { security: { web: { allowed_domains: "github.com" } } } }),
    ).toThrow("ai.security.web.allowed_domains must be a string array.");
    expect(() =>
      webPolicyFor({
        ai: { security: { web: { allowed_domains: ["api.*.github.com"] } } },
      }),
    ).toThrow("Invalid ai.security.web.allowed_domains wildcard: api.*.github.com.");
    expect(() =>
      webPolicyFor({
        ai: { security: { web: { allowed_domains: ["localhost"] } } },
      }),
    ).toThrow("Invalid ai.security.web.allowed_domains entry: localhost.");
  });
});

describe("web policy tool filtering", () => {
  it("filters default tools and writes CLI notices", () => {
    const logger = { event: vi.fn() };
    const filtered = filterToolsForWebPolicy({
      config: {},
      explicit: false,
      logger,
      stage: "validate",
      tools: ["read", "github-search", "web-search", "web-fetch"],
    });
    expect(filtered).toEqual(["read", "github-search"]);
    expect(logger.event).toHaveBeenCalledWith("ai.web_policy.tools_disabled", {
      tools: "web-search,web-fetch",
      website_access: "disabled",
    });

    expect(
      filterToolsForWebPolicy({
        config: { ai: { security: { web: {} } } },
        explicit: false,
        stage: "validate",
        tools: ["github-search", "read"],
      }),
    ).toEqual(["github-search", "read"]);

    const summaryDir = mkdtempSync(join(tmpdir(), "git-vibe-web-policy-"));
    process.env.GITHUB_STEP_SUMMARY = join(summaryDir, "summary.md");
    logCliWebPolicyNotice({ adapter: "cli-codex", config: {}, logger });
    expect(readFileSync(process.env.GITHUB_STEP_SUMMARY, "utf8")).toContain(
      "Native CLI web-search/web-fetch tools are disabled",
    );
  });
});

describe("allowlisted web tools", () => {
  it("blocks fetches outside the configured domain policy", async () => {
    globalThis.fetch = vi.fn();
    const fetchTool = createAllowlistedWebFetch(allowlistPolicy());

    await expect(fetchTool.execute({ url: "https://example.com" })).resolves.toContain(
      "URL is blocked",
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetches allowlisted URLs and reports request failures", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(response("hello", "text/plain"))
      .mockRejectedValueOnce(new Error("network down"));
    const fetchTool = createAllowlistedWebFetch(allowlistPolicy());

    await expect(fetchTool.execute({ url: "https://docs.github.com/actions" })).resolves.toContain(
      "Status: 200",
    );
    await expect(fetchTool.execute({ url: "https://docs.github.com/actions" })).resolves.toContain(
      "network down",
    );
  });

  it("reports truncated allowlisted fetches and non-error failures", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(response("x".repeat(100001)))
      .mockRejectedValueOnce("string failure");
    const fetchTool = createAllowlistedWebFetch(allowlistPolicy());

    const truncated = await fetchTool.execute({ url: "https://docs.github.com/actions" });
    expect(truncated).toContain("(Content truncated to 100,000 characters)");
    expect(truncated).toContain("Content-Type: ");
    await expect(fetchTool.execute({ url: "https://docs.github.com/actions" })).resolves.toContain(
      "string failure",
    );
  });

  it("validates web search domain filters before execution", async () => {
    const searchTool = createAllowlistedWebSearch(allowlistPolicy());

    await expect(
      searchTool.execute({ allowed_domains: ["github.com"], query: "actions" }),
    ).resolves.toContain("no external web search backend");
    await expect(
      searchTool.execute({ allowed_domains: ["example.com"], query: "actions" }),
    ).resolves.toContain("requested domains are blocked");
    await expect(searchTool.execute({ query: "actions" })).resolves.toContain(
      "no external web search backend",
    );
  });
});

describe("GitHub search tool", () => {
  it("constrains searches to the current repository", async () => {
    const request = vi.fn(async () => ({
      items: [{ html_url: "https://github.com/example/repo/issues/1", number: 1, title: "Auth" }],
    }));
    const search = createGitHubSearch({
      github: { client: { request }, repository: "example/repo", token: "token" },
    });

    const result = await search.execute(
      { kind: "issues", limit: 1, query: "repo:other/project auth" },
      { messages: [], toolCallId: "call" },
    );

    expect(result).toContain("#1 Auth");
    expect(request.mock.calls[0][0].path).toContain("repo%3Aexample%2Frepo");
    expect(request.mock.calls[0][0].path).not.toContain("other%2Fproject");
  });

  it("searches code and formats empty results", async () => {
    const request = vi.fn(async () => ({ items: [] }));
    const search = createGitHubSearch({
      github: { client: { request }, repository: "example/repo", token: "token" },
    });

    const result = await search.execute({ kind: "code", limit: 2, query: "auth" });

    expect(result).toBe("Code:\n- No matches.");
    expect(request.mock.calls[0][0].path).toContain("/search/code");
    expect(request.mock.calls[0][0].path).toContain("per_page=2");
  });

  it("searches issues and code together", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ html_url: "https://github.com/example/repo/issues/2", state: "open" }],
      })
      .mockResolvedValueOnce({
        items: [
          { html_url: "https://github.com/example/repo/blob/main/src/a.ts", path: "src/a.ts" },
        ],
      });
    const search = createGitHubSearch({
      github: { client: { request }, repository: "example/repo", token: "token" },
    });

    const result = await search.execute({ query: "auth" });

    expect(result).toContain("Issues and pull requests:");
    expect(result).toContain("<untitled> (open)");
    expect(result).toContain("Code:");
    expect(result).toContain("src/a.ts");
  });

  it("reports unavailable GitHub context and invalid queries", async () => {
    const missingContext = createGitHubSearch({});
    await expect(missingContext.execute({ query: "auth" })).resolves.toContain(
      "GitHub context is unavailable",
    );

    const search = createGitHubSearch({
      github: { client: { request: vi.fn() }, repository: "example/repo", token: "token" },
    });
    await expect(search.execute({ query: "repo:other/project" })).resolves.toContain(
      "query must include search terms",
    );
  });

  it("returns GitHub API errors as tool output", async () => {
    const search = createGitHubSearch({
      github: {
        client: { request: vi.fn(async () => Promise.reject(new Error("rate limited"))) },
        repository: "example/repo",
        token: "token",
      },
    });

    await expect(search.execute({ kind: "issues", query: "auth" })).resolves.toContain(
      "rate limited",
    );
  });
});

function validateStageOptions(config) {
  return {
    config,
    cwd: process.cwd(),
    maxTurns: 1,
    prompt: "Prompt",
    schema: {},
    schemaId: "schema",
    stage: "validate",
    stageDefinition: stageDefinitions.validate,
    system: "System",
  };
}

function config(stages = {}, ai = {}) {
  return {
    ai: {
      ...ai,
      profiles: {
        test: {
          provider: {
            api_key: { from_bundle: "OPENAI_KEY" },
            base_url: { from_bundle: "OPENAI_BASE_URL" },
            model: "gpt-test",
            type: "openai-compatible",
          },
        },
      },
      stages: {
        validate: {
          profile: "test",
          ...stages.validate,
        },
      },
    },
  };
}

function aiResult(stage) {
  const content = JSON.stringify({ stage, status: "completed" });
  return {
    steps: [{ toolCalls: [{ input: { content }, toolName: "output_validator" }] }],
    text: content,
  };
}

function allowlistPolicy() {
  return {
    allowedDomains: ["github.com", "*.github.com"],
  };
}

function response(body, contentType = "") {
  return {
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : "") },
    status: 200,
    text: async () => body,
  };
}
