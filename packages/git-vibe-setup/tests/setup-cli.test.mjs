import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDirectRun, runSetup, setupCli } from "../src/cli.ts";
import {
  existingFilesError,
  installFiles,
  pinWorkflowReleaseRefs,
  unmanagedWorkflowUpdatePaths,
  updateFiles,
} from "../src/install.ts";
import {
  cleanupTemporaryDirectories,
  contentRequestRefs,
  fetchGitHubOk,
  fetchOk,
  release,
  repositoryRoot,
  requestUrl,
  workspace,
  workflowFile,
  workflowNames,
  workspaceRoot,
} from "./helpers.mjs";

afterEach(cleanupTemporaryDirectories);

describe("git-vibe-setup", () => {
  it("exposes the setup executable without shipping starter templates", () => {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));

    expect(packageJson.name).toBe("git-vibe-setup");
    expect(packageJson.bin["git-vibe-setup"]).toBe("dist/cli.js");
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "README.md"]));
    expect(packageJson.files).not.toContain("templates");
  });
});

describe("git-vibe-setup installation", () => {
  it("installs the consumer starter, including role prompts, and pins workflow refs", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const logs = [];

    await runSetup({
      cwd,
      fetchImpl: fetchGitHubOk([
        release({ draft: true, published_at: "2026-05-15T00:00:00Z", tag_name: "v9.9.9" }),
        release({
          prerelease: true,
          published_at: "2026-05-14T00:00:00Z",
          tag_name: "v2.0.0-rc1",
        }),
        release({ published_at: "2026-05-13T00:00:00Z", tag_name: "v1.2.3" }),
      ]),
      log: (message) => logs.push(message),
    });

    expect(readFileSync(join(cwd, ".github", "git-vibe.yml"), "utf8")).toContain("version: 1");
    expect(existsSync(join(cwd, ".git-vibe", "role-group", "correctness.md"))).toBe(true);

    const installedWorkflows = workflowNames(join(cwd, ".github"));
    const exampleWorkflows = workflowNames(join(workspaceRoot, "examples", "consumer", ".github"));
    expect(installedWorkflows).toEqual(exampleWorkflows);
    expect(installedWorkflows).not.toContain("decompose.yml");

    for (const name of installedWorkflows) {
      const workflow = readFileSync(join(cwd, ".github", "workflows", name), "utf8");
      expect(workflow).toContain("@v1.2.3");
      expect(workflow).not.toContain("@main");
    }
  });

  it("keeps consumer workflows as concrete starter files", () => {
    const exampleDirectory = join(workspaceRoot, "examples", "consumer", ".github");
    const names = workflowNames(exampleDirectory);

    for (const name of names) {
      const examplePath = join(exampleDirectory, "workflows", name);
      expect(lstatSync(examplePath).isFile()).toBe(true);
      expect(lstatSync(examplePath).isSymbolicLink()).toBe(false);
    }
  });

  it("prints the manual secret and variable instructions after installation", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const logs = [];

    await runSetup({
      cwd,
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: (message) => logs.push(message),
    });

    expect(logs[0]).toContain("GITVIBE_AI_ENV_JSON");
    expect(logs[0]).toContain("GITVIBE_GITHUB_TOKEN");
    expect(logs[0]).toContain("WEBHOOK_SECRET");
    expect(logs[0]).toContain("GITVIBE_BASE_BRANCH");
    expect(logs[0]).toContain("/blob/v1.2.3/examples/consumer/GITVIBE_AI_ENV_JSON.example.json");
  });

  it("installs from an exact prerelease tag without latest-release lookup", async () => {
    const cwd = workspace();
    const fetchImpl = vi.fn(fetchGitHubOk([]));

    const exitCode = await setupCli({
      argv: ["setup", "--release", "v1.2.3-rc.1"],
      cwd,
      fetchImpl,
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(
      fetchImpl.mock.calls.some(([input]) => requestUrl(input).pathname.endsWith("/releases")),
    ).toBe(false);
    expect(contentRequestRefs(fetchImpl)).toEqual(["v1.2.3-rc.1"]);
    expect(readFileSync(join(cwd, ".github", "workflows", "validate.yml"), "utf8")).toContain(
      "@v1.2.3-rc.1",
    );
  });
});

