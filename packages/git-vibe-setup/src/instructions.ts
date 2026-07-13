const requiredSecrets = [
  ["GITVIBE_AI_ENV_JSON", "JSON env bundle for AI provider and proxy config."],
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
    "Configure this GitHub secret manually before running the workflows:",
    ...requiredSecrets.map(([name, description]) => `- ${name}: ${description}`),
    "- GITVIBE_MCP_ENV_JSON: optional JSON env bundle for MCP credentials.",
    "",
    "Optional repository variables:",
    ...usefulVariables.map((name) => `- ${name}`),
    "",
    `Reference bundle shape: https://github.com/markhuangai/git-vibe/blob/${releaseTag}/examples/consumer/GITVIBE_AI_ENV_JSON.example.json`,
  ];

  return lines.join("\n");
}
