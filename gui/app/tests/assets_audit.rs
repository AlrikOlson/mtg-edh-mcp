//! Mechanical audit of the vendored Manabase assets: everything the app links
//! must exist, carry the token contract, and load with ZERO network deps
//! (self-hosted fonts, no CDN @imports). Guards the gui-design-tokens
//! acceptance criteria against regressions.

use std::path::PathBuf;

fn asset(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("assets")
        .join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("missing asset {rel}: {e}"))
}

fn asset_exists(rel: &str) -> bool {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("assets")
        .join(rel)
        .exists()
}

#[test]
fn stylesheets_exist_and_are_offline() {
    for sheet in [
        "fonts-local.css",
        "mana.min.css",
        "keyrune.min.css",
        "manabase.css",
        "components.css",
        "screens.css",
        "gallery.css",
    ] {
        let css = asset(sheet);
        assert!(
            !css.contains("@import url(\"http") && !css.contains("@import url('http"),
            "{sheet} still has a CDN @import"
        );
        assert!(
            !css.contains("url(\"https://") && !css.contains("url('https://"),
            "{sheet} still references a remote url()"
        );
    }
}

#[test]
fn tokens_are_intact() {
    let css = asset("manabase.css");
    // The signature tokens from the handoff (spot-check, dark + light + WUBRG).
    for token in [
        "--gold-400: #e3ad4c",
        "--accent: var(--gold-400)",
        "--mtg-w",
        "--mtg-u",
        "--mtg-b",
        "--mtg-r",
        "--mtg-g",
        "--surface-canvas",
        "--type-data",
        "--ring-focus",
        "data-theme=\"light\"",
    ] {
        assert!(css.contains(token), "manabase.css lost token: {token}");
    }
}

#[test]
fn fonts_are_self_hosted() {
    for font in [
        "fonts/mana.woff2",
        "fonts/keyrune.woff2",
        "fonts/Spectral-400.woff2",
        "fonts/Spectral-600.woff2",
        "fonts/HankenGrotesk-400.woff2",
        "fonts/HankenGrotesk-700.woff2",
        "fonts/JetBrainsMono-400.woff2",
        "fonts/JetBrainsMono-700.woff2",
    ] {
        assert!(asset_exists(font), "missing self-hosted font {font}");
    }
    // Every @font-face src in the CSS layer must resolve to a shipped file.
    let faces = format!("{}{}", asset("fonts-local.css"), asset("manabase.css"));
    for cap in faces.split("url(\"").skip(1) {
        let Some(url) = cap.split('"').next() else {
            continue;
        };
        if url.ends_with(".woff2") {
            assert!(asset_exists(url), "@font-face points at missing file {url}");
        }
    }
}

#[test]
fn icon_font_class_rules_survive() {
    // The per-symbol content rules must still exist after the @font-face strip
    // (they're what make `<i class="ms ms-r">` render a glyph at all).
    let mana = asset("mana.min.css");
    for class in [".ms-w", ".ms-u", ".ms-b", ".ms-r", ".ms-g", ".ms-cost"] {
        assert!(mana.contains(class), "mana.min.css lost {class}");
    }
    // Minified rules would be `@font-face{`; the header comment may mention
    // the phrase, so match the rule form only.
    assert!(
        !mana.contains("@font-face{"),
        "mana.min.css @font-face rules should be stripped"
    );
}

#[test]
fn logos_ship() {
    for logo in [
        "logo/manabase-mark.svg",
        "logo/manabase-mark-mono.svg",
        "logo/favicon.svg",
    ] {
        assert!(asset_exists(logo), "missing {logo}");
    }
}
