const commandPattern = /^(?<trigger>\/git-vibe)(?:\s+(?<rest>.*))?$/i;

export interface ParsedCommand {
  args: string[];
  command: string;
  raw: string;
  trigger: string;
}

export function parseCommand(body: unknown): ParsedCommand | null {
  const firstLine = String(body || "")
    .split("\n", 1)[0]
    .trim();
  const match = firstLine.match(commandPattern);

  if (!match) return null;

  const rest = (match.groups?.rest || "").trim();
  const [command = "help", ...args] = rest ? rest.split(/\s+/) : [];

  return {
    args,
    command: command.toLowerCase(),
    raw: firstLine,
    trigger: match.groups?.trigger?.toLowerCase() || "",
  };
}