describe("git-vibe-setup workflow updates", () => {
  it("updates workflow wrappers without touching config or role prompts", async () => {
    const cwd = workspace();

    await runSetup({
      cwd,
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.2" })]),
      log: () => undefined,
    });
    writeFileSync(join(cwd, ".github", "git-vibe.yml"), "version: 1\ncustom: true\n");
    writeFileSync(join(cwd, ".git-vibe", "role-group", "correctness.md"), "custom role\n");

    const exitCode = await setupCli({
      argv: ["update"],
      cwd,
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(join(cwd, ".github", "git-vibe.yml"), "utf8")).toBe(
      "version: 1\ncustom: true\n",
    );
    expect(readFileSync(join(cwd, ".git-vibe", "role-group", "correctness.md"), "utf8")).toBe(
      "custom role\n",
    );
    for (const name of workflowNames(join(cwd, ".github"))) {
      const workflow = readFileSync(join(cwd, ".github", "workflows", name), "utf8");
      expect(workflow).toContain("@v1.2.3");
      expect(workflow).not.toContain("@v1.2.2");
    }
  });
});

describe("git-vibe-setup prerelease workflow updates", () => {
  it("updates workflow wrappers from the latest prerelease when explicitly included", async () => {
    const cwd = workspace();

    const exitCode = await setupCli({
      argv: ["update", "--include-prereleases"],
      cwd,
      fetchImpl: fetchGitHubOk([
        release({ published_at: "2026-05-14T00:00:00Z", tag_name: "v1.2.3" }),
        release({
          prerelease: true,
          published_at: "2026-05-15T00:00:00Z",
          tag_name: "v1.2.4-rc.1",
        }),
      ]),
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(join(cwd, ".github", "workflows", "validate.yml"), "utf8")).toContain(
      "@v1.2.4-rc.1",
    );
  });

  it("updates workflow wrappers from an exact prerelease tag", async () => {
    const cwd = workspace();

    const exitCode = await setupCli({
      argv: ["update", "--release=v1.2.4-rc.2"],
      cwd,
      fetchImpl: fetchGitHubOk([]),
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(join(cwd, ".github", "workflows", "validate.yml"), "utf8")).toContain(
      "@v1.2.4-rc.2",
    );
  });

  it("repairs old workflow wrapper contracts and creates missing wrappers", async () => {
    const cwd = workspace();

    mkdirSync(join(cwd, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(cwd, ".github", "workflows", "validate.yml"),
      [
        "name: GitVibe validate",
        "on:",
        "  workflow_dispatch:",
        "    inputs:",
        "      issue-number:",
        "        type: string",
        "jobs:",
        "  validate:",
        "    uses: markhuangai/git-vibe/.github/workflows/validate.yml@v3.0.2",
        "    with:",
        "      issue-number: ${{ inputs.issue-number }}",
        "      timeout_minutes: 60",
        "      max_turns: 90",
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
    expect(workflowNames(join(cwd, ".github"))).toEqual(
      workflowNames(join(workspaceRoot, "examples", "consumer", ".github")),
    );
    expect(validateWorkflow).toContain("timeout_minutes:");
    expect(validateWorkflow).toContain(
      "timeout_minutes: ${{ fromJSON(github.event.inputs.timeout_minutes) }}",
    );
    expect(validateWorkflow).toContain("@v1.2.3");
  });
});

describe("git-vibe-setup workflow update safety", () => {
  it("refuses to overwrite workflow files that are not GitVibe wrappers", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const errors = [];

    mkdirSync(join(cwd, ".github", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".github", "workflows", "validate.yml"), "name: Custom validate\n");

    const exitCode = await setupCli({
      argv: ["update"],
      cwd,
      error: (message) => errors.push(message),
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("do not look like GitVibe wrappers");
    expect(readFileSync(join(cwd, ".github", "workflows", "validate.yml"), "utf8")).toBe(
      "name: Custom validate\n",
    );
    expect(existsSync(join(cwd, ".github", "workflows", "develop.yml"))).toBe(false);
  });

  it("fails without writing when the release starter is missing a workflow wrapper", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const errors = [];

    const exitCode = await setupCli({
      argv: ["update"],
      cwd,
      error: (message) => errors.push(message),
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })], {
        missingPaths: [".github/workflows/validate.yml"],
      }),
      log: () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("incomplete GitVibe consumer starter");
    expect(errors[0]).toContain("examples/consumer/.github/workflows/validate.yml");
    expect(existsSync(join(cwd, ".github"))).toBe(false);
  });

  it("rolls back workflow updates when a later write fails", () => {
    const cwd = workspace();
    const existing = join(cwd, ".github", "workflows", "validate.yml");
    const created = join(cwd, ".github", "workflows", "review.yml");
    const blocked = join(cwd, ".github", "workflows", "blocked.yml");

    mkdirSync(join(cwd, ".github", "workflows"), { recursive: true });
    writeFileSync(existing, "existing\n");
    mkdirSync(blocked);

    expect(unmanagedWorkflowUpdatePaths([workflowFile(blocked, "blocked.yml")])).toEqual([blocked]);
    expect(() =>
      updateFiles([
        { content: "updated\n", sourcePath: "source", targetPath: existing },
        { content: "created\n", sourcePath: "source", targetPath: created },
        { content: "blocked\n", sourcePath: "source", targetPath: blocked },
      ]),
    ).toThrow();
    expect(readFileSync(existing, "utf8")).toBe("existing\n");
    expect(existsSync(created)).toBe(false);
    expect(existsSync(blocked)).toBe(true);
  });
});

describe("git-vibe-setup CLI execution", () => {
  it("runs setup explicitly and resolves the release consumer starter by default", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const logs = [];

    const exitCode = await setupCli({
      argv: ["setup"],
      cwd,
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: (message) => logs.push(message),
    });

    expect(exitCode).toBe(0);
    expect(existsSync(join(cwd, ".github", "git-vibe.yml"))).toBe(true);
    expect(logs[0]).toContain("GitVibe starter files installed");
  });

  it("keeps no-argument setup as a compatibility alias", async () => {
    const cwd = workspace();

    const exitCode = await setupCli({
      argv: [],
      cwd,
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(existsSync(join(cwd, ".github", "git-vibe.yml"))).toBe(true);
  });
});

describe("git-vibe-setup CLI options", () => {
  it("prints help without writing files", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const logs = [];

    const exitCode = await setupCli({
      argv: ["--help"],
      cwd,
      fetchImpl: fetchOk([release({ tag_name: "v1.2.3" })]),
      log: (message) => logs.push(message),
    });

    expect(exitCode).toBe(0);
    expect(logs[0]).toContain("git-vibe-setup setup");
    expect(logs[0]).toContain("--release <tag>");
    expect(existsSync(join(cwd, ".github"))).toBe(false);
  });

  it("prints command help without writing files", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const logs = [];

    const exitCode = await setupCli({
      argv: ["update", "--help"],
      cwd,
      fetchImpl: fetchOk([release({ tag_name: "v1.2.3" })]),
      log: (message) => logs.push(message),
    });

    expect(exitCode).toBe(0);
    expect(logs[0]).toContain("git-vibe-setup update");
    expect(existsSync(join(cwd, ".github"))).toBe(false);
  });

  it("reports unknown commands without writing files", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const errors = [];

    const exitCode = await setupCli({
      argv: ["install"],
      cwd,
      error: (message) => errors.push(message),
      fetchImpl: fetchOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Unknown command: install");
    expect(errors[0]).toContain("git-vibe-setup update");
    expect(existsSync(join(cwd, ".github"))).toBe(false);
  });

  it("reports invalid release options without writing files", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const errors = [];

    const invalidTagExitCode = await setupCli({
      argv: ["update", "--release", "main"],
      cwd,
      error: (message) => errors.push(message),
      fetchImpl: fetchOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });
    const missingTagExitCode = await setupCli({
      argv: ["update", "--release"],
      cwd,
      error: (message) => errors.push(message),
      fetchImpl: fetchOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });

    expect(invalidTagExitCode).toBe(1);
    expect(missingTagExitCode).toBe(1);
    expect(errors[0]).toContain("Invalid release tag");
    expect(errors[1]).toContain("--release requires a release tag");
    expect(existsSync(join(cwd, ".github"))).toBe(false);
  });
});

describe("git-vibe-setup direct execution", () => {
  it("recognizes npm bin symlinks as direct CLI execution", () => {
    const cwd = workspace();
    const target = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const entrypoint = join(cwd, "git-vibe-setup");

    symlinkSync(target, entrypoint);

    expect(isDirectRun(pathToFileURL(target).href, entrypoint)).toBe(true);
    expect(isDirectRun(pathToFileURL(target).href, "")).toBe(false);
  });
});

describe("git-vibe-setup CLI process defaults", () => {
  it("falls back to process defaults for cwd, fetch, and console logging", async () => {
    const cwd = workspace();
    const originalCwd = process.cwd();
    const originalFetch = globalThis.fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    globalThis.fetch = fetchGitHubOk([release({ tag_name: "v1.2.3" })]);
    process.chdir(cwd);

    try {
      await expect(setupCli()).resolves.toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("GitVibe starter files installed"));
    } finally {
      process.chdir(originalCwd);
      globalThis.fetch = originalFetch;
      log.mockRestore();
    }
  });

  it("runs update with process defaults for cwd, fetch, and console logging", async () => {
    const cwd = workspace();
    const originalCwd = process.cwd();
    const originalFetch = globalThis.fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    globalThis.fetch = fetchGitHubOk([release({ tag_name: "v1.2.3" })]);
    process.chdir(cwd);

    try {
      await expect(setupCli({ argv: ["update"] })).resolves.toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("workflow files updated"));
      expect(workflowNames(join(cwd, ".github"))).toEqual(
        workflowNames(join(workspaceRoot, "examples", "consumer", ".github")),
      );
    } finally {
      process.chdir(originalCwd);
      globalThis.fetch = originalFetch;
      log.mockRestore();
    }
  });
});

describe("git-vibe-setup failures", () => {
  it("falls back to console.error when the CLI wrapper reports failures", async () => {
    const cwd = workspace();
    const originalCwd = process.cwd();
    const originalFetch = globalThis.fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    globalThis.fetch = async () => new globalThis.Response("", { status: 503 });
    process.chdir(cwd);

    try {
      await expect(setupCli()).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("service is unavailable"));
    } finally {
      process.chdir(originalCwd);
      globalThis.fetch = originalFetch;
      error.mockRestore();
    }
  });

  it("falls back to console.error when update release lookup fails", async () => {
    const cwd = workspace();
    const originalCwd = process.cwd();
    const originalFetch = globalThis.fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    globalThis.fetch = async () => new globalThis.Response("", { status: 503 });
    process.chdir(cwd);

    try {
      await expect(setupCli({ argv: ["update"] })).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("service is unavailable"));
    } finally {
      process.chdir(originalCwd);
      globalThis.fetch = originalFetch;
      error.mockRestore();
    }
  });
});

