import { execFileSync } from "node:child_process";

export function repositoryContext(cwd: string): string {
  return execFileSync("git", ["status", "--short", "--branch"], { cwd }).toString();
}
