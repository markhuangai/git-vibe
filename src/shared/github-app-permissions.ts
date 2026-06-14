export type GitHubAppPermission = "read" | "write";

export type GitHubActionsRunnerPermissionProfile =
  | "runner-read"
  | "runner-status-write"
  | "runner-workflow-write";

export type GitHubAppServerPermissionProfile =
  | "server"
  | "server-checks-read"
  | "server-secrets-write";

export type GitHubAppPermissionProfile =
  | GitHubAppServerPermissionProfile
  | GitHubActionsRunnerPermissionProfile;

export interface GitHubActionsJobIdentity {
  checkRunName: string;
  jobWorkflowRef: string;
}

const runnerPermissionProfiles = new Set<string>([
  "runner-read",
  "runner-status-write",
  "runner-workflow-write",
]);

const serverPermissionProfiles = new Set<string>([
  "server",
  "server-checks-read",
  "server-secrets-write",
]);

const readOnlyJobs: Record<string, string[]> = {
  "investigate.yml": ["plan-investigate"],
  "review.yml": ["plan-review-matrix"],
  "validate.yml": ["plan-validate"],
};

const statusWriteJobs: Record<string, string[]> = {
  "investigate.yml": ["investigate", "security-review"],
  "materialize.yml": ["materialize", "security-review"],
  "review.yml": ["security-review"],
  "validate.yml": ["security-review", "validate"],
};

const workflowWriteJobs: Record<string, string[]> = {
  "review.yml": ["review-matrix"],
};

const codexAuthWritebackJobs: Record<string, string[]> = {
  "investigate.yml": ["investigate"],
  "materialize.yml": ["materialize"],
  "review.yml": ["review-matrix"],
  "validate.yml": ["validate"],
};

const memberJobPrefixes = [
  "git-vibe-investigate-member-",
  "git-vibe-review-member-",
  "git-vibe-validate-member-",
];

export function permissionsForProfile(
  profile: GitHubAppPermissionProfile,
): Record<string, GitHubAppPermission> {
  switch (profile) {
    case "server":
      return {
        actions: "write",
        actions_variables: "read",
        contents: "write",
        discussions: "write",
        issues: "write",
        pull_requests: "write",
      };
    case "server-checks-read":
      return {
        checks: "read",
      };
    case "server-secrets-write":
      return {
        secrets: "write",
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
  }
}

export function isGitHubActionsRunnerPermissionProfile(
  value: string,
): value is GitHubActionsRunnerPermissionProfile {
  return runnerPermissionProfiles.has(value);
}

export function isGitHubAppPermissionProfile(value: string): value is GitHubAppPermissionProfile {
  return serverPermissionProfiles.has(value) || isGitHubActionsRunnerPermissionProfile(value);
}

export function runnerPermissionProfileForGitHubActionsJob(
  identity: GitHubActionsJobIdentity,
): GitHubActionsRunnerPermissionProfile | undefined {
  const workflowFile = workflowFileFromJobWorkflowRef(identity.jobWorkflowRef);
  const jobName = jobNameFromCheckRun(identity.checkRunName);
  if (!workflowFile || !jobName) return undefined;
  if (memberJob(jobName) || listedJob(readOnlyJobs, workflowFile, jobName)) return "runner-read";
  if (listedJob(statusWriteJobs, workflowFile, jobName)) return "runner-status-write";
  if (listedJob(workflowWriteJobs, workflowFile, jobName)) return "runner-workflow-write";
  return undefined;
}

export function canWriteBackCodexAuthForGitHubActionsJob(
  identity: GitHubActionsJobIdentity,
): boolean {
  const workflowFile = workflowFileFromJobWorkflowRef(identity.jobWorkflowRef);
  const jobName = jobNameFromCheckRun(identity.checkRunName);
  if (!workflowFile || !jobName) return false;
  return memberJob(jobName) || listedJob(codexAuthWritebackJobs, workflowFile, jobName);
}

function workflowFileFromJobWorkflowRef(value: string): string | undefined {
  return /\.github\/workflows\/([^/@]+\.ya?ml)@/.exec(value)?.[1];
}

function jobNameFromCheckRun(value: string): string {
  const name = value.trim();
  if (knownGitVibeJobName(name)) return name;
  const separator = name.indexOf(" / ");
  if (separator < 0) return name;
  const suffix = name.slice(separator + 3).trim();
  return knownGitVibeJobName(suffix) ? suffix : name;
}

function listedJob(jobs: Record<string, string[]>, workflowFile: string, jobName: string): boolean {
  return jobs[workflowFile]?.includes(jobName) || false;
}

function knownGitVibeJobName(jobName: string): boolean {
  return (
    memberJob(jobName) ||
    listedAnyJob(readOnlyJobs, jobName) ||
    listedAnyJob(statusWriteJobs, jobName) ||
    listedAnyJob(workflowWriteJobs, jobName) ||
    listedAnyJob(codexAuthWritebackJobs, jobName)
  );
}

function listedAnyJob(jobs: Record<string, string[]>, jobName: string): boolean {
  return Object.values(jobs).some((jobNames) => jobNames.includes(jobName));
}

function memberJob(jobName: string): boolean {
  return memberJobPrefixes.some((prefix) => jobName.startsWith(prefix));
}