describe("git-vibe-setup setup failures", () => {
  it("fails without writing when any target file already exists", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const errors = [];

    mkdirSync(join(cwd, ".github", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".github", "workflows", "develop.yml"), "existing");

    const exitCode = await setupCli({
      cwd,
      error: (message) => errors.push(message),
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain(".github/workflows/develop.yml");
    expect(existsSync(join(cwd, ".github", "git-vibe.yml"))).toBe(false);
    expect(existsSync(join(cwd, ".git-vibe"))).toBe(false);
  });

  it("fails without writing when the latest release lookup is unavailable", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const errors = [];

    const exitCode = await setupCli({
      cwd,
      error: (message) => errors.push(message),
      fetchImpl: async () => new globalThis.Response("", { status: 503 }),
      log: () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("could not check the latest GitVibe update");
    expect(errors[0]).toContain("service is unavailable");
    expect(existsSync(join(cwd, ".github"))).toBe(false);
  });

  it("fails without writing when the consumer starter cannot be fetched", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const errors = [];

    const exitCode = await setupCli({
      cwd,
      error: (message) => errors.push(message),
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })], { failConsumerFetch: true }),
      log: () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("could not fetch the GitVibe consumer starter");
    expect(existsSync(join(cwd, ".github"))).toBe(false);
  });

  it("fails without writing when the release starter is missing a setup file", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const errors = [];

    const exitCode = await setupCli({
      cwd,
      error: (message) => errors.push(message),
      fetchImpl: fetchGitHubOk([release({ tag_name: "v1.2.3" })], {
        missingPaths: [".git-vibe/role-group/security.md"],
      }),
      log: () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("incomplete GitVibe consumer starter");
    expect(errors[0]).toContain("examples/consumer/.git-vibe/role-group/security.md");
    expect(existsSync(join(cwd, ".github"))).toBe(false);
  });

  it("fails without writing when no stable release exists", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const errors = [];

    const exitCode = await setupCli({
      cwd,
      error: (message) => errors.push(message),
      fetchImpl: fetchOk([
        release({ draft: true, tag_name: "v2.0.0" }),
        release({ prerelease: true, tag_name: "v2.0.0-rc1" }),
      ]),
      log: () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("no stable release is available");
    expect(existsSync(join(cwd, ".github"))).toBe(false);
  });
});

describe("installation rollback", () => {
  it("removes created files when a later write fails", () => {
    const cwd = workspace();
    const target = join(cwd, ".github", "git-vibe.yml");

    mkdirSync(join(cwd, ".github"), { recursive: true });
    writeFileSync(target, "existing");

    expect(() =>
      installFiles([
        {
          content: "first",
          sourcePath: "first",
          targetPath: join(cwd, ".git-vibe", "role-group", "correctness.md"),
        },
        {
          content: "second",
          sourcePath: "second",
          targetPath: target,
        },
      ]),
    ).toThrow();

    expect(existsSync(join(cwd, ".git-vibe", "role-group", "correctness.md"))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("existing");
  });

  it("reports absolute paths when relative rendering is empty", () => {
    expect(existingFilesError([repositoryRoot], repositoryRoot).message).toContain(repositoryRoot);
  });
});

describe("workflow ref pinning", () => {
  it("preserves dollar sequences in the release tag", () => {
    const pinned = pinWorkflowReleaseRefs(
      "uses: markhuangai/git-vibe/.github/workflows/develop.yml@v1\n",
      "release-$1-${tag}",
    );

    expect(pinned).toContain(
      "uses: markhuangai/git-vibe/.github/workflows/develop.yml@release-$1-${tag}",
    );
  });
});
