// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  positiveBudgetInteger,
  reviewWorkflowBudgetInputs,
  workflowBudgetInputsFor,
} from "../src/shared/budgets.ts";

describe("workflow budget inputs", () => {
  it("maps default stage budgets to reusable workflow inputs", () => {
    expect(
      workflowBudgetInputsFor(
        { ai: { budgets: { default_max_turns: 77, default_timeout_minutes: 55 } } },
        "investigate.yml",
      ),
    ).toEqual({ max_turns: "77", timeout_minutes: "55" });
  });

  it("routes workflow-specific budget input mapping", () => {
    const config = {
      ai: {
        budgets: {
          default_max_turns: 90,
          review_timeout_minutes: 61,
        },
      },
    };

    expect(workflowBudgetInputsFor(config, "review.yml")).toEqual({
      max_turns: "90",
      timeout_minutes: "61",
    });
  });

  it("lets review workflow budgets override default stage budgets", () => {
    const config = {
      ai: {
        budgets: {
          default_max_turns: 90,
          default_timeout_minutes: 60,
          review_timeout_minutes: 61,
        },
      },
    };

    expect(reviewWorkflowBudgetInputs(config)).toEqual({
      max_turns: "90",
      timeout_minutes: "61",
    });
  });
});

describe("workflow budget validation", () => {
  it("fails loudly for invalid positive-integer budget controls", () => {
    expect(() =>
      workflowBudgetInputsFor({ ai: { budgets: { default_max_turns: 0 } } }, "validate.yml"),
    ).toThrow("ai.budgets.default_max_turns must be a positive integer.");
    expect(() =>
      positiveBudgetInteger(
        { ai: { budgets: { review_timeout_minutes: 1.5 } } },
        "review_timeout_minutes",
        3,
      ),
    ).toThrow("ai.budgets.review_timeout_minutes must be a positive integer.");
    expect(() => workflowBudgetInputsFor({ ai: { budgets: [] } }, "validate.yml")).toThrow(
      "ai.budgets must be an object.",
    );
  });
});
