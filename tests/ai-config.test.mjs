import { describe, expect, it } from "vitest";
import {
  activeProfileByName,
  adapterName,
  profileNamesForStage,
  stageConfigFor,
} from "../src/runner/ai-config.ts";

describe("AI config profile resolution", () => {
  it("requires configured object profiles and explicit adapters", () => {
    expect(() => activeProfileByName({}, "test")).toThrow("ai.profiles must be an object.");
    expect(() => activeProfileByName({ ai: { profiles: {} } }, "test")).toThrow(
      "ai.profiles.test must be configured.",
    );
    expect(() => activeProfileByName({ ai: { profiles: { test: [] } } }, "test")).toThrow(
      "ai.profiles.test must be an object.",
    );
    expect(adapterName({ adapter: "codex-sdk" }, "ai.profiles.test")).toBe("codex-sdk");
    expect(() => adapterName({}, "ai.profiles.test")).toThrow(
      "ai.profiles.test.adapter must be configured.",
    );
  });

  it("resolves stage profiles and removed stage shapes", () => {
    expect(profileNamesForStage(stageConfig({ profile: "primary" }), "validate")).toEqual([
      "primary",
    ]);
    expect(() => profileNamesForStage(stageConfig({ profiles: ["primary"] }), "validate")).toThrow(
      "ai.stages.validate.profiles is no longer supported",
    );
    expect(() =>
      profileNamesForStage(
        stageConfig({ fallback_profile: "fallback", profile: "primary" }),
        "validate",
      ),
    ).toThrow("ai.stages.validate.fallback_profile is no longer supported");
    expect(() =>
      profileNamesForStage(stageConfig({ role_group: "review_gate" }), "validate"),
    ).toThrow("ai.stages.validate.role_group requires matrix workflow execution.");
    expect(() => profileNamesForStage(stageConfig({}), "validate")).toThrow(
      "ai.stages.validate must define profile or role_group.",
    );
  });

  it("validates stage config containers", () => {
    expect(stageConfigFor({}, "validate")).toEqual({});
    expect(stageConfigFor({ ai: { stages: {} } }, "validate")).toEqual({});
    expect(stageConfigFor(stageConfig({ profile: "test" }), "validate")).toEqual({
      profile: "test",
    });
    expect(() => stageConfigFor({ ai: { stages: [] } }, "validate")).toThrow(
      "ai.stages must be an object.",
    );
    expect(() => stageConfigFor({ ai: { stages: { validate: [] } } }, "validate")).toThrow(
      "ai.stages.validate must be an object.",
    );
  });
});

/** @param {Record<string, unknown>} validate */
function stageConfig(validate) {
  return { ai: { stages: { validate } } };
}
