import { execFileSync } from "node:child_process";
import type { IssueBranchState } from "./review-fix.js";

export function ensureGitIdentity(cwd: string): void {
  setGitConfigIfMissing(cwd, "user.name", "git-vibe");
  setGitConfigIfMissing(cwd, "user.email", "git-vibe@users.noreply.github.com");
}

export function repositoryContext(cwd: string, branchState?: IssueBranchState): string {
  const status = execFileSync("git", ["status", "--short", "--branch"], { cwd }).toString();
  if (!branchState) return status;
  return [
    `GitVibe branch: ${branchState.branch}`,
    `GitVibe branch remote found: ${branchState.remoteFound ? "yes" : "no"}`,
    "",
    status,
    "",
    "Recent commits:",
    recentCommits(cwd),
  ].join("\n");
}

export function gitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

export function summarizeGitStatus(status: string): string {
  const lines = status.split("\n").filter(Boolean);
  const visible = lines.slice(0, 12).join("; ");
  if (lines.length <= 12) return visible;
  return `${visible}; ... +${lines.length - 12} more`;
}

export function unstageRuntimeArtifactChanges(cwd: string): string[] {
  const paths = stagedRuntimeArtifactPaths(cwd);
  if (paths.length > 0) {
    execFileSync("git", ["restore", "--staged", "--", ...paths], {
      cwd,
      stdio: "inherit",
    });
  }
  return paths;
}

export function summarizePaths(paths: string[]): string {
  const visible = paths.slice(0, 12).join("; ");
  if (paths.length <= 12) return visible;
  return `${visible}; ... +${paths.length - 12} more`;
}

function setGitConfigIfMissing(cwd: string, key: string, value: string): void {
  try {
    const existing = execFileSync("git", ["config", "--get", key], { cwd }).toString().trim();
    if (existing) return;
  } catch {
    // Missing config is expected on fresh runners.
  }

  execFileSync("git", ["config", key, value], { cwd, stdio: "inherit" });
}

function recentCommits(cwd: string): string {
  try {
    return execFileSync("git", ["log", "--oneline", "--decorate", "-5"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return "<no commits>";
  }
}

function stagedRuntimeArtifactPaths(cwd: string): string[] {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--diff-filter=ACMRTUXB", "--name-only", "-z", "--", ".git-vibe"],
    {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).toString();
  return output.split("\0").filter(Boolean);
}
