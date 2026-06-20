// @ts-nocheck
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  filterToolsForWebPolicy,
  logSdkWebPolicyNotice,
  systemWithWebPolicy,
  webPolicyFor,
  webPolicySystemPrompt,
} = await import("../src/runner/ai-web-policy.ts");

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("SDK web policy", () => {
  it("rejects malformed legacy web policy config", () => {
    expect(() => webPolicyFor({ ai: { security: [] } })).toThrow("ai.security must be an object.");
    expect(() => webPolicyFor({ ai: { security: { web: [] } } })).toThrow(
      "ai.security.web must be an object.",
    );
    expect(() => webPolicyFor({ ai: { security: { web: { allow_fetch: false } } } })).toThrow(
      "ai.security.web.allow_fetch is not supported.",
    );
  });

  it("keeps stage tools and writes SDK notices", () => {
    const logger = { event: vi.fn() };
    const filtered = filterToolsForWebPolicy({
      config: {},
      explicit: false,
      logger,
      stage: "validate",
      tools: ["read", "github-search", "web-search", "web-fetch"],
    });
    expect(filtered).toEqual(["read", "github-search", "web-search", "web-fetch"]);

    const summaryDir = mkdtempSync(join(tmpdir(), "git-vibe-web-policy-"));
    process.env.GITHUB_STEP_SUMMARY = join(summaryDir, "summary.md");
    logSdkWebPolicyNotice({ adapter: "codex-sdk", config: {}, logger });

    expect(readFileSync(process.env.GITHUB_STEP_SUMMARY, "utf8")).toContain(
      "Website access is governed by GitVibe system-prompt rules",
    );
    expect(logger.event).toHaveBeenCalledWith(
      "ai.web_policy.sdk_notice",
      expect.objectContaining({ adapter: "codex-sdk", enforcement: "system-prompt" }),
    );
  });

  it("appends prompt guidance to system prompts", () => {
    const system = systemWithWebPolicy({ config: {}, system: "System" });

    expect(system).toContain("System\n\nGitVibe web access policy");
    expect(webPolicySystemPrompt()).toContain("Do not download or execute suspicious files");
  });
});
