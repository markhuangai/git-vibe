import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const maxWebhookBodyBytes = 25 * 1024 * 1024;

export function verifyGitHubSignature(
  body: string,
  signatureHeader: string | undefined,
  secret: string,
): void {
  if (!signatureHeader?.startsWith("sha256=")) {
    throw Object.assign(new Error("missing GitHub signature"), { statusCode: 401 });
  }

  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const actual = signatureHeader.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw Object.assign(new Error("invalid GitHub signature"), { statusCode: 401 });
  }
}

export function readBody(req: IncomingMessage, maxBytes = maxWebhookBodyBytes): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
      req.destroy();
    };

    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      if (byteLength > maxBytes) {
        fail(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export function sendJson(res: ServerResponse, statusCode: number, value: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name] || "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function toHttpError(error: unknown): Error & { statusCode?: number } {
  return error instanceof Error
    ? (error as Error & { statusCode?: number })
    : new Error(String(error));
}
