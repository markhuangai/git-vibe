// @ts-nocheck
export function queueAllowedSafetyFinding() {
  globalThis.__gitVibeSdkMocks.queueCodexOutput({
    findings: [],
    severity: "none",
    status: "allowed",
    summary: "No prompt-injection risk detected.",
  });
}

export function queueBlockedSafetyFinding(finding) {
  const [sourceLabel, risk = "prompt-injection risk"] = finding
    .split(":")
    .map((part) => part.trim());
  globalThis.__gitVibeSdkMocks.queueCodexOutput({
    findings: [
      {
        excerpt: "",
        reason: "The classifier marked this source as unsafe.",
        risk,
        severity: "high",
        source_label: sourceLabel,
      },
    ],
    severity: "high",
    status: "blocked",
    summary: "Prompt-injection input detected.",
  });
}
