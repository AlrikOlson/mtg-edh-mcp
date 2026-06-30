// Optional, session-scoped card collection (spec §12). Off-by-default ownership
// awareness: card_search can filter to the owned set, exposed via collection://.
export { CollectionStore, DEFAULT_SESSION } from "./collectionStore.js";
