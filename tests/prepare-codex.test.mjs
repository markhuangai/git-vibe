// @ts-nocheck
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Codex preparation script", () => {
  it("exports the Codex executable without overriding CODEX_HOME", () => {
    const cwd = mkdtempSync(join(tmpdir(), "git-vibe-codex-prepare-"));
    const executable = join(cwd, "codex");
    const githubEnv = join(cwd, "github-env");
    const runnerTemp = join(cwd, "runner-temp");
    writeFileSync(executable, "#!/usr/bin/env bash\necho codex 0.0.0\n");
    chmodSync(executable, 0o755);

    try {
      const result = spawnSync("bash", ["scripts/prepare-codex.sh"], {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: join(cwd, "persistent-codex-home"),
          GITHUB_ENV: githubEnv,
          GITVIBE_CODEX_PATH: executable,
          RUNNER_TEMP: runnerTemp,
        },
      });
      const exportedEnv = readFileSync(githubEnv, "utf8");

      expect(result.status).toBe(0);
      expect(exportedEnv).toContain(`GITVIBE_CODEX_PATH=${executable}`);
      expect(exportedEnv).not.toContain("CODEX_HOME=");
      expect(exportedEnv).not.toContain("persistent-codex-home");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});
