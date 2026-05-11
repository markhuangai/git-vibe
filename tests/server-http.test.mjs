import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readBody } from "../src/app/server-http.ts";

describe("GitVibe app server HTTP helpers", () => {
  it("rejects request bodies over the configured byte limit", async () => {
    const stream = new PassThrough();
    const req = /** @type {import("node:http").IncomingMessage} */ (
      /** @type {unknown} */ (stream)
    );
    const body = readBody(req, 4);

    stream.end("12345");

    await expect(body).rejects.toMatchObject({
      message: "request body too large",
      statusCode: 413,
    });
  });
});
