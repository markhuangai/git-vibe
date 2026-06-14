import type { GitVibeConfig } from "./types.js";

type BudgetInputMapping = ReadonlyArray<readonly [budgetKey: string, inputKey: string]>;

export function workflowBudgetInputsFor(
  config: GitVibeConfig,
  workflow: string,
): Record<string, string> {
  if (workflow === "review.yml") return reviewWorkflowBudgetInputs(config);
  return defaultStageWorkflowBudgetInputs(config);
}

export function reviewWorkflowBudgetInputs(config: GitVibeConfig): Record<string, string> {
  return {
    ...defaultStageWorkflowBudgetInputs(config),
    ...workflowBudgetInputs(config, [["review_timeout_minutes", "timeout_minutes"]]),
  };
}

export function defaultStageWorkflowBudgetInputs(config: GitVibeConfig): Record<string, string> {
  return workflowBudgetInputs(config, [
    ["default_timeout_minutes", "timeout_minutes"],
    ["default_max_turns", "max_turns"],
  ]);
}

export function positiveBudgetInteger(
  config: GitVibeConfig,
  key: string,
  fallback: number,
): number {
  const value = budgetValue(config, key);
  if (value === undefined) return fallback;
  return positiveInteger(value, `ai.budgets.${key}`);
}

function workflowBudgetInputs(
  config: GitVibeConfig,
  mappings: BudgetInputMapping,
): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const [budgetKey, inputKey] of mappings) {
    const value = budgetValue(config, budgetKey);
    if (value !== undefined)
      inputs[inputKey] = String(positiveInteger(value, `ai.budgets.${budgetKey}`));
  }
  return inputs;
}

function budgetValue(config: GitVibeConfig, key: string): unknown {
  const budgets = config.ai?.budgets;
  if (budgets === undefined || budgets === null) return undefined;
  if (!isRecord(budgets)) throw new Error("ai.budgets must be an object.");
  return budgets[key];
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new Error(`${name} must be a positive integer.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
