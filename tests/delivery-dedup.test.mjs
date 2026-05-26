import { describe, expect, it } from "vitest";
import { createDeliveryDeduplicator } from "../src/app/delivery-dedup.ts";

describe("delivery de-duplication cache", () => {
  it("expires old delivery IDs and evicts the oldest entries", () => {
    let now = 0;
    const deliveries = createDeliveryDeduplicator({
      maxEntries: 2,
      now: () => now,
      ttlMs: 10,
    });

    expect(deliveries.has("first")).toBe(false);
    deliveries.remember("first");
    expect(deliveries.has("first")).toBe(true);

    now = 11;
    expect(deliveries.has("first")).toBe(false);

    deliveries.remember("second");
    deliveries.remember("third");
    deliveries.remember("fourth");

    expect(deliveries.has("second")).toBe(false);
    expect(deliveries.has("third")).toBe(true);
    expect(deliveries.has("fourth")).toBe(true);
  });
});
