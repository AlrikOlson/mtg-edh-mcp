//! mtg-edh-mcp desktop GUI — Phase G scaffold.
//!
//! This is the minimal app shell: a Dioxus 0.7 desktop window. The real screens
//! (Card / Deck / Collection / Analysis / Meta) and the rmcp MCP client that
//! talks to the TypeScript engine over Streamable HTTP land in later GUI chunks
//! (gui-mcp-client, gui-app-shell, …). See ../../docs/adr/0001-gui-architecture.md.

use dioxus::prelude::*;

fn main() {
    dioxus::launch(App);
}

#[component]
fn App() -> Element {
    rsx! {
        main {
            h1 { "mtg-edh-mcp" }
            p { "Phase G scaffold — Dioxus 0.7 desktop. The engine stays in TypeScript; this app will speak MCP to it." }
        }
    }
}
