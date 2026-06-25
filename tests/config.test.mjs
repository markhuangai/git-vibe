import { describe, expect, it } from "vitest";
import { baseBranchFromEnv, parseGitVibeConfig, stageEnabled } from "../src/shared/config.ts";

describe("GitVibe stage config gates", () => {
  it("reads trimmed base branch overrides from env", () => {
    expect(baseBranchFromEnv({ GITVIBE_BASE_BRANCH: " main " })).toBe("main");
    expect(baseBranchFromEnv({ GITVIBE_BASE_BRANCH: " " })).toBeUndefined();
    expect(baseBranchFromEnv({})).toBeUndefined();
  });

  it("treats missing stage enabled config as enabled", () => {
    expect(stageEnabled({}, "validate")).toBe(true);
    expect(stageEnabled({ ai: {} }, "validate")).toBe(true);
    expect(stageEnabled({ ai: { stages: {} } }, "validate")).toBe(true);
  });

  it("reads explicit stage enabled flags", () => {
    expect(stageEnabled({ ai: { stages: { validate: { enabled: true } } } }, "validate")).toBe(
      true,
    );
    expect(stageEnabled({ ai: { stages: { validate: { enabled: false } } } }, "validate")).toBe(
      false,
    );
  });

  it("rejects malformed stage enabled config", () => {
    expect(() => stageEnabled({ ai: { stages: [] } }, "validate")).toThrow(
      "ai.stages must be an object",
    );
    expect(() => stageEnabled({ ai: { stages: { validate: false } } }, "validate")).toThrow(
      "ai.stages.validate must be an object",
    );
    expect(() =>
      stageEnabled({ ai: { stages: { validate: { enabled: "false" } } } }, "validate"),
    ).toThrow("ai.stages.validate.enabled must be a boolean");
  });

  it("parses empty GitVibe config as defaults", () => {
    expect(parseGitVibeConfig("")).toEqual({});
  });

  it("parses prompt-injection safety config", () => {
    expect(
      parseGitVibeConfig(`
safety:
  prompt_injection_gate: true
  block_write_stages_on_high_risk: true
  remove_approval_on_block: false
  ignored_authors:
    - custom-review-bot[bot]
`),
    ).toEqual({
      safety: {
        block_write_stages_on_high_risk: true,
        ignored_authors: ["custom-review-bot[bot]"],
        prompt_injection_gate: true,
        remove_approval_on_block: false,
      },
    });
  });
});
