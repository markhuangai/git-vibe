// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  addressFeedbackWorkflowBudgetInputs,
  developWorkflowBudgetInputs,
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
          feedback_max_turns: 120,
          feedback_timeout_minutes: 121,
          implementation_max_turns: 200,
          implementation_timeout_minutes: 122,
          review_timeout_minutes: 61,
        },
      },
    };

    expect(workflowBudgetInputsFor(config, "develop.yml")).toMatchObject({
      implementation_max_turns: "200",
      implementation_timeout_minutes: "122",
      max_turns: "90",
    });
    expect(workflowBudgetInputsFor(config, "review.yml")).toEqual({
      max_turns: "90",
      timeout_minutes: "61",
    });
    expect(workflowBudgetInputsFor(config, "address-feedback.yml")).toEqual({
      max_turns: "120",
      timeout_minutes: "121",
    });
  });

  it("maps develop workflow budgets to develop.yml inputs", () => {
    expect(
      developWorkflowBudgetInputs({
        ai: {
          budgets: {
            default_max_turns: 90,
            create_pr_timeout_minutes: 15,
            implementation_max_turns: 200,
            implementation_timeout_minutes: 120,
            review_timeout_minutes: 60,
            validation_repair_attempts: 3,
            validation_repair_max_turns: 45,
          },
        },
      }),
    ).toEqual({
      create_pr_timeout_minutes: "15",
      implementation_max_turns: "200",
      implementation_timeout_minutes: "120",
      max_turns: "90",
      review_timeout_minutes: "60",
      validation_repair_attempts: "3",
      validation_repair_max_turns: "45",
    });
  });

  it("lets workflow-specific PR budgets override default stage budgets", () => {
    const config = {
      ai: {
        budgets: {
          default_max_turns: 90,
          default_timeout_minutes: 60,
          feedback_max_turns: 120,
          feedback_timeout_minutes: 121,
          review_timeout_minutes: 61,
        },
      },
    };

    expect(reviewWorkflowBudgetInputs(config)).toEqual({
      max_turns: "90",
      timeout_minutes: "61",
    });
    expect(addressFeedbackWorkflowBudgetInputs(config)).toEqual({
      max_turns: "120",
      timeout_minutes: "121",
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
        { ai: { budgets: { pr_feedback_max_iterations: 1.5 } } },
        "pr_feedback_max_iterations",
        3,
      ),
    ).toThrow("ai.budgets.pr_feedback_max_iterations must be a positive integer.");
    expect(() => workflowBudgetInputsFor({ ai: { budgets: [] } }, "validate.yml")).toThrow(
      "ai.budgets must be an object.",
    );
  });
});
