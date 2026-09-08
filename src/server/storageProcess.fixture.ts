/** Offline HTTP server with IPC controls for storage acceptance fault injection. */
import { CardIndex } from "../index/index.js";
import { UserDataStore } from "../storage/userData.js";
import { startHttp } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";

const [root, indexPath] = process.argv.slice(2);
if (!root || !indexPath) throw new Error("Expected user-data root and card-index path");
let failCommit = false;
const userData = new UserDataStore(root, {
  beforeCommit: () => {
    if (failCommit) {
      failCommit = false;
      throw new Error("Injected storage commit failure");
    }
  },
});
const index = CardIndex.open(indexPath);

function send(message: Record<string, unknown>): void {
  if (!process.send) throw new Error("Expected IPC channel");
  process.send(message);
}

process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (message.type === "fail-next-commit") {
    failCommit = true;
    send({ type: "armed" });
  } else if (
    message.type === "set-roles" &&
    "deck_id" in message &&
    typeof message.deck_id === "string" &&
    "session" in message &&
    typeof message.session === "string"
  ) {
    const deck = userData.deckStore.update(
      message.deck_id,
      (current) => ({
        ...current,
        role_overrides: {
          "o-sol":
            "revised" in message && message.revised === true
              ? ["utility"]
              : ["combo_piece", "payoff"],
          "o-island": [],
        },
      }),
      message.session,
    );
    send({ type: "roles-saved", deck });
  }
});

void startHttp({
  index,
  deckStore: userData.deckStore,
  collection: userData.collection,
  snapshot: staticSnapshotProvider("2026-09-08"),
}).then(
  ({ port }) => send({ type: "ready", port }),
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
    process.disconnect?.();
  },
);
