function testAiConfigYaml(extraAi = "") {
  const extra = extraAi.trimEnd();
  return `ai:
  profiles:
    test:
      adapter: codex-sdk
      model: gpt-5-test
      reasoning:
        effort: high
  stages:
    investigate:
      profile: test
    validate:
      profile: test
    materialize:
      profile: test
    review-matrix:
      profile: test
${extra ? `${extra}\n` : ""}`;
}

export function workspaceConfigWithTestAi(config = "") {
  if (!config.trim()) return `${testAiConfigYaml()}\n${defaultSafetyConfig()}`;
  if (config.trimStart().startsWith("ai:")) {
    const base = testAiConfigYaml(config.replace(/^\s*ai:\s*\n?/, ""));
    return /^\s*safety:/m.test(config) ? base : `${base}\n${defaultSafetyConfig()}`;
  }

  return withDefaultSafety(config, testAiConfigYaml());
}

/**
 * @param {string} config
 * @param {string} base
 */
function withDefaultSafety(config, base) {
  const safety = /^\s*safety:/m.test(config) ? "" : `\n${defaultSafetyConfig()}`;
  return `${base}${safety}\n${config}`;
}

function defaultSafetyConfig() {
  return `safety:
  prompt_injection_gate: false
`;
}
