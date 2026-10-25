# Printing a deck

The `print_*` tools turn one saved deck version into a MakePlayingCards order the user reviews and pays for themselves. Four steps: prepare, review, start, finish. Every job is private to the caller, pinned to the deck version it was prepared from, and survives restarts.

## Prepare

`print_prepare` takes a `deck_id` (pass the current `expected_version` when the user reviewed a specific version). It counts the physical cards (each commander once, library quantities preserved, a companion as an extra, both faces of a transform or modal card on one card), picks a printing for every face from the saved preset or the newest catalog printing, fetches and prepares the images, and returns the job view. Preparing the same deck version again returns the open job instead of a second one.

```text
print_prepare {"deck_id":"DECK_ID"}
print_prepare {"deck_id":"DECK_ID","expected_version":3,"stock":"(S33) Superior Smooth","foil":false}
```

Read `total`, `cards[]` (slot, name, `front` and `back` image refs, `front_ready`, `back_ready`), `card_back`, `settings` and `attention[]`. `tokens[]` lists tokens the deck's cards create; they are information only and are not printed. `complete:true` means every face has a print-ready file.

## Review

Each `attention[]` item names what blocks the order: `no_printing` or `no_image` (a face without any catalog image), `printing_mismatch` (a chosen printing that is not one of that card's printings), `undersized_image` or `unreadable_file` (a user file), `source_unavailable` (Scryfall could not be reached; retry later), `illegal_card` and `commander_in_library` (printed as saved; information only). Resolve the blocking ones with `print_update`, which changes artwork or settings and resolves the images again:

```text
print_update {"job_id":"00000000-0000-4000-8000-000000000000","images":{"7":{"front":{"kind":"printing","scryfall_id":"SCRYFALL_ID"}}}}
print_update {"job_id":"00000000-0000-4000-8000-000000000000","images":{"7":{"front":{"kind":"file","path":"ABSOLUTE_PATH_TO_IMAGE"}}},"card_back":{"kind":"file","path":"ABSOLUTE_PATH_TO_BACK"},"remember":true}
```

Slot keys are the `slot` numbers from `cards[]`; a face set to `null` clears that choice and a slot set to `null` clears both. A user-supplied file must already be a print-ready card with bleed (at least 822 x 1122 pixels); catalog printings get bleed added. `remember:true` saves the job's settings and the changed slots' artwork as the preset for later jobs. A job that has started answers `PRINT_JOB_LOCKED`; prepare a new one from the current deck version instead. Use `card_printings` to find a card's printings and their Scryfall ids.

## Start

When `attention[]` is empty, `print_start` writes the project file and starts the browser fill in the background, answering `status:"starting"` right away.

```text
print_start {"job_id":"00000000-0000-4000-8000-000000000000"}
```

Before starting, tell the user what will happen: a browser window opens on makeplayingcards.com using a profile kept under the server's data directory; the first time, they sign in by hand in that window (no credential ever passes through the tools), and the login stays for later orders. The filler creates a project named after the job, uploads every image once, fills every slot and the card back, saves the project to their account, and stops on the printer's preview page. It never adds to the cart or pays.

Refusals: `PRINT_ATTENTION` (faces still without images; the list is returned), `PRINT_FILLER_UNAVAILABLE` (the `attention[]` item names the install command, usually `npx playwright install chromium`, or that the worker bundle is missing), `PRINT_FILLER_BUSY` (a browser from an earlier fill is still open; the user closes it or finishes checkout first), `PRINT_ORDER_TOO_LARGE` (over the printer's largest project).

## Finish

Poll `print_status` with the `job_id` until `status` is `filled`, `failed` or `cancelled`; `progress` carries `slots_filled` and `slots_total` meanwhile. Without a `job_id` it lists the caller's jobs.

```text
print_status {"job_id":"00000000-0000-4000-8000-000000000000"}
print_status {}
```

On `filled`, the browser is open on the preview page: the user checks the preview and the price, adds the project to the cart and pays there; `fill.ssid` and `fill.review_url` identify the saved project. On `failed`, `failure.step` and `failure.message` say where it stopped, `evidence.screenshot` and `evidence.fill_state` point at what the filler left in the job directory, and `fill.instructions` say how to continue; running `print_start` again resumes the same saved project and fills only the empty slots. `evidence.cards_xml` is an MPC Autofill `cards.xml` for finishing with the community desktop tool instead.

`drift` compares the pinned deck version with the live deck. `moved_on` means the deck changed after the job was prepared; the job keeps the reviewed contents, so prepare again to print the current version. The user has stated this is for personal use; the tools do not gate on it, and the print service's own terms apply.
