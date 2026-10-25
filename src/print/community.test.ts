import { describe, expect, it } from "vitest";
import type { FetchFn } from "../ingest/index.js";
import { USER_AGENT } from "../types/index.js";
import { GOOGLE_DRIVE_DOWNLOAD_URL, MpcAutofillCommunitySource } from "./community.js";
import cardsFixture from "./fixtures/mpcAutofillCards.json" with { type: "json" };
import searchFixture from "./fixtures/mpcAutofillEditorSearch.json" with { type: "json" };
import sourcesFixture from "./fixtures/mpcAutofillSources.json" with { type: "json" };

interface Call {
  url: string;
  method: string;
  ua: string | undefined;
  body: unknown;
}

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE = "https://backend.example.invalid";

/** Routes the recorded fixtures by path; everything else is a 404 JSON error. */
function fixtureFetch(
  calls: Call[],
  overrides: Partial<Record<string, () => Response>> = {},
): FetchFn {
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url,
      method: init?.method ?? "GET",
      ua: headers?.["User-Agent"],
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const override = overrides[path];
    if (override) return Promise.resolve(override());
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (path === "/2/sources/") return Promise.resolve(json(sourcesFixture));
    if (path === "/3/editorSearch/") {
      const sent = (init?.body && JSON.parse(String(init.body))) as {
        queries: Record<string, unknown>;
      };
      const [key] = Object.keys(sent.queries);
      const ids =
        key && key in searchFixture.results ? searchFixture.results[key as "sol ring"] : [];
      return Promise.resolve(json({ results: key ? { [key]: ids } : {} }));
    }
    if (path === "/2/cards/") return Promise.resolve(json(cardsFixture));
    if (url.startsWith("https://drive.google.com/uc")) {
      return Promise.resolve(
        new Response(PNG_HEADER, { status: 200, headers: { "Content-Type": "image/png" } }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ name: "NotFound", message: "no route" }), { status: 404 }),
    );
  }) as FetchFn;
}

function source(fetch: FetchFn): MpcAutofillCommunitySource {
  return new MpcAutofillCommunitySource({
    baseUrl: BASE,
    fetch,
    sleep: () => Promise.resolve(),
    now: () => 0,
  });
}

describe("MpcAutofillCommunitySource search", () => {
  it("loads the sources once, posts the sanitised query to 3/editorSearch and hydrates the ids through 2/cards", async () => {
    const calls: Call[] = [];
    const community = source(fixtureFetch(calls));
    const candidates = await community.search("Sol Ring");

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", `${BASE}/2/sources/`],
      ["POST", `${BASE}/3/editorSearch/`],
      ["POST", `${BASE}/2/cards/`],
    ]);
    expect(calls.every((c) => c.ua === USER_AGENT)).toBe(true);
    expect(calls[1]?.body).toMatchObject({
      queries: { "sol ring": { query: "sol ring", cardType: "CARD" } },
      searchSettings: {
        searchTypeSettings: { fuzzySearch: false, filterCardbacks: false },
        sourceSettings: {
          sources: [
            [1, true],
            [2, true],
          ],
        },
      },
    });
    expect(calls[2]?.body).toEqual({
      cardIdentifiers: ["1AbCdEfGhIjKlMnOpQrStUvWxYz0123456", "1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543"],
    });
    expect(candidates).toEqual([
      {
        id: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456",
        name: "Sol Ring",
        source: "Chilli_Axe's Proxies",
        dpi: 800,
        size: 4821337,
        extension: "png",
      },
      {
        id: "1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543",
        name: "Sol Ring (Extended)",
        source: "Other Drive",
        dpi: 600,
        size: 3100000,
        extension: "jpg",
      },
    ]);

    await community.search("Sol Ring");
    expect(calls.filter((c) => c.url.endsWith("/2/sources/"))).toHaveLength(1);
  });

  it("returns no candidates, without a cards request, when the search has no hits", async () => {
    const calls: Call[] = [];
    const community = source(fixtureFetch(calls));
    expect(await community.search("Not A Card")).toEqual([]);
    expect(calls.some((c) => c.url.endsWith("/2/cards/"))).toBe(false);
  });

  it("reports a failing backend as UPSTREAM_UNAVAILABLE", async () => {
    const down = source(
      fixtureFetch([], {
        "/2/sources/": () => new Response("gateway", { status: 502 }),
      }),
    );
    await expect(down.search("Sol Ring")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });

    const offline = source((() => Promise.reject(new Error("ECONNREFUSED"))) as FetchFn);
    await expect(offline.search("Sol Ring")).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });

  it("refuses a response that does not have the recorded shape", async () => {
    const odd = source(
      fixtureFetch([], {
        "/2/sources/": () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
      }),
    );
    await expect(odd.search("Sol Ring")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
});

describe("MpcAutofillCommunitySource download", () => {
  it("fetches the Google Drive file anonymously with the shared User-Agent", async () => {
    const calls: Call[] = [];
    const community = source(fixtureFetch(calls));
    const bytes = await community.download("1AbCdEfGhIjKlMnOpQrStUvWxYz0123456");
    expect(Array.from(bytes)).toEqual(Array.from(PNG_HEADER));
    expect(calls[0]?.url).toBe(GOOGLE_DRIVE_DOWNLOAD_URL("1AbCdEfGhIjKlMnOpQrStUvWxYz0123456"));
    expect(calls[0]?.url).toBe(
      "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrStUvWxYz0123456",
    );
    expect(calls[0]?.ua).toBe(USER_AGENT);
  });

  it("treats an HTML answer (a sign-in or quota page) as the service being unavailable", async () => {
    const community = source(
      fixtureFetch([], {
        "https://drive.google.com/uc?export=download&id=blocked": () =>
          new Response("<html>Sign in</html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      }),
    );
    await expect(community.download("blocked")).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });
});
