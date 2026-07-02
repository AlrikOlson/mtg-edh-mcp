//! mtg-edh-mcp GUI — Dioxus 0.7 desktop app.
//!
//! The Manabase app shell (nav rail + top bar + signal-routed screens) frames
//! the object screens; the component gallery remains a rail destination as the
//! scrutiny regression surface. Styling comes entirely from the vendored
//! Manabase design system (gui/design/inbox/design_handoff_dioxus).

use dioxus::prelude::*;

mod browse;
mod collection;
mod ds;
mod gallery;
mod icons;
mod insights;
mod shell;
mod state;
mod workbench;

// The whole assets directory ships as ONE folder asset: manganis does not
// rewrite url() references inside CSS (dioxus#3325), so the fonts must stay
// siblings of the stylesheets under their original relative paths
// ("fonts/mana.woff2" etc.). A folder asset preserves that structure.
static ASSETS: Asset = asset!("/assets");

/// The Manabase mark (WUBRG color pie ringed in gold).
pub fn logo_url() -> String {
    format!("{ASSETS}/logo/manabase-mark.svg")
}

fn main() {
    dioxus::launch(App);
}

#[component]
fn App() -> Element {
    // Load order matters: font faces first, then the icon-font class rules
    // (linked DIRECTLY, never via nested @import — handoff gotcha #1), then
    // tokens, then the component/screen contracts, then gallery chrome.
    let sheets = [
        "fonts-local.css",
        "mana.min.css",
        "keyrune.min.css",
        "manabase.css",
        "components.css",
        "screens.css",
        "appshell.css",
        "browse.css",
        "deckeditor.css",
        "insights.css",
        "collection.css",
        "gallery.css",
    ];
    rsx! {
        for sheet in sheets {
            document::Stylesheet { href: format!("{ASSETS}/{sheet}") }
        }
        shell::AppShell {}
    }
}
