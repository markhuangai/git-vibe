export interface DeliveryDeduplicator {
  has(deliveryId: string): boolean;
  remember(deliveryId: string): void;
}

export interface DeliveryDeduplicatorOptions {
  maxEntries?: number;
  now?: () => number;
  ttlMs?: number;
}

const defaultDeliveryTtlMs = 24 * 60 * 60 * 1000;
const defaultMaxEntries = 10000;

export function createDeliveryDeduplicator(
  options: DeliveryDeduplicatorOptions = {},
): DeliveryDeduplicator {
  const deliveries = new Map<string, number>();
  const maxEntries = options.maxEntries ?? defaultMaxEntries;
  const now = options.now || (() => Date.now());
  const ttlMs = options.ttlMs ?? defaultDeliveryTtlMs;

  const prune = (time: number): void => {
    for (const [deliveryId, seenAt] of deliveries) {
      if (time - seenAt <= ttlMs) continue;
      deliveries.delete(deliveryId);
    }
  };

  return {
    has(deliveryId) {
      prune(now());
      return deliveries.has(deliveryId);
    },
    remember(deliveryId) {
      const time = now();
      prune(time);
      deliveries.set(deliveryId, time);
      while (deliveries.size > maxEntries) {
        const oldest = deliveries.keys().next().value;
        if (!oldest) break;
        deliveries.delete(oldest);
      }
    },
  };
}
