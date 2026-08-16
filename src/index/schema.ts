/**
 * Local card index schema (spec §5A/§9).
 *
 * Strategy: a `cards` row keeps the full §4 Card as a JSON blob (cheap full-card
 * retrieval) plus projected/indexed columns the query evaluator (p2) filters on.
 * Name/oracle-text search is a standalone FTS5 table. Printings/prices from
 * default_cards live in a joined `printings` table.
 */

export const SCHEMA_SQL = `
CREATE TABLE cards (
  oracle_id            TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  mv                   REAL NOT NULL,
  type_line            TEXT NOT NULL,
  -- Sorted WUBRG letters, e.g. "BG"; "" for colorless. (color identity)
  color_identity       TEXT NOT NULL,
  -- Sorted WUBRG face colors; "" for colorless.
  colors               TEXT NOT NULL DEFAULT '',
  legalities_commander TEXT NOT NULL,
  oracle_text          TEXT NOT NULL,
  -- Space-joined lowercased keywords for LIKE filtering.
  keywords             TEXT NOT NULL DEFAULT '',
  -- Numeric power/toughness/loyalty; NULL when non-numeric (e.g. "*") or absent.
  pow                  REAL,
  tou                  REAL,
  loy                  REAL,
  -- Representative (oracle-level) prices; NULL when unpriced.
  price_usd            REAL,
  price_eur            REAL,
  price_tix            REAL,
  is_commander_eligible INTEGER NOT NULL DEFAULT 0,
  -- On WotC's official Game Changers list (Scryfall bulk game_changer flag).
  is_game_changer      INTEGER NOT NULL DEFAULT 0,
  -- The full §4 Card object (printings filled at read time from the join).
  card                 TEXT NOT NULL
);

CREATE INDEX idx_cards_ci ON cards(color_identity);
CREATE INDEX idx_cards_mv ON cards(mv);
CREATE INDEX idx_cards_type ON cards(type_line);
CREATE INDEX idx_cards_legal_cmdr ON cards(legalities_commander);
CREATE INDEX idx_cards_colors ON cards(colors);
CREATE INDEX idx_cards_pow ON cards(pow);
CREATE INDEX idx_cards_tou ON cards(tou);

CREATE VIRTUAL TABLE cards_fts USING fts5(oracle_id UNINDEXED, name, oracle_text);

CREATE TABLE printings (
  oracle_id        TEXT NOT NULL,
  scryfall_id      TEXT NOT NULL,
  set_code         TEXT,
  set_name         TEXT,
  collector_number TEXT,
  rarity           TEXT,
  prices           TEXT,
  released_at      TEXT,
  PRIMARY KEY (oracle_id, scryfall_id)
);

CREATE INDEX idx_printings_oracle ON printings(oracle_id);
-- Printing-level query predicates (set:/rarity:/year) filter on these.
CREATE INDEX idx_printings_set ON printings(set_code);
CREATE INDEX idx_printings_rarity ON printings(rarity);
CREATE INDEX idx_printings_released ON printings(released_at);
`;

/** Secondary index names asserted by the index smoke test (acceptance §9). */
export const SECONDARY_INDEXES = [
  "idx_cards_ci",
  "idx_cards_mv",
  "idx_cards_type",
  "idx_cards_legal_cmdr",
] as const;
