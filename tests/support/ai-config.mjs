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
  if (!config.trim()) return testAiConfigYaml();
  if (config.trimStart().startsWith("ai:")) {
    return testAiConfigYaml(config.replace(/^\s*ai:\s*\n?/, ""));
  }

  return `${testAiConfigYaml()}\n${config}`;
}
