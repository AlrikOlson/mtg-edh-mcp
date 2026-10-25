import { describe, it, expect } from "vitest";
import {
  LiveScryfallClient,
  CARD_SPACING_MS,
  SEARCH_SPACING_MS,
  USER_AGENT,
  type FetchFn,
} from "./index.js";

interface Call {
  url: string;
  ua: string | undefined;
}

/** Recording fetch stub: captures URL + User-Agent, returns the given body. */
function recordingFetch(calls: Call[], body: unknown, status = 200): FetchFn {
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ url, ua: headers?.["User-Agent"] });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as FetchFn;
}

const RAW_CARD = {
  oracle_id: "o-x",
  id: "p-x",
  name: "Test Card",
  cmc: 2,
  color_identity: ["U"],
  type_line: "Creature — Bird",
  oracle_text: "Flying.",
  legalities: { commander: "legal" },
  prices: {},
};

describe("LiveScryfallClient requests", () => {
  it("fetches a card by id and sends a descriptive User-Agent", async () => {
    const calls: Call[] = [];
    const client = new LiveScryfallClient({
      fetch: recordingFetch(calls, RAW_CARD),
      sleep: () => Promise.resolve(),
      now: () => 0,
    });
    const raw = await client.getCardById("p-x");
    expect(raw.name).toBe("Test Card");
    expect(calls[0]?.url).toContain("/cards/p-x");
    expect(calls[0]?.ua).toBe(USER_AGENT);
  });

  it("resolves a card by name (fuzzy/exact)", async () => {
    const calls: Call[] = [];
    const client = new LiveScryfallClient({
      fetch: recordingFetch(calls, RAW_CARD),
      sleep: () => Promise.resolve(),
      now: () => 0,
    });
    await client.getCardByName("Test Card", { exact: true });
    expect(calls[0]?.url).toContain("/cards/named?exact=Test%20Card");
  });

  it("maps a 404 to UNKNOWN_CARD", async () => {
    const client = new LiveScryfallClient({
      fetch: recordingFetch([], {}, 404),
      sleep: () => Promise.resolve(),
      now: () => 0,
    });
    await expect(client.getCardById("missing")).rejects.toMatchObject({ code: "UNKNOWN_CARD" });
  });

  it("maps other non-2xx to UPSTREAM_UNAVAILABLE", async () => {
    const client = new LiveScryfallClient({
      fetch: recordingFetch([], {}, 500),
      sleep: () => Promise.resolve(),
      now: () => 0,
    });
    await expect(client.getCardById("x")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
});

describe("LiveScryfallClient rate limiting", () => {
  it("spaces card-class requests by >=100ms", async () => {
    const sleeps: number[] = [];
    const client = new LiveScryfallClient({
      fetch: recordingFetch([], RAW_CARD),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      now: () => 1000, // virtual clock pinned (nonzero so "first request" sentinel works)
    });
    await client.getCardById("a");
    await client.getCardById("b");
    expect(sleeps).toEqual([CARD_SPACING_MS]); // first call free, second throttled
  });

  it("spaces search-class requests by >=500ms (<2 req/s)", async () => {
    const sleeps: number[] = [];
    const client = new LiveScryfallClient({
      fetch: recordingFetch([], { data: [RAW_CARD] }),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      now: () => 1000,
    });
    await client.search("t:creature");
    await client.search("t:land");
    expect(sleeps).toEqual([SEARCH_SPACING_MS]);
  });

  it("sends a User-Agent on every request", async () => {
    const calls: Call[] = [];
    const client = new LiveScryfallClient({
      fetch: recordingFetch(calls, { data: [RAW_CARD] }),
      sleep: () => Promise.resolve(),
      now: () => 0,
    });
    await client.getCardById("a");
    await client.search("t:creature");
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.ua === USER_AGENT)).toBe(true);
  });
});

describe("LiveScryfallClient face images", () => {
  const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function imageFetch(calls: Call[], headers: Record<string, string>[], status = 200): FetchFn {
    return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const sent = init?.headers as Record<string, string> | undefined;
      calls.push({ url, ua: sent?.["User-Agent"] });
      headers.push(sent ?? {});
      if (status !== 200) return Promise.resolve(new Response("{}", { status }));
      return Promise.resolve(
        new Response(PNG_HEADER, { status, headers: { "Content-Type": "image/png" } }),
      );
    }) as FetchFn;
  }

  it("requests the png image of a printing's front face by Scryfall id with the shared User-Agent", async () => {
    const calls: Call[] = [];
    const headers: Record<string, string>[] = [];
    const client = new LiveScryfallClient({
      fetch: imageFetch(calls, headers),
      sleep: () => Promise.resolve(),
      now: () => 0,
    });
    const bytes = await client.getCardImage("p-x");
    expect(Array.from(bytes)).toEqual(Array.from(PNG_HEADER));
    expect(calls[0]?.url).toBe("https://api.scryfall.com/cards/p-x?format=image&version=png");
    expect(calls[0]?.ua).toBe(USER_AGENT);
    expect(headers[0]?.Accept).toBe("image/*");
  });

  it("asks for the back face and other versions through the documented parameters", async () => {
    const calls: Call[] = [];
    const client = new LiveScryfallClient({
      fetch: imageFetch(calls, []),
      sleep: () => Promise.resolve(),
      now: () => 0,
    });
    await client.getCardImage("p-x", { face: "back" });
    await client.getCardImage("p-x", { version: "large" });
    expect(calls[0]?.url).toBe(
      "https://api.scryfall.com/cards/p-x?format=image&version=png&face=back",
    );
    expect(calls[1]?.url).toBe("https://api.scryfall.com/cards/p-x?format=image&version=large");
  });

  it("shares the card-class throttle with other card lookups", async () => {
    const sleeps: number[] = [];
    const client = new LiveScryfallClient({
      fetch: imageFetch([], []),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      now: () => 1000,
    });
    await client.getCardImage("a");
    await client.getCardImage("b");
    expect(sleeps).toEqual([CARD_SPACING_MS]);
  });

  it("maps a missing printing to UNKNOWN_CARD and a face Scryfall cannot serve to UPSTREAM_UNAVAILABLE with its status", async () => {
    const missing = new LiveScryfallClient({
      fetch: imageFetch([], [], 404),
      sleep: () => Promise.resolve(),
      now: () => 0,
    });
    await expect(missing.getCardImage("gone")).rejects.toMatchObject({ code: "UNKNOWN_CARD" });
    const noBack = new LiveScryfallClient({
      fetch: imageFetch([], [], 422),
      sleep: () => Promise.resolve(),
      now: () => 0,
    });
    await expect(noBack.getCardImage("single", { face: "back" })).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      details: { status: 422 },
    });
  });
});
