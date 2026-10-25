# Proxy Order Helper: the `print_*` tools

The Proxy Order Helper turns a saved Commander deck into a MakePlayingCards order the user reviews and finishes themselves. The roadmap refresh `think:440` planned it as first-priority Commander-workshop work at the user's direction, as our own TypeScript implementation rather than a launch of the community desktop tool. This document is the umbrella for the units: it records the decisions that cut across them (dependencies, external services, the printer template and the legal note). Each unit keeps its own receipt.

| Unit                                                           | Owner                                                        | Receipt                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| Which physical cards a deck needs                              | `src/print/manifest.ts`                                      | [print-card-manifest](print-card-manifest.md)   |
| Durable jobs and the user's print preset                       | `src/print/jobStore.ts` (user-data schema version 2)         | [print-job-store](print-job-store.md)           |
| Image choice, fetch, cache and preparation                     | `src/print/imageSelector.ts`, `imagePrep.ts`, `community.ts` | [print-image-selector](print-image-selector.md) |
| The project document and the MPC Autofill `cards.xml`          | pending (`print-project-file`)                               |                                                 |
| The supervised browser filler                                  | pending (`print-mpc-filler`)                                 |                                                 |
| `print_prepare`, `print_update`, `print_start`, `print_status` | pending (`print-mcp-tools`)                                  |                                                 |

## Printer template

MakePlayingCards' poker card (2.5 x 3.5 inches) wants uploads of 822 x 1122 pixels at 300 DPI (makeplayingcards.com/faq-photo.aspx, read 2026-10-25). 36 px are cut from every side, leaving the 750 x 1050 trimmed card, and a further 36 px inside the cut is the safe area for text. Accepted formats are JPG, BMP, TIF, PNG and GIF. Scryfall's `png` image version is a 745 x 1040 trimmed card with transparent rounded corners and no bleed, so catalog images must gain bleed before upload. `src/print/imagePrep.ts` owns these constants; no other module repeats them.

## Dependency decision: image processing with sharp

Decided in `print-image-selector` (`think:446`).

| Question          | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency        | `sharp` 0.35.5 (libvips 8.18.7), a runtime dependency in `package.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Why not pure JS   | `jimp` (3.3 MB, pure JS) and `pngjs` plus hand-written resampling were the alternatives. The print path decodes user-supplied JPEG, PNG, WebP, TIFF and GIF files, resamples ~100 faces per deck to 300 DPI and must flatten alpha and extend borders; libvips does this with lanczos3 resampling in milliseconds per face and reads every format MakePlayingCards accepts. The repository already ships one native addon (`better-sqlite3`), so a second prebuilt native dependency adds no new class of install risk |
| Native footprint  | On this machine (darwin-arm64): `sharp` 1.0 MB, `@img/sharp-darwin-arm64` 0.3 MB, `@img/sharp-libvips-darwin-arm64` 17 MB. Each platform downloads only its own `@img/*` pair; the lock file lists all platforms as optional dependencies                                                                                                                                                                                                                                                                              |
| Install behaviour | Prebuilt binaries arrive through `optionalDependencies`, so package managers must keep optional dependencies enabled (the default). Requires Node 20.9 or later (Node-API v9); this project pins Node 22/24/26. Platforms without a prebuilt binary can install `@img/sharp-wasm32` for the WebAssembly build, or build from source with a C++17 toolchain and node-gyp. `tsup.config.ts` lists `sharp` as external next to `better-sqlite3` so it is never bundled                                                    |
| Where it is used  | Only `src/print/imagePrep.ts` imports it. The MCP server starts without exercising it; a load failure surfaces when a `print_*` image step runs                                                                                                                                                                                                                                                                                                                                                                        |

## External services

- **Scryfall** is the only image source the catalog can vouch for: the catalog's `printings[]` carry Scryfall ids, and `GET /cards/:id?format=image&version=png[&face=back]` redirects to the face image (docs/api/cards/id and docs/api/images, read 2026-10-25). Every request goes through the existing `LiveScryfallClient`, so the card-class throttle, the single project User-Agent and the error mapping are shared with the live card fallback.
- **MPC Autofill community backend** is an optional secondary source. It is undocumented; its shapes were read from the project's frontend client (`frontend/src/store/api.ts`, `frontend/src/common/schema_types.ts`, 2026-10-25) and are pinned as recorded fixtures under `src/print/fixtures/`. Images are Google Drive files; the desktop tool downloads them through the authenticated Drive API, and this project uses the anonymous `uc?export=download` form and treats any non-image answer as the service being unavailable. The backend URL is configuration, never a default, and the selector only accepts a community image when exactly one carries the card's exact name.
- **MakePlayingCards** itself is reached only by the pending filler, through a persistent browser profile the user signs into.

## Legal note

Wizards of the Coast's Fan Content Policy does not cover proxies and some print services (The Game Crafter, for one) refuse Magic cards without written permission. The user has stated personal use and asked that the helper not gate on it; this is recorded as a note, not enforced in code.

## Manual checkpoints

Evidence from manual runs against the real printer belongs here as the later units land (`print-project-file` names a checkpoint run with MPC Autofill 4.7 against the exported `cards.xml`). None recorded yet.
