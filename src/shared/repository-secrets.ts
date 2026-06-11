import sodium from "libsodium-wrappers";
import { splitRepository, type GitHubClient } from "./github.js";

export interface UpdateRepositorySecretOptions {
  client: GitHubClient;
  name: string;
  repository: string;
  token: string;
  value: string;
}

export async function updateRepositorySecret(
  options: UpdateRepositorySecretOptions,
): Promise<void> {
  const { owner, repo } = splitRepository(options.repository);
  const publicKey = await options.client.request<{ key?: string; key_id?: string }>({
    method: "GET",
    path: `/repos/${owner}/${repo}/actions/secrets/public-key`,
    token: options.token,
  });
  if (!publicKey.key || !publicKey.key_id) {
    throw new Error(
      `GitHub repository ${options.repository} did not return an Actions public key.`,
    );
  }
  await options.client.request({
    body: {
      encrypted_value: await encryptedSecretValue(options.value, publicKey.key),
      key_id: publicKey.key_id,
    },
    method: "PUT",
    path: `/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(options.name)}`,
    token: options.token,
  });
}

async function encryptedSecretValue(value: string, publicKey: string): Promise<string> {
  await sodium.ready;
  const keyBytes = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const encryptedBytes = sodium.crypto_box_seal(value, keyBytes);
  return sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
}
