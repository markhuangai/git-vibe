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
  const separator = finding.indexOf(":");
  const sourceLabel = (separator === -1 ? finding : finding.slice(0, separator)).trim();
  const risk = (separator === -1 ? "prompt-injection risk" : finding.slice(separator + 1)).trim();
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
