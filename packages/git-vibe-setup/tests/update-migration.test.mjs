import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupCli } from "../src/cli.ts";
import { migrateGitVibeConfigContent } from "../src/install.ts";
import { cleanupTemporaryDirectories, fetchGitHubOk, release, workspace } from "./helpers.mjs";

afterEach(cleanupTemporaryDirectories);

describe("git-vibe-setup update migrations", () => {
  it("migrates legacy PAT config while preserving project config", async () => {
    const cwd = workspace();

    mkdirSync(join(cwd, ".github"), { recursive: true });
    writeFileSync(
      join(cwd, ".github", "git-vibe.yml"),
      [
        "version: 1",
        "custom: true",
        "event_delivery:",
        "  # webhook: repository webhook points at the self-hosted GitVibe server.",
        "  # relay: webhook proxy/tunnel such as Smee, Hookdeck, Cloudflare Tunnel, or ngrok.",
        "  # actions: no-server receiver workflows in the consumer repository.",
        "  # polling: local/scheduled worker polls GitHub APIs with cursors/ETags.",
        "  mode: webhook",
        "github_auth:",
        "  # Self-hosted default: the GitVibe server uses a fine-grained PAT scoped to this repository.",
        "  mode: webhook-pat",
        "  token_secret: GITVIBE_GITHUB_TOKEN",
        "ai:",
        "  stages:",
        "    validate:",
        "      enabled: false",
        "",
      ].join("\n"),
    );

    const exitCode = await setupCli({
      argv: ["update"],
      cwd,
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });

    const config = readFileSync(join(cwd, ".github", "git-vibe.yml"), "utf8");
    expect(exitCode).toBe(0);
    expect(config).toContain("custom: true");
    expect(config).toContain("github_auth:\n  mode: github-app\n");
    expect(config).toContain("safety:\n  prompt_injection_gate: true");
    expect(config).toContain("enabled: false");
    expect(config).toContain("Hosted GitHub App installs configure webhooks centrally");
    expect(config).not.toContain("webhook-pat");
    expect(config).not.toContain("GITVIBE_GITHUB_TOKEN");
    expect(config).not.toContain("repository webhook points at the self-hosted GitVibe server");
  });

  it("preserves target runner settings while repairing wrapper auth contracts", async () => {
    const cwd = workspace();

    mkdirSync(join(cwd, ".github", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".github", "git-vibe.yml"), "version: 1\n");
    writeFileSync(
      join(cwd, ".github", "workflows", "validate.yml"),
      [
        "name: GitVibe validate",
        "jobs:",
        "  validate:",
        "    permissions:",
        "      contents: read",
        "      issues: write",
        "    uses: markhuangai/git-vibe/.github/workflows/validate.yml@v3.3.0",
        "    with:",
        "      issue-number: ${{ inputs.issue-number }}",
        "      runner: docker-runner",
        "      timeout_minutes: 60",
        "      max_turns: 90",
        "    secrets:",
        "      GITVIBE_GITHUB_TOKEN: ${{ secrets.GITVIBE_GITHUB_TOKEN }}",
        "      GITVIBE_AI_ENV_JSON: ${{ secrets.GITVIBE_AI_ENV_JSON }}",
        "",
      ].join("\n"),
    );

    const exitCode = await setupCli({
      argv: ["update"],
      cwd,
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });

    const validateWorkflow = readFileSync(
      join(cwd, ".github", "workflows", "validate.yml"),
      "utf8",
    );
    expect(exitCode).toBe(0);
    expect(validateWorkflow).toContain("      id-token: write");
    expect(validateWorkflow).toContain("      runner: docker-runner");
    expect(validateWorkflow).toContain("@v1.2.3");
    expect(validateWorkflow).not.toContain("GITVIBE_GITHUB_TOKEN");
  });
});

describe("git-vibe-setup CLI AI profile migrations", () => {
  it("migrates legacy CLI adapter names to SDK adapter names", async () => {
    const cwd = workspace();

    mkdirSync(join(cwd, ".github"), { recursive: true });
    writeFileSync(
      join(cwd, ".github", "git-vibe.yml"),
      [
        "version: 1",
        "ai:",
        "  profiles:",
        "    old_claude:",
        "      adapter: cli-claude-code",
        "      env:",
        "        ANTHROPIC_API_KEY:",
        "          from_bundle: GITVIBE_AI_API_KEY",
        "    old_codex:",
        "      adapter: cli-codex",
        "      model: gpt-5-codex",
        "  stages:",
        "    validate:",
        "      profile: old_claude",
        "",
      ].join("\n"),
    );

    const exitCode = await setupCli({
      argv: ["update"],
      cwd,
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });

    const config = readFileSync(join(cwd, ".github", "git-vibe.yml"), "utf8");
    expect(exitCode).toBe(0);
    expect(config).toContain("old_claude:\n      adapter: claude-code-sdk");
    expect(config).toContain("model: opus");
    expect(config).toContain("old_codex:\n      adapter: codex-sdk");
    expect(config).toContain("model: gpt-5-codex");
    expect(config).not.toContain("cli-claude-code");
    expect(config).not.toContain("cli-codex");
  });
});

