export type GitHubAppPermission = "read" | "write";

export type GitHubActionsRunnerPermissionProfile =
  | "runner-read"
  | "runner-status-write"
  | "runner-workflow-write"
  | "runner-content-write";

export type GitHubAppPermissionProfile = "server" | GitHubActionsRunnerPermissionProfile;

const runnerPermissionProfiles = new Set<string>([
  "runner-read",
  "runner-status-write",
  "runner-workflow-write",
  "runner-content-write",
]);

export function permissionsForProfile(
  profile: GitHubAppPermissionProfile,
): Record<string, GitHubAppPermission> {
  switch (profile) {
    case "server":
      return {
        actions: "write",
        contents: "write",
        discussions: "write",
        issues: "write",
        pull_requests: "write",
      };
    case "runner-read":
      return {
        contents: "read",
        discussions: "read",
        issues: "read",
        pull_requests: "read",
      };
    case "runner-status-write":
      return {
        contents: "read",
        discussions: "write",
        issues: "write",
        pull_requests: "write",
      };
    case "runner-workflow-write":
      return {
        actions: "write",
        contents: "read",
        discussions: "write",
        issues: "write",
        pull_requests: "write",
      };
    case "runner-content-write":
      return {
        actions: "write",
        contents: "write",
        discussions: "write",
        issues: "write",
        pull_requests: "write",
        workflows: "write",
      };
  }
}

export function isGitHubActionsRunnerPermissionProfile(
  value: string,
): value is GitHubActionsRunnerPermissionProfile {
  return runnerPermissionProfiles.has(value);
}

export function isGitHubAppPermissionProfile(value: string): value is GitHubAppPermissionProfile {
  return value === "server" || isGitHubActionsRunnerPermissionProfile(value);
}
