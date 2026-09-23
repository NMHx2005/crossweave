// Sidecar entry point for the Deck × crossweave bridge.
// Not auto-started by the daemon — a Deck extension or a `cw deck-bridge` CLI
// constructs DeckBridge via this module. Exists so the bridge HAS a call site
// beyond its test, closing Horizon A gap #1.
export { DeckBridge } from './bridge.js';
export type { DeckBridgeOptions, WorktreeCard, WorktreeCardColour } from './bridge.js';
