/**
 * Color primitives (spec §4 / §6).
 *
 * The server trusts Scryfall's computed `color_identity` rather than re-deriving
 * it from mana costs (§6), so these types mirror Scryfall's representation.
 */

/** The five WUBRG mana colors, as used by Scryfall `colors` / `color_identity`. */
export type Color = "W" | "U" | "B" | "R" | "G";

/**
 * A Scryfall color-identity array. May be empty for a colorless card; Scryfall
 * never includes a "C" sentinel here.
 */
export type ColorIdentity = readonly Color[];

/**
 * The lean color-identity representation used inside `CardRef` (§4), where a
 * colorless card is expressed as `["C"]` rather than an empty array.
 */
export type RefColorIdentity = readonly (Color | "C")[];
