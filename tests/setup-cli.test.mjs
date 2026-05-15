import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existingFilesError, installFiles } from "../src/setup/install.ts";
import { runSetup, setupCli } from "../src/setup/cli.ts";
import { latestStableReleaseTag, selectLatestStableRelease } from "../src/setup/releases.ts";

const repositoryRoot = process.cwd();
/** @type {string[]} */
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("git-vibe-setup", () => {
  it("exposes the setup executable and ships the consumer starter assets", () => {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));

    expect(packageJson.bin["git-vibe-setup"]).toBe("./dist/setup/cli.js");
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "examples/consumer/.github",
        "examples/consumer/.git-vibe",
        "examples/consumer/GITVIBE_AI_ENV_JSON.example.json",
      ]),
    );
  });
});

describe("git-vibe-setup installation", () => {
  it("installs the consumer starter, including role prompts, and pins workflow refs", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const logs = [];

    await runSetup({
      cwd,
      fetchImpl: fetchOk([
        release({ draft: true, published_at: "2026-05-15T00:00:00Z", tag_name: "v9.9.9" }),
        release({
          prerelease: true,
          published_at: "2026-05-14T00:00:00Z",
          tag_name: "v2.0.0-rc1",
        }),
        release({ published_at: "2026-05-13T00:00:00Z", tag_name: "v1.2.3" }),
      ]),
      log: (message) => logs.push(message),
      repositoryRoot,
    });

    expect(readFileSync(join(cwd, ".github", "git-vibe.yml"), "utf8")).toContain("version: 1");
    expect(existsSync(join(cwd, ".git-vibe", "role-group", "correctness.md"))).toBe(true);

    const installedWorkflows = workflowNames(join(cwd, ".github"));
    const exampleWorkflows = workflowNames(join(repositoryRoot, "examples", "consumer", ".github"));
    expect(installedWorkflows).toEqual(exampleWorkflows);

    for (const name of installedWorkflows) {
      const workflow = readFileSync(join(cwd, ".github", "workflows", name), "utf8");
      expect(workflow).toContain("@v1.2.3");
      expect(workflow).not.toContain("@main");
    }
  });

  it("prints the manual secret and variable instructions after installation", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const logs = [];

    await runSetup({
      cwd,
      fetchImpl: fetchOk([release({ tag_name: "v1.2.3" })]),
      log: (message) => logs.push(message),
      repositoryRoot,
    });

    expect(logs[0]).toContain("GITVIBE_AI_ENV_JSON");
    expect(logs[0]).toContain("GITVIBE_GITHUB_TOKEN");
    expect(logs[0]).toContain("WEBHOOK_SECRET");
    expect(logs[0]).toContain("GITVIBE_BASE_BRANCH");
    expect(logs[0]).toContain("/blob/v1.2.3/examples/consumer/GITVIBE_AI_ENV_JSON.example.json");
  });

  it("returns success from the CLI wrapper and resolves the packaged examples by default", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const logs = [];

    const exitCode = await setupCli({
      cwd,
      fetchImpl: fetchOk([release({ tag_name: "v1.2.3" })]),
      log: (message) => logs.push(message),
    });

    expect(exitCode).toBe(0);
    expect(existsSync(join(cwd, ".github", "git-vibe.yml"))).toBe(true);
    expect(logs[0]).toContain("GitVibe starter files installed");
  });

  it("falls back to process defaults for cwd, fetch, and console logging", async () => {
    const cwd = workspace();
    const originalCwd = process.cwd();
    const originalFetch = globalThis.fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    globalThis.fetch = fetchOk([release({ tag_name: "v1.2.3" })]);
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

  it("fails without writing when any target file already exists", async () => {
    const cwd = workspace();
    /** @type {string[]} */
    const errors = [];

    mkdirSync(join(cwd, ".github", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".github", "workflows", "develop.yml"), "existing");

    const exitCode = await setupCli({
      cwd,
      error: (message) => errors.push(message),
      fetchImpl: fetchOk([release({ tag_name: "v1.2.3" })]),
      log: () => undefined,
      repositoryRoot,
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
      repositoryRoot,
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("could not check the latest GitVibe update");
    expect(errors[0]).toContain("service is unavailable");
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
      repositoryRoot,
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("no stable release is available");
    expect(existsSync(join(cwd, ".github"))).toBe(false);
  });
});

describe("stable release selection", () => {
  it("ignores draft and prerelease releases when choosing the latest stable tag", () => {
    const releaseTag = selectLatestStableRelease([
      release({ draft: true, published_at: "2026-05-17T00:00:00Z", tag_name: "v3.0.0" }),
      release({ prerelease: true, published_at: "2026-05-16T00:00:00Z", tag_name: "v2.0.0-rc1" }),
      release({ published_at: "2026-05-15T00:00:00Z", tag_name: "v1.3.0" }),
      release({ published_at: "2026-05-14T00:00:00Z", tag_name: "v1.2.9" }),
    ])?.tag_name;

    expect(releaseTag).toBe("v1.3.0");
  });

  it("falls back to created_at when published_at is unavailable", () => {
    const releaseTag = selectLatestStableRelease([
      release({ created_at: "2026-05-14T00:00:00Z", published_at: undefined, tag_name: "v1.2.9" }),
      release({ created_at: "2026-05-15T00:00:00Z", published_at: undefined, tag_name: "v1.3.0" }),
    ])?.tag_name;

    expect(releaseTag).toBe("v1.3.0");
  });

  it("checks later release pages before reporting that no stable release exists", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      release({
        draft: index % 2 === 0,
        prerelease: index % 2 === 1,
        published_at: `2026-05-${String(14 - Math.floor(index / 10)).padStart(2, "0")}T00:00:00Z`,
        tag_name: `v9.0.0-${index}`,
      }),
    );
    const fetchImpl = vi.fn(
      fetchPages([
        firstPage,
        [release({ published_at: "2026-05-01T00:00:00Z", tag_name: "v1.2.3" })],
      ]),
    );

    await expect(latestStableReleaseTag(fetchImpl)).resolves.toBe("v1.2.3");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain("page=1");
    expect(fetchImpl.mock.calls[0][0]).toContain("per_page=100");
    expect(fetchImpl.mock.calls[1][0]).toContain("page=2");
    expect(fetchImpl.mock.calls[1][0]).toContain("per_page=100");
  });

  it("fails closed when the release request throws or returns invalid JSON", async () => {
    await expect(
      latestStableReleaseTag(async () => Promise.reject(new Error("offline"))),
    ).rejects.toThrow("service is unavailable");
    await expect(
      latestStableReleaseTag(
        async () =>
          new globalThis.Response("{", {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
      ),
    ).rejects.toThrow("service is unavailable");
    await expect(
      latestStableReleaseTag(
        async () =>
          new globalThis.Response(JSON.stringify({ tag_name: "v1.2.3" }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
      ),
    ).rejects.toThrow("no stable release is available");
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

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "git-vibe-setup-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** @param {string} directory */
function workflowNames(directory) {
  return readdirSync(join(directory, "workflows")).sort();
}

/** @param {Partial<import("../src/setup/releases.ts").GitHubRelease>} overrides */
function release(overrides = {}) {
  return {
    created_at: "2026-05-10T00:00:00Z",
    draft: false,
    prerelease: false,
    published_at: "2026-05-10T00:00:00Z",
    tag_name: "v1.0.0",
    ...overrides,
  };
}

/** @param {import("../src/setup/releases.ts").GitHubRelease[]} data */
function fetchOk(data) {
  return async () =>
    new globalThis.Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
}

/** @param {import("../src/setup/releases.ts").GitHubRelease[][]} pages */
function fetchPages(pages) {
  /** @param {string | URL | globalThis.Request} url */
  return async (url) => {
    const page = Number(new URL(String(url)).searchParams.get("page") || "1");
    const data = pages[page - 1] || [];
    return new globalThis.Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };
}
