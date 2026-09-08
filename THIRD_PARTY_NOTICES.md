# Third-party notices

The project's original code is licensed under the [MIT License](LICENSE).
The third-party materials below retain their own copyrights and licenses.
These notices cover the assets committed to this repository; npm and Cargo
dependencies carry their own license files.

## Bundled GUI assets

Paths in this table are relative to `gui/app/`. Full license texts are in
[`gui/app/assets/licenses/`](gui/app/assets/licenses/).

| Material              | Included files                       | Copyright holder                                  | License                                                                                                                  |
| --------------------- | ------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Hanken Grotesk 3.013  | `assets/fonts/HankenGrotesk-*.woff2` | Copyright 2021 The Hanken Grotesk Project Authors | [SIL OFL 1.1](gui/app/assets/licenses/HankenGrotesk-OFL.txt)                                                             |
| JetBrains Mono 2.211  | `assets/fonts/JetBrainsMono-*.woff2` | Copyright 2020 The JetBrains Mono Project Authors | [SIL OFL 1.1](gui/app/assets/licenses/JetBrainsMono-OFL.txt)                                                             |
| Spectral 2.005        | `assets/fonts/Spectral-*.woff2`      | Copyright 2017 The Spectral Project Authors       | [SIL OFL 1.1](gui/app/assets/licenses/Spectral-OFL.txt)                                                                  |
| Mana 1.18.0           | `assets/fonts/mana.woff2`            | Andrew Gioia                                      | [SIL OFL 1.1](gui/app/assets/licenses/Mana-OFL.txt)                                                                      |
| Mana 1.18.0 styles    | `assets/mana.min.css`                | Andrew Gioia                                      | [MIT](gui/app/assets/licenses/Mana-MIT.txt)                                                                              |
| Keyrune 3.19.0        | `assets/fonts/keyrune.woff2`         | Copyright (c) 2019 Andrew Gioia                   | [SIL OFL 1.1](gui/app/assets/licenses/Keyrune-OFL.txt)                                                                   |
| Keyrune 3.19.0 styles | `assets/keyrune.min.css`             | Copyright (c) 2019 Andrew Gioia                   | [GPL-3.0-only](gui/app/assets/licenses/GPL-3.0-only.txt); [upstream notice](gui/app/assets/licenses/Keyrune-LICENSE.txt) |
| Iconoir SVG icons     | SVG constants in `src/icons.rs`      | Copyright (c) 2021 Luca Burgio                    | [MIT](gui/app/assets/licenses/Iconoir-MIT.txt)                                                                           |

The font family names, versions, and text-font copyrights above were verified
against the bundled WOFF2 metadata. The text fonts are Google Fonts Latin
subsets, loaded by `assets/fonts-local.css`. Their upstream projects and license
sources are [Hanken Grotesk](https://github.com/marcologous/hanken-grotesk)
([license](https://github.com/google/fonts/blob/main/ofl/hankengrotesk/OFL.txt)),
[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono)
([license](https://github.com/google/fonts/blob/main/ofl/jetbrainsmono/OFL.txt)), and
[Spectral](https://github.com/productiontype/Spectral)
([license](https://github.com/google/fonts/blob/main/ofl/spectral/OFL.txt)).

The Mana and Keyrune font binaries match the published `mana-font@1.18.0` and
`keyrune@3.19.0` packages byte for byte. Their CSS files retain the upstream
class rules; this project's modifications remove the upstream `@font-face`
blocks and add a local-source comment. Replacement font declarations are in
`assets/manabase.css`. Upstream source is available at
[Mana v1.18.0](https://github.com/andrewgioia/mana/tree/v1.18.0) and
[Keyrune v3.19.0](https://github.com/andrewgioia/keyrune/tree/v3.19.0).

Mana's [upstream license declaration](https://github.com/andrewgioia/mana/blob/v1.18.0/README.md#license)
assigns OFL 1.1 to the font and MIT to its styles. Keyrune's
[upstream license declaration](https://github.com/andrewgioia/keyrune/blob/v3.19.0/LICENSE.md)
assigns OFL 1.1 to the prepared font and GPL 3.0 to its code, including CSS.
The archived design handoff's description of these assets as “MIT-style” is
incomplete; the licenses in the table above apply.

The [Iconoir](https://github.com/iconoir-icons/iconoir) SVGs were normalized to
`1em` dimensions and `currentColor` in `src/icons.rs`. The original import did
not record an Iconoir release version. Its full upstream
[MIT license](https://github.com/iconoir-icons/iconoir/blob/7f3b481b874cdd864d81274ac0b6532403b1a0ff/LICENSE)
is preserved locally. Original Manabase logo SVGs are project assets covered
by the root MIT license.

Keep the applicable notices and license texts with redistributed copies of
these assets. The font licenses do not change the license of documents
rendered using the fonts. The GPL license for Keyrune's CSS remains attached
to that third-party material.

## Magic: The Gathering names and symbols

Magic: The Gathering names, card images, and symbols belong to Wizards of the
Coast and their respective rights holders. Mana and Keyrune's upstream notices
identify the Wizards of the Coast rights associated with their symbols.
This is an independent, unofficial project and is not endorsed by Wizards of
the Coast. The project's MIT license does not grant rights to those materials
or trademarks.

## License text sources

The three text-font license files, Iconoir license, and Keyrune notice preserve
the upstream text with trailing whitespace normalized. The Mana MIT text carries Andrew Gioia's attribution
with the standard MIT terms. The Mana and Keyrune OFL files combine their
rights-holder attribution with the full
[SIL OFL 1.1 text](https://openfontlicense.org/documents/OFL.txt).
The full [GNU GPL version 3 text](https://www.gnu.org/licenses/gpl-3.0.txt)
is included for the Keyrune styles, using the
[SPDX license list copy](https://github.com/spdx/license-list-data/blob/main/text/GPL-3.0-only.txt).
