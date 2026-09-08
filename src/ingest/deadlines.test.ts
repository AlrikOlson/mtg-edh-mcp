import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkClient, BULK_DOWNLOAD_TIMEOUT_MS, SCRYFALL_JSON_TIMEOUT_MS } from "./scryfall.js";
import { LiveScryfallClient } from "./live.js";

afterEach(() => vi.restoreAllMocks());

describe("Scryfall request deadlines", () => {
  it("gives bulk bodies a separate, longer deadline than JSON metadata", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const client = new BulkClient({
      minSpacingMs: 0,
      fetch: (_input, init) => {
        signals.push(init?.signal);
        return Promise.resolve(Response.json({ data: [] }));
      },
    });
    await client.listBulkData();
    const body = await client.openDownload("https://example.test/bulk");
    await body.cancel();
    expect(timeout.mock.calls).toEqual([[SCRYFALL_JSON_TIMEOUT_MS], [BULK_DOWNLOAD_TIMEOUT_MS]]);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("aborts a stalled metadata request and allows a subsequent retry", async () => {
    let stalled = true;
    const client = new BulkClient({
      requestTimeoutMs: 5,
      minSpacingMs: 0,
      fetch: (_input, init) => {
        if (!stalled) return Promise.resolve(Response.json({ data: [] }));
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error("Missing deadline"));
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    await expect(client.listBulkData()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    stalled = false;
    await expect(client.listBulkData()).resolves.toEqual([]);
  });

  it("bounds live lookups and maps body-read timeouts to structured upstream errors", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const client = new LiveScryfallClient({
      fetch: (_input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(
                  new DOMException("Timed out while reading the body", "TimeoutError"),
                );
              },
            }),
          ),
        );
      },
    });
    await expect(client.getCardByName("Sol Ring")).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      details: { reason: "Timed out while reading the body" },
    });
    expect(timeout).toHaveBeenCalledWith(SCRYFALL_JSON_TIMEOUT_MS);
  });
});
