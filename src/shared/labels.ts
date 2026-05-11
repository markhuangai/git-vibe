export interface GitVibeLabelDefinition {
  color: string;
  description: string;
  name: string;
}

export const gitVibeLabels = {
  approved: {
    color: "0E8A16",
    description: "Trusted actor approved GitVibe implementation automation.",
    name: "git-vibe:approved",
  },
  blocked: {
    color: "D93F0B",
    description: "GitVibe is blocked by missing or contradictory information.",
    name: "git-vibe:blocked",
  },
  inProgress: {
    color: "FBCA04",
    description: "GitVibe implementation is in progress.",
    name: "git-vibe:in-progress",
  },
  investigate: {
    color: "C5DEF5",
    description: "Trusted actor requested GitVibe investigation automation.",
    name: "git-vibe:investigate",
  },
  investigated: {
    color: "0E8A16",
    description: "GitVibe investigation completed and implementation approval is allowed.",
    name: "git-vibe:investigated",
  },
  investigating: {
    color: "1D76DB",
    description: "GitVibe is investigating a bug or request.",
    name: "git-vibe:investigating",
  },
  needsDiscussion: {
    color: "5319E7",
    description: "Feature request should be discussed before implementation.",
    name: "git-vibe:needs-discussion",
  },
  prOpened: {
    color: "0E8A16",
    description: "GitVibe opened or updated a pull request.",
    name: "git-vibe:pr-opened",
  },
  prApproved: {
    color: "0E8A16",
    description: "GitVibe pull request was approved by a trusted reviewer.",
    name: "git-vibe:pr-approved",
  },
  prMerged: {
    color: "5319E7",
    description: "GitVibe pull request was merged while the issue awaits default-branch closure.",
    name: "git-vibe:pr-merged",
  },
  readyForApproval: {
    color: "FBCA04",
    description: "GitVibe believes the issue is ready for approval.",
    name: "git-vibe:ready-for-approval",
  },
  story: {
    color: "5319E7",
    description: "Implementation issue materialized from a GitVibe discussion.",
    name: "git-vibe:story",
  },
  validate: {
    color: "C5DEF5",
    description: "Trusted actor requested GitVibe validation automation.",
    name: "git-vibe:validate",
  },
} as const satisfies Record<string, GitVibeLabelDefinition>;

export const gitVibeInternalLabels = {
  reviewFix: {
    color: "6F42C1",
    description: "Internal GitVibe review-fix continuation issue.",
    name: "gvi:review-fix",
  },
} as const satisfies Record<string, GitVibeLabelDefinition>;

const gitVibePublicLabelList = Object.values(gitVibeLabels);
const gitVibeInternalLabelList = Object.values(gitVibeInternalLabels);
export const gitVibeLabelList = [...gitVibePublicLabelList, ...gitVibeInternalLabelList];

const gitVibeLabelNames: Set<string> = new Set(gitVibeLabelList.map((label) => label.name));

export function isGitVibeLabel(name: string): boolean {
  return gitVibeLabelNames.has(name) || name.startsWith("git-vibe:") || name.startsWith("gvi:");
}

export function isInternalGitVibeLabel(name: string): boolean {
  return name.startsWith("gvi:");
}
