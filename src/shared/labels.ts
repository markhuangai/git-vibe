export interface GitVibeLabelDefinition {
  color: string;
  description: string;
  name: string;
}

export const gitVibeLabels = {
  approved: {
    color: "0E8A16",
    description: "Trusted actor approved GitVibe materialization automation.",
    name: "git-vibe:approved",
  },
  acceptRisk: {
    color: "B60205",
    description: "Trusted actor accepted prompt-injection risk for one GitVibe rerun.",
    name: "git-vibe:accept-risk",
  },
  blocked: {
    color: "D93F0B",
    description: "GitVibe is blocked by missing or contradictory information.",
    name: "gvi:blocked",
  },
  inProgress: {
    color: "FBCA04",
    description: "GitVibe deterministic write work is in progress.",
    name: "gvi:in-progress",
  },
  investigate: {
    color: "C5DEF5",
    description: "Trusted actor requested GitVibe investigation automation.",
    name: "git-vibe:investigate",
  },
  investigated: {
    color: "0E8A16",
    description: "GitVibe investigation completed and validation can proceed.",
    name: "gvi:investigated",
  },
  investigating: {
    color: "1D76DB",
    description: "GitVibe is investigating a bug or request.",
    name: "gvi:investigating",
  },
  needsDiscussion: {
    color: "5319E7",
    description: "Feature request should be discussed before issue materialization.",
    name: "gvi:needs-discussion",
  },
  prOpened: {
    color: "0E8A16",
    description: "GitVibe opened or updated a pull request before automation was disabled.",
    name: "gvi:pr-opened",
  },
  prApproved: {
    color: "0E8A16",
    description: "GitVibe pull request was approved by a trusted reviewer.",
    name: "gvi:pr-approved",
  },
  prMerged: {
    color: "5319E7",
    description: "GitVibe pull request was merged while the issue awaits default-branch closure.",
    name: "gvi:pr-merged",
  },
  readyForApproval: {
    color: "FBCA04",
    description: "GitVibe believes the issue or pull request is ready for approval.",
    name: "gvi:ready-for-approval",
  },
  review: {
    color: "C5DEF5",
    description: "Trusted actor requested GitVibe pull request review automation.",
    name: "git-vibe:review",
  },
  reviewing: {
    color: "1D76DB",
    description: "GitVibe is reviewing a pull request.",
    name: "gvi:reviewing",
  },
  story: {
    color: "5319E7",
    description: "Implementation issue materialized from a GitVibe discussion.",
    name: "gvi:story",
  },
  validate: {
    color: "C5DEF5",
    description: "Trusted actor requested GitVibe validation automation.",
    name: "git-vibe:validate",
  },
  validated: {
    color: "0E8A16",
    description: "GitVibe validation completed and materialization is allowed.",
    name: "gvi:validated",
  },
  validating: {
    color: "1D76DB",
    description: "GitVibe is validating an issue or discussion.",
    name: "gvi:validating",
  },
} as const satisfies Record<string, GitVibeLabelDefinition>;

const gitVibeManagedLabelList = Object.values(gitVibeLabels);
export const gitVibeLabelList = [...gitVibeManagedLabelList];

const gitVibeLabelNames: Set<string> = new Set(gitVibeLabelList.map((label) => label.name));
const gitVibeRuntimeLabelNames: Set<string> = new Set(
  Object.values(gitVibeLabels)
    .filter((label) => label.name.startsWith("gvi:"))
    .map((label) => label.name),
);

export function isGitVibeLabel(name: string): boolean {
  return gitVibeLabelNames.has(name) || name.startsWith("git-vibe:") || name.startsWith("gvi:");
}

export function isInternalGitVibeLabel(name: string): boolean {
  return name.startsWith("gvi:");
}

export function isGitVibeRuntimeLabel(name: string): boolean {
  return gitVibeRuntimeLabelNames.has(name);
}
