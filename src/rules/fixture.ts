/**
 * Offline rules fixtures shared by the store and tool tests: a synthetic
 * Comprehensive Rules release shaped like the real download and a stubbed
 * fetch covering the rules page, the release, Scryfall's bulk list and the
 * gzipped rulings export. Nothing here reaches the network.
 */
import { gzipSync } from "node:zlib";
import type { FetchFn } from "../ingest/index.js";
import { RulesClient } from "./store.js";

export const FIXTURE_RULES_PAGE = "https://magic.wizards.com/en/rules";
export const FIXTURE_PINNED_URL =
  "https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt";
export const FIXTURE_DISCOVERED_URL =
  "https://media.wizards.com/2026/downloads/MagicCompRules%2020260901.txt";
export const FIXTURE_RULINGS_URL =
  "https://data.scryfall.io/rulings/rulings-20260908210031.jsonl.gz";
export const FIXTURE_RULINGS_UPDATED_AT = "2026-09-08T21:00:31.549+00:00";

/** Real-shaped rulings for Rhystic Study's Oracle identity. */
export const FIXTURE_RULING = {
  object: "ruling",
  oracle_id: "53236dd7-845a-444c-96d5-f41ed7325d8f",
  source: "wotc",
  published_at: "2023-09-01",
  comment: "Rhystic Study's triggered ability resolves before the spell that caused it to trigger.",
};
export const FIXTURE_NOTE = {
  ...FIXTURE_RULING,
  source: "scryfall",
  published_at: "2024-01-01",
  comment: "Provider note.",
};

/** A release-shaped document large enough to pass the minimum-rule validation. */
export function syntheticComprehensiveRules(effective = "August 7, 2026", rules = 1200): string {
  const lines = [
    "﻿Magic: The Gathering Comprehensive Rules",
    "",
    `These rules are effective as of ${effective}.`,
    "",
    "Contents",
    "",
    "9. Casual Variants",
    "903. Commander",
    "",
    "Glossary",
    "",
    "Credits",
    "",
    "9. Casual Variants",
    "",
    "903. Commander",
    "",
    "903.1. In the Commander variant, each deck is led by a legendary creature designated as that deck’s commander.",
    "",
    "903.3. Each deck has a legendary card designated as its commander. That card must be either (a) a creature card, (b) a Vehicle card, or (c) a Spacecraft card with one or more power/toughness boxes.",
    "",
    "903.3a Some cards have an ability that states the card can be your commander.",
    "",
    "903.5a Each deck must contain exactly 100 cards, including its commander.",
    "",
  ];
  for (let i = 10; i < 10 + rules; i += 1) {
    lines.push(`903.${i}. Synthetic commander rule number ${i}.`, "");
  }
  lines.push(
    "Glossary",
    "",
    "Commander",
    "A casual variant in which each deck is led by a legendary card. See rule 903.",
    "",
    "Commander Tax",
    "An informal term for the additional cost to cast a commander from the command zone.",
    "",
    "Credits",
    "",
  );
  return lines.join("\r\n");
}

export interface RulesFixtureOptions {
  rulesPage?: "ok" | "fail" | "no-link";
  rulesText?: string | "fail";
  rulingsUpdatedAt?: string;
  rulingsBody?: Buffer | "fail";
  bulkList?: "fail";
}

export interface RulesFixture {
  client: RulesClient;
  fetch: FetchFn;
  /** Every URL requested, in order. */
  requested: string[];
}

/** A rules client over stubbed fetch; the returned list records every request. */
export function rulesFixture(options: RulesFixtureOptions = {}): RulesFixture {
  const requested: string[] = [];
  const rulesText = options.rulesText ?? syntheticComprehensiveRules();
  const updatedAt = options.rulingsUpdatedAt ?? FIXTURE_RULINGS_UPDATED_AT;
  const rulingsBody =
    options.rulingsBody ??
    gzipSync(
      Buffer.from(`${JSON.stringify(FIXTURE_RULING)}\n${JSON.stringify(FIXTURE_NOTE)}\n`, "utf8"),
    );
  const fetchFn: FetchFn = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === FIXTURE_RULES_PAGE) {
      if (options.rulesPage === "fail") throw new Error("rules page unreachable");
      if (options.rulesPage === "no-link") return new Response("<html>no links here</html>");
      return new Response(
        `<html><a href="https://media.wizards.com/2026/downloads/MagicCompRules 20260901.txt">TXT</a></html>`,
      );
    }
    if (
      url === FIXTURE_DISCOVERED_URL ||
      url === FIXTURE_PINNED_URL ||
      url.endsWith("explicit.txt")
    ) {
      if (rulesText === "fail") throw new Error("rules download failed");
      return new Response(Buffer.from(rulesText, "utf8"));
    }
    if (url.endsWith("/bulk-data")) {
      if (options.bulkList === "fail") throw new Error("bulk list unreachable");
      return Response.json({
        data: [
          { type: "oracle_cards", updated_at: updatedAt, jsonl_download_uri: "https://x/oracle" },
          { type: "rulings", updated_at: updatedAt, jsonl_download_uri: FIXTURE_RULINGS_URL },
        ],
      });
    }
    if (url === FIXTURE_RULINGS_URL) {
      if (rulingsBody === "fail") throw new Error("rulings download failed");
      return new Response(new Uint8Array(rulingsBody));
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const client = new RulesClient({ fetch: fetchFn, sleep: async () => {}, now: () => 0 });
  return { client, fetch: fetchFn, requested };
}
