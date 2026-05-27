import { describe, expect, it } from "vitest";
import { parseGitVibeConfig, stageEnabled } from "../src/shared/config.ts";

describe("GitVibe stage config gates", () => {
  it("treats missing stage enabled config as enabled", () => {
    expect(stageEnabled({}, "implement")).toBe(true);
    expect(stageEnabled({ ai: {} }, "implement")).toBe(true);
    expect(stageEnabled({ ai: { stages: {} } }, "implement")).toBe(true);
  });

  it("reads explicit stage enabled flags", () => {
    expect(stageEnabled({ ai: { stages: { implement: { enabled: true } } } }, "implement")).toBe(
      true,
    );
    expect(stageEnabled({ ai: { stages: { implement: { enabled: false } } } }, "implement")).toBe(
      false,
    );
  });

  it("rejects malformed stage enabled config", () => {
    expect(() => stageEnabled({ ai: { stages: [] } }, "implement")).toThrow(
      "ai.stages must be an object",
    );
    expect(() => stageEnabled({ ai: { stages: { implement: false } } }, "implement")).toThrow(
      "ai.stages.implement must be an object",
    );
    expect(() =>
      stageEnabled({ ai: { stages: { implement: { enabled: "false" } } } }, "implement"),
    ).toThrow("ai.stages.implement.enabled must be a boolean");
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
`),
    ).toEqual({
      safety: {
        block_write_stages_on_high_risk: true,
        prompt_injection_gate: true,
        remove_approval_on_block: false,
      },
    });
  });
});
