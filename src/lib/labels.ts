export interface GitVibeLabelDefinition {
  color: string;
  description: string;
  name: string;
}

export const gitVibeLabels = {
  approvalRequested: {
    color: "BFD4F2",
    description: "GitVibe is waiting for a trusted approval decision.",
    name: "git-vibe:approval-requested",
  },
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
  bug: {
    color: "D73A4A",
    description: "Bug report tracked by GitVibe.",
    name: "git-vibe:bug",
  },
  inProgress: {
    color: "FBCA04",
    description: "GitVibe implementation is in progress.",
    name: "git-vibe:in-progress",
  },
  investigating: {
    color: "1D76DB",
    description: "GitVibe is investigating a bug or request.",
    name: "git-vibe:investigating",
  },
  investigationComplete: {
    color: "0E8A16",
    description: "GitVibe investigation has completed.",
    name: "git-vibe:investigation-complete",
  },
  needsDiscussion: {
    color: "5319E7",
    description: "Feature request should be discussed before implementation.",
    name: "git-vibe:needs-discussion",
  },
  needsExpectedBehavior: {
    color: "D876E3",
    description: "GitVibe needs trusted expected-behavior clarification.",
    name: "git-vibe:needs-expected-behavior",
  },
  needsInvestigation: {
    color: "C5DEF5",
    description: "Bug report needs investigation before implementation.",
    name: "git-vibe:needs-investigation",
  },
  prOpened: {
    color: "0E8A16",
    description: "GitVibe opened or updated a pull request.",
    name: "git-vibe:pr-opened",
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
} as const satisfies Record<string, GitVibeLabelDefinition>;

export const gitVibeLabelList = Object.values(gitVibeLabels);

const gitVibeLabelNames: Set<string> = new Set(gitVibeLabelList.map((label) => label.name));

export function isGitVibeLabel(name: string): boolean {
  return gitVibeLabelNames.has(name) || name.startsWith("git-vibe:");
}
