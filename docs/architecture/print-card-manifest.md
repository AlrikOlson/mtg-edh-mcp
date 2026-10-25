# Print card manifest: the physical cards a saved deck needs

Accepted for `print-card-manifest` under the [engine charter](../ENGINE-CHARTER.md). It is the first unit of the Proxy Order Helper (the `print_*` tools) that the roadmap refresh `think:440` planned as first-priority Commander-workshop work at the user's direction. The plan and grounding are `think:442`; the closing finding is recorded on the chunk. Native Magistr records hold execution status.

## What was delivered

`src/print/manifest.ts` exports `buildPrintManifest(deck, lookup, options?)`, a pure function with no storage and no network access. It turns a `Deck` (as `deck_get` returns it) and a `CardLookup` (the index's `getCard`) into either a manifest or a conflict:

| Concern               | Behaviour                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Order and quantities  | Commanders first in command-zone order (`source: "commander"`), then every library entry expanded to `qty` physical cards in deck order (`source: "library"`); slots are 1-based and unique across cards and extras                                                            |
| Commanders            | Each commander is printed exactly once from `commanders[]`; it is never added again from the 99. A commander that also appears as a library entry keeps both copies and gets a `commander_in_library` attention item                                                           |
| Extras                | A declared companion is an extra (`extras.companion`, `source: "companion"`), outside the count. Tokens come from the catalog's related cards with component `token`, offered once each with the deck cards that name them; `selected_tokens` marks the chosen ones            |
| Faces                 | `front` and `back` name catalog faces by `face_index` and `source_path`, never by an image. Only `transform` and `modal` relationships carry a back face on the same physical card; split, adventure, flip, prepare and meld print one face                                    |
| Pin and conflict      | The manifest records `deck_id`, `deck_name`, `version` and `data_snapshot`. With `options.pinned`, a deck whose id, version or (when pinned) snapshot differs returns `{ kind: "conflict" }` naming the reason, the pin and the live identity; nothing is rebuilt              |
| Never omit or replace | Illegal entries are printed as saved (`illegal: true`) with an `illegal_card` item; an oracle id without a catalog record keeps its slot under its id with `unknown_card` or `unknown_companion`; a two-sided card without catalog faces prints its front with `missing_faces` |
| Total                 | `total = sum(qty) + commanders.length`; extras are excluded, so the printer's order quantity is read, not recounted                                                                                                                                                            |

## Ownership and reuse review

- **One owner for "what gets printed".** The manifest is the only place the deck is expanded into physical cards. The job store (`print-job-store`) will pin and persist a manifest; the image selector (`print-image-selector`) resolves images per `PrintFace`; the project file (`print-project-file`) writes slots from it. None of them recount the deck.
- **Reads existing owners, adds none.** Deck identity and versions stay with the deck store; faces, layouts and related cards stay with the catalog mapper (`src/index/map.ts`, see the [face inventory](mcp-catalog-face-inventory.md)); the lookup is the existing `CardLookup` type exported by `src/validate`, re-exported here rather than declared a fifth time.
- **Why faces, not images.** The catalog keeps printings by `scryfall_id` but no image bytes or URLs. The manifest therefore identifies faces structurally so the selector can choose a printing and fetch its image without the manifest knowing how.
- **Why a conflict result, not a rebuild.** A reviewed order must match what the user saw. The later tools carry the pin from the stored job; a moved deck is reported with its reason so the user can re-prepare on purpose.
- **Left for their owners.** Printing choice, image fetch and bleed (`print-image-selector`); durable jobs and the user's print preset (`print-job-store`); the MakePlayingCards project document and the filler (`print-project-file`, `print-mpc-filler`); MCP exposure (`print-mcp-tools`). Token extras are offered here but selected and persisted later.
- **Overlap.** None added. No engine, catalog or deck-store change.

## Evidence

Scenarios were written first in `src/print/manifest.test.ts` and failed on the missing module before the owner existed: repeated cards expand in deck order after the commander; transform and modal cards carry both faces while a split card stays single; a single commander prints once and never again from the library; partner and background commanders print once each in command-zone order; a commander listed in the library is flagged, not dropped; a companion is an extra outside the count; tokens are offered once each and selectable by id with an unknown selection flagged; the pin is recorded and version, deck id and snapshot mismatches each report their reason; illegal and unknown cards stay with attention items; a faceless two-sided record prints its front with `missing_faces`; an unknown commander and companion are flagged; the total is quantities plus commanders with the card list matching it.

Recorded gates: TypeScript typecheck, the print test file under vitest, ESLint and Prettier.
