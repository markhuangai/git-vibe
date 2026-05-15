const requiredSecrets = [
  ["GITVIBE_AI_ENV_JSON", "JSON env bundle for AI provider config and CLI auth."],
  ["GITVIBE_GITHUB_TOKEN", "Fine-grained PAT for GitVibe workflow and server writes."],
  ["WEBHOOK_SECRET", "Webhook shared secret mapped to GITHUB_WEBHOOK_SECRET in deployment."],
] as const;

const usefulVariables = [
  "GITVIBE_BASE_BRANCH",
  "GITVIBE_DISCUSSION_CATEGORY",
  "GITVIBE_RUNNER",
  "GITVIBE_LOG_LEVEL",
] as const;

export function renderManualSetupInstructions(releaseTag: string): string {
  const lines = [
    `GitVibe starter files installed with reusable workflows pinned to ${releaseTag}.`,
    "",
    "Configure these GitHub secrets manually before running the workflows:",
    ...requiredSecrets.map(([name, description]) => `- ${name}: ${description}`),
    "",
    "Optional repository variables:",
    ...usefulVariables.map((name) => `- ${name}`),
    "",
    `Reference bundle shape: https://github.com/markhuangai/git-vibe/blob/${releaseTag}/examples/consumer/GITVIBE_AI_ENV_JSON.example.json`,
  ];

  return lines.join("\n");
}
