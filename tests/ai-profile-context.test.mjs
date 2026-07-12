// @ts-nocheck
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAiStage } from "../src/runner/ai.ts";
import { stageDefinitions } from "../src/shared/stages.ts";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      CODEX_BASE_URL: "https://codex-proxy.example/v1",
      GITVIBE_AI_API_KEY: "test-key",
    }),
  };
});

afterEach(() => {
  globalThis.__gitVibeSdkMocks.resetSdkMocks();
  process.env = { ...originalEnv };
});

describe("AI profile context routing", () => {
  it("adds context files configured on the active SDK profile to the prompt", async () => {
    const cwd = contextWorkspace({ "PROFILE.md": "Use profile-specific repository guidance." });
    const config = stageRoutingConfig();
    config.ai.profiles.validation_profile.context = { files: ["PROFILE.md"] };
    globalThis.__gitVibeSdkMocks.queueCodexOutput({ stage: "validate", status: "completed" });

    try {
      await expect(
        runAiStage({
          ...validateStageOptions(config),
          cwd,
        }),
      ).resolves.toBe('{"stage":"validate","status":"completed"}');

      const prompt = globalThis.__gitVibeSdkMocks.codexRun.mock.calls[0][0];
      expect(prompt).toContain(
        '<git_vibe_profile_context profile="validation_profile" path="PROFILE.md">',
      );
      expect(prompt).toContain("Use profile-specific repository guidance.");
      expect(prompt).toContain("Prompt");
    } finally {
      cleanupWorkspace(cwd);
    }
  });

  it("uses context files from an explicit profile override", async () => {
    const cwd = contextWorkspace({ "MATRIX.md": "Use matrix member guidance." });
    const config = stageRoutingConfig();
    config.ai.profiles.matrix_profile = {
      api_key: { from_bundle: "GITVIBE_AI_API_KEY" },
      adapter: "codex-sdk",
      base_url: { from_bundle: "CODEX_BASE_URL" },
      context: { files: ["MATRIX.md"] },
      model: "matrix-model",
    };
    globalThis.__gitVibeSdkMocks.queueCodexOutput({ stage: "validate", status: "completed" });

    try {
      await expect(
        runAiStage({
          ...validateStageOptions(config),
          cwd,
          profileName: "matrix_profile",
        }),
      ).resolves.toBe('{"stage":"validate","status":"completed"}');

      const prompt = globalThis.__gitVibeSdkMocks.codexRun.mock.calls[0][0];
      expect(prompt).toContain(
        '<git_vibe_profile_context profile="matrix_profile" path="MATRIX.md">',
      );
      expect(prompt).toContain("Use matrix member guidance.");
    } finally {
      cleanupWorkspace(cwd);
    }
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

function stageRoutingConfig() {
  return {
    ai: {
      profiles: {
        validation_profile: {
          api_key: { from_bundle: "GITVIBE_AI_API_KEY" },
          adapter: "codex-sdk",
          base_url: { from_bundle: "CODEX_BASE_URL" },
          model: "stage-model",
        },
      },
      stages: {
        validate: {
          profile: "validation_profile",
        },
      },
    },
  };
}

function contextWorkspace(files) {
  const cwd = mkdtempSync(join(tmpdir(), "git-vibe-ai-profile-context-"));
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(cwd, path), content);
  }
  return cwd;
}

function cleanupWorkspace(cwd) {
  rmSync(cwd, { force: true, recursive: true });
}
