/**
 * The single descriptive User-Agent sent on every outbound request (spec §11,
 * Scryfall Fan Content policy: identify the app, version, and a contact URL).
 *
 * Defined in the types layer so both the ingestion clients (Scryfall bulk + live)
 * and the meta enrichment clients (EDHREC, Commander Spellbook, Game Changers)
 * share one value — there is exactly one User-Agent string in the codebase.
 */
export const USER_AGENT =
  "mtg-edh-mcp/0.1.0 (+https://github.com/alrik/mtg-edh-mcp; Scryfall Fan Content)";
