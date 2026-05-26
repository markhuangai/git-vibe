export function gitAuthEnv(token: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const index = gitConfigCount(env);
  return {
    ...env,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: "http.extraheader",
    [`GIT_CONFIG_VALUE_${index}`]: `AUTHORIZATION: bearer ${token}`,
  };
}

function gitConfigCount(env: NodeJS.ProcessEnv): number {
  const count = Number(env.GIT_CONFIG_COUNT || 0);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}
