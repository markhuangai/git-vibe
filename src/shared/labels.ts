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
    name: "gvi:blocked",
  },
  inProgress: {
    color: "FBCA04",
    description: "GitVibe implementation is in progress.",
    name: "gvi:in-progress",
  },
  investigate: {
    color: "C5DEF5",
    description: "Trusted actor requested GitVibe investigation automation.",
    name: "git-vibe:investigate",
  },
  investigated: {
    color: "0E8A16",
    description: "GitVibe investigation completed and implementation approval is allowed.",
    name: "gvi:investigated",
  },
  investigating: {
    color: "1D76DB",
    description: "GitVibe is investigating a bug or request.",
    name: "gvi:investigating",
  },
  needsDiscussion: {
    color: "5319E7",
    description: "Feature request should be discussed before implementation.",
    name: "gvi:needs-discussion",
  },
  prOpened: {
    color: "0E8A16",
    description: "GitVibe opened or updated a pull request.",
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
    description: "GitVibe believes the issue is ready for approval.",
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

export const gitVibeLegacyLabelAliases = {
  blocked: "git-vibe:blocked",
  inProgress: "git-vibe:in-progress",
  investigated: "git-vibe:investigated",
  investigating: "git-vibe:investigating",
  needsDiscussion: "git-vibe:needs-discussion",
  prApproved: "git-vibe:pr-approved",
  prMerged: "git-vibe:pr-merged",
  prOpened: "git-vibe:pr-opened",
  readyForApproval: "git-vibe:ready-for-approval",
  reviewing: "git-vibe:reviewing",
  story: "git-vibe:story",
  validated: "git-vibe:validated",
  validating: "git-vibe:validating",
} as const satisfies Partial<Record<keyof typeof gitVibeLabels, string>>;

export const gitVibeInternalLabels = {
  reviewFix: {
    color: "6F42C1",
    description: "Internal GitVibe review-fix continuation marker.",
    name: "gvi:review-fix",
  },
} as const satisfies Record<string, GitVibeLabelDefinition>;

const gitVibeManagedLabelList = Object.values(gitVibeLabels);
const gitVibeInternalLabelList = Object.values(gitVibeInternalLabels);
export const gitVibeLabelList = [...gitVibeManagedLabelList, ...gitVibeInternalLabelList];

const gitVibeLabelNames: Set<string> = new Set(gitVibeLabelList.map((label) => label.name));
const gitVibeRuntimeLabelNames: Set<string> = new Set(
  Object.values(gitVibeLabels)
    .filter((label) => label.name.startsWith("gvi:"))
    .map((label) => label.name),
);
const legacyByCanonicalLabelName: Map<string, string> = new Map(
  Object.entries(gitVibeLegacyLabelAliases).map(([key, legacyName]) => [
    gitVibeLabels[key as keyof typeof gitVibeLabels].name,
    legacyName,
  ]),
);
const canonicalByLegacyLabelName: Map<string, string> = new Map(
  [...legacyByCanonicalLabelName.entries()].map(([canonicalName, legacyName]) => [
    legacyName,
    canonicalName,
  ]),
);

export function isGitVibeLabel(name: string): boolean {
  return gitVibeLabelNames.has(name) || name.startsWith("git-vibe:") || name.startsWith("gvi:");
}

export function isInternalGitVibeLabel(name: string): boolean {
  return name.startsWith("gvi:");
}

export function isGitVibeRuntimeLabel(name: string): boolean {
  return gitVibeRuntimeLabelNames.has(canonicalGitVibeLabelName(name));
}

export function canonicalGitVibeLabelName(name: string): string {
  return canonicalByLegacyLabelName.get(name) || name;
}

export function equivalentGitVibeLabelNames(name: string): string[] {
  const canonicalName = canonicalGitVibeLabelName(name);
  const legacyName = legacyByCanonicalLabelName.get(canonicalName);
  return legacyName ? [canonicalName, legacyName] : [canonicalName];
}