describe("git-vibe-setup agentool AI profile migrations", () => {
  it("migrates legacy agentool profiles to Claude Code SDK profiles", async () => {
    const cwd = workspace();

    mkdirSync(join(cwd, ".github"), { recursive: true });
    writeFileSync(
      join(cwd, ".github", "git-vibe.yml"),
      [
        "version: 1",
        "ai:",
        "  profiles:",
        "    local_proxy:",
        "      adapter: ai-sdk-agentool",
        "      context_window_tokens: 200000",
        "      provider:",
        "        type: openai-compatible",
        "        model: kimi-k2.5",
        "        base_url:",
        "          from_bundle: GITVIBE_AI_BASE_URL",
        "        api_key:",
        "          from_bundle: GITVIBE_AI_API_KEY",
        "      reasoning:",
        "        effort: high",
        "      provider_options:",
        "        openai:",
        "          reasoningEffort: high",
        "          reasoningSummary: concise",
        "        anthropic:",
        "          effort: high",
        "  stages:",
        "    validate:",
        "      profile: local_proxy",
        "",
      ].join("\n"),
    );

    const exitCode = await setupCli({
      argv: ["update"],
      cwd,
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });

    const config = readFileSync(join(cwd, ".github", "git-vibe.yml"), "utf8");
    expect(exitCode).toBe(0);
    expect(config).toContain("local_proxy:\n      adapter: claude-code-sdk");
    expect(config).toContain("ANTHROPIC_API_KEY:\n          from_bundle: GITVIBE_AI_API_KEY");
    expect(config).toContain("ANTHROPIC_BASE_URL:\n          from_bundle: GITVIBE_AI_BASE_URL");
    expect(config).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL: kimi-k2.5");
    expect(config).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL: kimi-k2.5");
    expect(config).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL: kimi-k2.5");
    expect(config).toContain("ANTHROPIC_MODEL: opus");
    expect(config).toContain("CLAUDE_CODE_SUBAGENT_MODEL: opus");
    expect(config).toContain("model: opus");
    expect(config).toContain("reasoning:\n        effort: high");
    expect(config).toContain("provider_options:\n        anthropic:\n          effort: high");
    expect(config).not.toContain("ai-sdk-agentool");
    expect(config).not.toContain("context_window_tokens");
    expect(config).not.toContain("provider:\n        type: openai-compatible");
    expect(config).not.toContain("openai:");
    expect(config).not.toContain("reasoningEffort");
  });
});

describe("git-vibe-setup AI migration edge cases", () => {
  it("rejects invalid YAML instead of partially migrating config", () => {
    expect(() => migrateGitVibeConfigContent("version: [\n")).toThrow(
      "git-vibe-setup could not migrate .github/git-vibe.yml because it is not valid YAML",
    );
  });

  it("leaves non-legacy AI profile shapes unchanged", () => {
    const config = migrateGitVibeConfigContent(
      [
        "version: 1",
        "ai:",
        "  profiles:",
        "    scalar_profile: true",
        "    numeric_adapter:",
        "      adapter: 7",
        "    custom:",
        "      adapter: custom-sdk",
        "",
      ].join("\n"),
    );

    expect(config).toContain("scalar_profile: true");
    expect(config).toContain("adapter: 7");
    expect(config).toContain("adapter: custom-sdk");
    expect(config).toContain("safety:\n  prompt_injection_gate: true");
    expect(config).not.toContain("claude-code-sdk");
    expect(config).not.toContain("codex-sdk");
  });

  it("preserves explicit prompt-injection safety config", () => {
    const config = migrateGitVibeConfigContent(
      [
        "version: 1",
        "safety:",
        "  prompt_injection_gate: false",
        "github_auth:",
        "  mode: github-app",
        "",
      ].join("\n"),
    );

    expect(config).toContain("safety:\n  prompt_injection_gate: false");
    expect(config).not.toContain("prompt_injection_gate: true");
  });

  it("preserves existing Claude env values while filling missing agentool env keys", () => {
    const config = migrateGitVibeConfigContent(
      [
        "version: 1",
        "ai:",
        "  profiles:",
        "    local_proxy:",
        "      adapter: ai-sdk-agentool",
        "      env:",
        "        ANTHROPIC_MODEL: sonnet",
        "      provider:",
        "        api_key: literal-token",
        "",
      ].join("\n"),
    );

    expect(config).toContain("adapter: claude-code-sdk");
    expect(config).toContain("ANTHROPIC_MODEL: sonnet");
    expect(config).toContain("ANTHROPIC_API_KEY: literal-token");
    expect(config).toContain("CLAUDE_CODE_SUBAGENT_MODEL: opus");
    expect(config).toContain("model: opus");
  });
});

