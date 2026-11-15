# Mockup notes

Static mockup of the main screen, realising [`docs/DESIGN.md`](../DESIGN.md). Open
`index.html` from disk (needs a connection for the two fonts, d3-geo and the coastlines).

| File                                         | What it is                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`, `mockup.css`, `mockup.js`      | The HUD. States by URL hash, see below                                                                                                  |
| `globe.js`, `data/cities.js`                 | Stand-in globe on a 2D canvas. Not the engine: synthetic traffic over real coastlines and city positions (Natural Earth, public domain) |
| `icons.js`, `icons/*.svg`, `build-icons.mjs` | Icon family. `icons.js` is the source; `node docs/mockup/build-icons.mjs` rewrites the files                                            |
| `icons.html`                                 | Specimen sheet: icons at 16 and 48px, wordmark, favicon, the four halo rings                                                            |
| `wordmark.svg`, `favicon.svg`                | Wordmark (type outlined, no font needed) and favicon                                                                                    |
| `shots.mjs`, `check.mjs`                     | Screenshots into `.screenshots/mockup/`; font-axis, tabular-numeral and measured-contrast checks                                        |

States: `#default`, `#selected`, `#selected-full` (phone sheet at its full stop), `#search`,
`#scrubbed`, `#idle`, `#offline`. `?shot` freezes the clock and the idle timer. Also live:
click the ringed aircraft, `/`, `Esc`, arrow keys in search, drag or arrow-key the tape,
toggle dock rows, wait 8 s for idle.

`cd apps/web && node ../../docs/mockup/shots.mjs --crops` and `node ../../docs/mockup/check.mjs`.

## Tokens

All colour and type tokens are as specified. Added:

| Token        | Value                                      | Use                                                                           |
| ------------ | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `--wash`     | `rgb(170 205 255 / 0.07)`                  | Hover fill on rows and controls, and behind the keyboard-active search result |
| `--on-space` | `0 0 2px #000, 0 0 12px rgb(0 0 0 / 0.85)` | Text-shadow for text set straight on space                                    |
| `--top`      | `72px`                                     | Top of dock and panel: 16 margin + 40 top row + 16                            |

Type roles, as computed in the browser: Name Archivo 22/26 300 at 118%; Title 15/20 500;
Body 13/19 400; Label 12/16 500 at 82%; Micro 11/14 500 at 82%; Readout Martian Mono 20/24
200 at 80%; Data Martian Mono 12/16 300 at 80%. Width is set with `font-stretch`, which
drives the `wdth` axis on both families (measured: Archivo runs 258 to 479px across 62 to
125 for the same string; Martian Mono 144 to 180px across 75 to 112.5). Martian Mono digits,
comma, colon and point share one advance. Archivo needs `font-variant-numeric: tabular-nums`
(set on `body`).

## Measurements

**Top row.** 40px tall at 16px from the top. Wordmark: 20px ring, 10px gap, Name type with
0.04em tracking. Clock and count: Data plus Micro unit, 20px apart, right edge on the margin.

**Dock.** 208 wide, 6px vertical padding, no horizontal padding. Row: 32 tall (40 on coarse
pointers), inset 6px each side with a 6px radius so the focus outline stays inside the glass,
10px inner padding, grid `3px 1fr auto` with a 12px gap. Lamp 3 x 14, radius 1, its left
edge 17px from the dock's outer edge. Name in Label, count in Data, right-aligned.

| State                  | Lamp                                              | Name        | Right column                                                        |
| ---------------------- | ------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| On                     | Solid accent, `0 0 6px` glow at 50%               | `--ink`     | Count                                                               |
| Off                    | Hollow: 1px inset `--ink-faint`, no colour        | `--ink-dim` | Empty                                                               |
| Degraded               | Accent in three 3px segments, 2.5px gaps, no glow | `--ink`     | Count, with a Micro note in `--warn` beneath                        |
| Needs a key            | Hollow                                            | `--ink-dim` | "Needs a key" in Micro; the row expands to the one-line instruction |
| Offline (gateway rows) | Hollow                                            | `--ink-dim` | "Offline" in `--warn`                                               |

Notes under a row: Micro, left edge aligned with the name (31px), 8px below. The offline
message is a block under the rows: Label size, first sentence in `--warn`, then "Try again".
Footer: six 30 x 32 icon buttons (face north, zoom out, zoom in; sound, shortcuts, about).

**Detail panel.** 340 wide, 16 padding, 16 between sections, top at 72, max height
`100% - 72 - 40` (the 40 keeps the map credit visible), scrolls inside. Accent rule: 2px,
inset 10px each side so it runs straight between the corner radii. Name, then Title 2px
below, then Label. Readouts in two columns, 16 x 12 gaps: Label, then Readout with a Micro
unit 4px after. Sparkline 40 tall, 1.25px line in the accent, 1px `--line` base, 2px end
dot. Route: both ends in Title, a 12px track (1px `--ink` flown, 1px `--line-strong` ahead,
7px end ticks, 9px halo ring at the aircraft's position), then times in Label. Photo 308 x
124, radius 6, credit in Micro with underlined links. Nearby rows 32 tall: 3 x 10 lamp, name
in Label `--ink`, kind in Label `--ink-dim`, distance in Data. Two buttons, 32 tall, 8 apart.

**Search.** Pill 420 x 40. Icon 16, placeholder in Body `--ink-dim`, `/` key 18 x 18 radius 4. Results panel 8px below, same width, 6 padding. Group heading 28 tall: 3 x 10 lamp, layer
name in Label `--ink-dim` (Places gets a hollow lamp). Result row 32 tall (44 on phones),
6px radius: name in Title, description in Label `--ink-dim`, one number in Data. Keyboard
position: `--wash` fill and a 1px `--halo` outline drawn inside the row.

**Time tape.** 600 x 48 (phones: full width x 44). 10px per minute. Minor tick 5px, tick
every five minutes 11px in `--ink-dim`, all standing on a base 8px above the bottom edge.
Labels: Martian Mono 11px, centred on the tick, baseline 17px above the base. Needle: 1px
`--halo`, full height, fixed at 78% of the width (62% on phones). Its readout is a window
attached to the needle's right side, 8px from the top, 18 tall, solid, reading `live` or
`−12 min`; labels slide under it. Left edge fades over 48px. Buffer 60 minutes. When
scrubbed: a `--halo` line at 55% runs along the base from the needle to "now", which ends in
a 15px `--ink` tick. "Back to live": 32 tall, 8px right of the tape (phones: 40 x 32, icon
only, inside the tape's right end).

**Halo reticle.** Selected: radius 14, 1.25px `--halo`, a 56° gap centred on the heading.
Hover: radius 9 at 50%, same gap, with a 24px glass tag 15px to the right (name in Label,
number in Data, unit in Micro). Loading: radius 7, same gap, one turn in 900ms. Objects with
no heading get a closed ring. Hit target 28px (40 on phones).

**Glyphs on the globe** (px at a 400px globe radius; all scale by
`clamp((R / 400) ^ 0.42, 0.72, 1.3)`). Chevron 2.8 from centre to tip, with a tail about 2°
long fading from 43% to 0. Hull 5.2 x 2. Diamond 4.2 across. Quake ring radius
`2 + (M - 2.5) x 2.3`, 1.25px. Cables 0.8px at 50%. Selected aircraft: 1.25x and near white
(`#d6f7ff`), flown track 1.25px rising from 12% to 72%, route ahead dashed 1.5 on 4.5 off at
42%, and the rest of its layer drops to 62%.

**Phone (720px and under).** 12px margins. Wordmark top left, clock and count on one Data
line beneath it. Search is a 40px disc top right that opens to the full width; the wordmark
and clock fade while it is open. Dock: one glass strip above the tape, ten equal buttons,
each a lamp plus the layer's 16px icon. Ticker above the dock. Sheet: full width, top corners
10px, handle 32 x 3. Peek 132px shows name, type and the first two readouts; full is 70%.

## Motion

| What                                               | Timing                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Panel, search results, "Back to live" in           | 200ms, `cubic-bezier(0.2, 0.8, 0.2, 1)`, 12px slide from their own edge plus fade |
| Same, out                                          | 150ms ease-in                                                                     |
| Reticle                                            | Stroke drawn round its circumference in 240ms, same curve                         |
| Idle                                               | Glass, ticker, credit and count to 0 over 600ms linear after 8 s; back in 150ms   |
| Quake ripple                                       | Two rings, scale 1 to 3.4, fading, 2.4s period, 1.2s apart                        |
| Sheet stops, dock and tape lifting above the sheet | 200ms, same curve                                                                 |
| Hover fills and borders                            | 120ms                                                                             |
| Camera (mockup only)                               | 200ms cross-fade: the real camera flies                                           |
| Reduced motion                                     | No slides, reticle appears whole, ripple at half rate (4.8s)                      |

## Deviations from DESIGN.md

1. **Degraded lamp is broken, not `--warn`.** `--warn` (`#ffcf6b`) cannot be told from the
   Ships amber (`#ffb224`) or the Day and night accent (`#ffd9a0`) at 3 x 14px. The lamp keeps
   its accent and breaks into segments; `--warn` is used for words only. Also holds without
   colour vision.
2. **Hollow lamps have no colour.** Off rows use `--ink-faint` for the outline, following
   "colour only where the data is".
3. **Lit lamps glow** (6px, 50%). The spec says no shadows; this is light, not depth. Easy to
   drop.
4. **The needle's readout sits inside the tape**, attached to the needle, and the needle is
   at 78% rather than centred. A centred needle leaves half the tape empty while live, and a
   label above the tape collides with the dock on phones.
5. **"Back to live" sits beside the tape** on desktop, and inside its end as an icon on phones.
6. **Tape labels are 11px**, not Data's 12, to keep 14px between labels at 10px per minute.
   Numerals inside running sentences (route times, source line) are also 11px so they match
   the x-height of the Label text around them.
7. **Day-side colours are lifted** by up to 1.6x toward the subsolar point (land reaches about
   `#1a222d`). At the exact spec values the terminator did not read. Night: land about
   `#05070a`, water `#020204`. Borders drop from 20% to 7% at night so they do not compete
   with city lights; a coastline hairline (3.5 to 9%) is added.
8. **Text on space carries a black bloom** (`--on-space`). Needed once the globe fills the
   screen and the wordmark, clock, ticker or credit sit over city lights or the lit limb.
9. **Phone dock buttons are 36 x 40 at 390px wide**, under the 40px floor in one direction, so
   all ten lamps are visible without scrolling. They share the width and only scroll below
   34px each. The alternative is 44px buttons in a strip that hides two layers.
10. **At the sheet's peek stop the dock and tape ride above the sheet** rather than under it,
    so layers and time stay usable with something selected. They hide at the full stop.
    On phones the ticker also hides while the offline message is showing in the dock.
11. **Idle keeps the wordmark and clock at 55%.** The spec fades "the glass"; these are not on
    glass, and a clock suits a screen left running.
12. **Route is a track with a ring**, not text with an arrow.
13. **Selecting something dims the rest of its layer to 62%.** Not in the spec.
14. **Additions the spec has no place for yet:** the dock footer (north, zoom, sound,
    shortcuts, about), a map credit line bottom right, "in replay" replacing "live" beside
    the count while scrubbed (the clock shows the scrubbed time).
15. **Solid glass also applies under `prefers-reduced-transparency`.** Windows with
    "Transparency effects" off reports it, so those users get `--glass-solid`.
16. **"Copy link" uses a copy glyph**, not a chain.

Removed before calling it done: the tinted area under the sparkline, and a key icon beside
"Needs a key" that repeated the words.

## Not in the mockup

The opening shot, the empty search state, the shortcuts sheet, sound, the long-press name
on phone lamp buttons, sheet dragging (the handle toggles the two stops), and the radar,
imagery, wildfire and webcam layers on the globe.
