# Security

## Report a vulnerability

Please report exploitable security issues privately through
[GitHub's vulnerability reporting form](https://github.com/AlrikOlson/mtg-edh-mcp/security/advisories/new).
Include the affected revision, environment, reproduction steps, impact, and a
minimal proof of concept. Remove credentials and private deck data.

If private reporting is unavailable, open an issue asking for a private
reporting channel without publishing exploit details. Ordinary bugs can use
the public issue tracker.

The project is pre-1.0. Security fixes target the current code on `main`;
older revisions do not have a separate maintenance commitment.

## Intended trust boundary

The default **stdio** transport runs locally as a child of an MCP client.
It opens no HTTP listener. That client can invoke the server's exposed tools
with the permissions of the local process, including deck mutations and
card-data downloads. Connect it only to clients you trust.

**Streamable HTTP is for trusted local clients.** It binds to loopback by
default and does not implement authentication, OAuth, or a public hosting
permission model. Keep it off public interfaces. An HTTP reverse proxy alone
does not make the underlying tools safe for untrusted users.

The `x-mcp-principal` header selects a deck and collection namespace. Any
caller can choose a value, so it is not proof of identity. Deployments with
multiple untrusted users need an authentication layer that determines the
principal itself, prevents callers from overriding it, and enforces
authorization and resource limits.

## Local data and external services

- Decks, snapshots and owned-card collections are stored in
  `MCP_DATA_DIR/user-data.sqlite`, with automatic pre-mutation backups under
  `MCP_DATA_DIR/backups/`; none of it is encrypted by the server. Protect and
  back up this directory using your operating system's controls.
- Several local processes of the same release may share one data directory:
  each mutation is one SQLite transaction behind a coordination lease, card
  refreshes are serialized by a separate lease, and a refresh published by one
  process is adopted by the others. Every process sharing the directory runs
  with the same local permissions; the directory is not a boundary between
  users.
- The background scheduler downloads Scryfall card updates. Set
  `MCP_AUTO_REFRESH=0` to disable automatic refresh; explicit data ingestion
  and live enrichment remain available.
- Commander Spellbook receives commander and main-deck card names for combo
  lookup, including from bracket classification. EDHREC tools query a
  community endpoint. Use local tools when deck contents must stay local.
- The standalone server requires no model-provider API key. Your MCP client
  decides which tool results reach its model provider.

Tool annotations describe behavior and are not a security boundary. Clients
should apply the user's authorization to mutations and network operations.
