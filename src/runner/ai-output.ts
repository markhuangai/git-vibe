export interface AiToolCall {
  input?: unknown;
  toolName?: string;
}

export interface AiStep {
  toolCalls?: AiToolCall[];
}

export interface AiResult {
  response?: {
    messages?: unknown[];
  };
  steps?: AiStep[];
  text: string;
  totalUsage?: unknown;
  usage?: unknown;
}

export function extractValidatedOutput(result: AiResult): string {
  return outputValidatorContent(result) || extractJson(result.text);
}

function outputValidatorContent(result: AiResult): string | undefined {
  return outputValidatorContentFromSteps(result.steps || []);
}

export function outputValidatorContentFromSteps(steps: AiStep[]): string | undefined {
  const calls = steps.flatMap((step) => step.toolCalls || []);
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call.toolName !== "output_validator") continue;

    const input = call.input;
    if (!input || typeof input !== "object") continue;

    const content = (input as Record<string, unknown>).content;
    if (typeof content === "string") return content.trim();
  }

  return undefined;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const match = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (match) return match[1].trim();

  throw new Error("AI response did not contain a JSON object");
}