describe("git-vibe-setup partial agentool migrations", () => {
  it("handles missing providers, provider option effort, and existing env keys", () => {
    const config = migrateGitVibeConfigContent(
      [
        "version: 1",
        "ai:",
        "  profiles:",
        "    no_provider_map:",
        "      adapter: ai-sdk-agentool",
        "      provider: disabled",
        "      custom_setting: true",
        "    provider_options_effort:",
        "      adapter: ai-sdk-agentool",
        "      provider_options:",
        "        anthropic:",
        "          effort: max",
        "    openai_options_only:",
        "      adapter: ai-sdk-agentool",
        "      provider_options:",
        "        openai:",
        "          reasoningEffort: high",
        "    existing_env:",
        "      adapter: ai-sdk-agentool",
        "      env:",
        "        ANTHROPIC_API_KEY: existing-token",
        "      provider:",
        "        api_key: replacement-token",
        "ai_disabled: false",
        "",
      ].join("\n"),
    );

    expect(config).toContain("no_provider_map:\n      adapter: claude-code-sdk");
    expect(config).toContain("custom_setting: true");
    expect(config).toContain("provider_options_effort:\n      adapter: claude-code-sdk");
    expect(config).toContain("reasoning:\n        effort: max");
    expect(config).not.toContain("provider: disabled");
    expect(config).not.toContain("openai:");
    expect(config).toContain("ANTHROPIC_API_KEY: existing-token");
    expect(config).not.toContain("replacement-token");
  });

  it("leaves configs without AI profile maps unchanged beyond auth migration", () => {
    const scalarAi = migrateGitVibeConfigContent(["version: 1", "ai: false", ""].join("\n"));
    const scalarProfiles = migrateGitVibeConfigContent(
      ["version: 1", "ai:", "  profiles: false", ""].join("\n"),
    );

    expect(scalarAi).toContain("ai: false");
    expect(scalarAi).toContain("github_auth:\n  mode: github-app");
    expect(scalarProfiles).toContain("profiles: false");
    expect(scalarProfiles).not.toContain("claude-code-sdk");
  });
});

describe("git-vibe-setup obsolete workflow cleanup", () => {
  it("removes obsolete managed workflow wrappers during update", async () => {
    const cwd = workspace();
    const workflows = join(cwd, ".github", "workflows");
    const staleWorkflows = ["stale-writer.yml", "stale-review.yml"].map((name) =>
      join(workflows, name),
    );

    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(cwd, ".github", "git-vibe.yml"), "version: 1\n");
    for (const staleWorkflow of staleWorkflows) {
      writeFileSync(staleWorkflow, obsoleteManagedWorkflow(staleWorkflow));
    }

    const exitCode = await setupCli({
      argv: ["update"],
      cwd,
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(staleWorkflows.every((staleWorkflow) => !existsSync(staleWorkflow))).toBe(true);
  });

  it("preserves obsolete workflow files that are not managed GitVibe wrappers", async () => {
    const cwd = workspace();
    const workflows = join(cwd, ".github", "workflows");
    const staleWorkflow = join(workflows, "stale-local.yml");
    const localWorkflow = [
      "name: Local stale workflow",
      "on:",
      "  workflow_dispatch:",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo local",
      "",
    ].join("\n");

    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(cwd, ".github", "git-vibe.yml"), "version: 1\n");
    writeFileSync(staleWorkflow, localWorkflow);

    const exitCode = await setupCli({
      argv: ["update"],
      cwd,
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(staleWorkflow, "utf8")).toBe(localWorkflow);
  });

  it("preserves customized obsolete GitVibe wrappers without an ownership marker", async () => {
    const cwd = workspace();
    const workflows = join(cwd, ".github", "workflows");
    const staleWorkflow = join(workflows, "stale-writer.yml");
    /** @type {string[]} */
    const logs = [];
    const customizedWorkflow = [
      "name: Custom stale writer",
      "jobs:",
      "  stale-writer:",
      "    uses: markhuangai/git-vibe/.github/workflows/stale-writer.yml@v3.3.0",
      "    with:",
      "      runner: self-hosted",
      "",
    ].join("\n");

    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(cwd, ".github", "git-vibe.yml"), "version: 1\n");
    writeFileSync(staleWorkflow, customizedWorkflow);

    const exitCode = await setupCli({
      argv: ["update"],
      cwd,
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: (message) => logs.push(message),
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(staleWorkflow, "utf8")).toBe(customizedWorkflow);
    expect(logs.join("\n")).toContain("Obsolete workflow files were left in place");
    expect(logs.join("\n")).toContain(".github/workflows/stale-writer.yml");
  });
});

/** @param {string} workflowPath */
function obsoleteManagedWorkflow(workflowPath) {
  const workflowName = workflowPath.split(/[\\/]/).at(-1) || "stale.yml";
  return [
    "# GitVibe managed workflow wrapper",
    `name: GitVibe ${workflowName}`,
    "jobs:",
    "  git-vibe:",
    `    uses: markhuangai/git-vibe/.github/workflows/${workflowName}@v3.3.0`,
    "",
  ].join("\n");
}
