import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupCli } from "../src/cli.ts";
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
        "    implement:",
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
