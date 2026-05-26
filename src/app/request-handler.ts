import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeliveryDeduplicator } from "./delivery-dedup.js";
import {
  firstHeader,
  readBody,
  sendJson,
  toHttpError,
  verifyGitHubSignature,
} from "./server-http.js";
import type { WebhookPayload } from "./types.js";

export interface RequestHandlerState {
  config: {
    webhookSecret: string;
  };
  deliveries: DeliveryDeduplicator;
  errorLog: (message: string) => void;
}

export type WebhookHandler = (event: string, payload: WebhookPayload) => Promise<void>;

export async function handleRequest(
  state: RequestHandlerState,
  req: IncomingMessage,
  res: ServerResponse,
  handleWebhook: WebhookHandler,
): Promise<void> {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method !== "POST" || req.url !== "/webhooks") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const body = await readBody(req);
    verifyGitHubSignature(
      body,
      firstHeader(req.headers["x-hub-signature-256"]),
      state.config.webhookSecret,
    );

    const event = firstHeader(req.headers["x-github-event"]) || "";
    const deliveryId = firstHeader(req.headers["x-github-delivery"]);
    if (deliveryId && state.deliveries.has(deliveryId)) {
      sendJson(res, 202, { accepted: true, duplicate: true, event });
      return;
    }

    const payload = JSON.parse(body) as WebhookPayload;
    await handleWebhook(event, payload);
    if (deliveryId) state.deliveries.remember(deliveryId);
    sendJson(res, 202, { accepted: true, event });
  } catch (error) {
    const httpError = toHttpError(error);
    state.errorLog(`app error: ${httpError.message}`);
    sendJson(res, httpError.statusCode || 500, { error: httpError.message });
  }
}
