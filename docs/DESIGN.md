# Orya Halo design spec

The globe is the product. Everything else is a thin instrument laid over it: a command deck
from a film, but calm enough to leave running all day.

Audience: curious people, flight and ship watchers, anyone who wants to see the planet's live
traffic at a glance. Job: make a huge amount of moving data feel legible and quiet.

Static mockup of the main screen: [`docs/mockup/index.html`](mockup/index.html), with its
measurements in [`docs/mockup/NOTES.md`](mockup/NOTES.md). The HUD itself lives in
`apps/web/src/ui` (components) and `apps/web/src/styles` (tokens and CSS). This document
describes what is built; where the mockup and this text disagree, this text is current.

## Principles

1. **The chrome has no colour.** Interface surfaces are black glass and ice-white type. Colour
   appears only where a layer's data appears: a glyph on the globe, the lamp beside that layer
   in the dock, the rule at the top of its detail panel. Colour always means "this is that
   kind of thing". It is never decoration, and it is never a status: a lamp that is off or
   unreachable has no colour at all.
2. **Small glass at the edges, nothing across the middle.** No full-width bars. The wordmark,
   clock and counts sit directly on space with no container. Only things you operate (search,
   layer dock, detail panel, time tape) get a glass surface.
3. **Width is the hierarchy.** One sans family at three widths: condensed for dense labels,
   normal for reading, expanded and light for names. Size steps stay small.
4. **Sentence case, everywhere.** No tracked-out capitals, no eyebrow labels. Units are
   lowercase and dim, next to thin monospaced numerals.
5. **The halo is the motif.** Selection, hover, focus and loading are all thin rings, echoing
   the atmosphere's rim. Nothing else in the interface is round.
6. **Motion answers something.** One orchestrated opening shot. After that, things move only
   because the data moved or the person acted.

## Colour

| Token           | Value                                                     | Use                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--void`        | `#000000`                                                 | Space. True black, so the stars and rim glow carry the depth                                                                                                                               |
| `--glass`       | `rgb(9 14 22 / 0.58)` + 20px backdrop blur, 140% saturate | Panel fill                                                                                                                                                                                 |
| `--glass-solid` | `#0a0f17`                                                 | Panel fill where `backdrop-filter` is unsupported, and under `prefers-reduced-transparency: reduce` (Windows with "Transparency effects" off reports it). Also the needle's readout window |
| `--line`        | `rgb(170 205 255 / 0.14)`                                 | 1px panel borders, dividers                                                                                                                                                                |
| `--line-strong` | `rgb(170 205 255 / 0.28)`                                 | Top edge of panels, hovered controls                                                                                                                                                       |
| `--wash`        | `rgb(170 205 255 / 0.07)`                                 | Hover fill on rows and controls, and behind the keyboard-active search result                                                                                                              |
| `--ink`         | `#e9eff6`                                                 | Primary text and numerals                                                                                                                                                                  |
| `--ink-dim`     | `#9aa8ba`                                                 | Labels, units, secondary text (7.9:1 on glass-solid)                                                                                                                                       |
| `--ink-faint`   | `#6f7c8e`                                                 | Disabled and tertiary only (4.6:1); the outline of a hollow lamp                                                                                                                           |
| `--halo`        | `#bcd9ff`                                                 | Focus rings, selection ring, the wordmark's arc, the tape's needle                                                                                                                         |
| `--warn`        | `#ffcf6b`                                                 | Words that say a layer is degraded, offline or failed. Words only: never a lamp, because at 3 x 14px it cannot be told from the Ships amber or the Day and night accent                    |
| `--on-space`    | `0 0 2px #000, 0 0 12px rgb(0 0 0 / 0.85)`                | Text-shadow for text set straight on space (wordmark, clock, ticker), so it holds over city lights and the lit limb                                                                        |

Layer accents are defined once, in `packages/schema/src/kinds.ts`, and written to the document
root as `--accent-<layer>` when the HUD loads (`src/ui/accents.ts`); no stylesheet repeats them.

| Layer             | Accent           | Glyph on the globe                                                                                            |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| Aircraft          | `#4fe3ff` cyan   | Top-down silhouette by type (airliner, light aircraft, fast jet, helicopter), sized by type, short comet tail |
| Ships             | `#ffb224` amber  | Hull with its bridge or superstructure where that type has it, sized by length; drawn at true length close in |
| Satellites        | `#b08cff` violet | Body with a solar panel either side, along track; stations large, debris a speck; no tail                     |
| Earthquakes       | `#ff5247` red    | Ring that ripples outward, sized by magnitude                                                                 |
| Undersea cables   | `#1fbfa3` teal   | Hairline paths                                                                                                |
| Rain radar        | `#6fa8ff`        | Raster overlay with its own intensity scale                                                                   |
| Satellite imagery | `#9fb6c9`        | Raster overlay                                                                                                |
| Wildfires         | `#ff7a2b` ember  | Small flickerless dot, brighter with radiative power                                                          |
| Webcams           | `#ffffff` white  | Point with a soft beacon halo                                                                                 |
| Day and night     | `#ffd9a0`        | City lights and the terminator glow                                                                           |

Shape differs per layer as well as colour, so the layers stay distinguishable without colour
vision.

Movers are drawn like a vector plot on an instrument display: once a silhouette is about nine
pixels across it has a bright rim about a pixel wide round a see-through body, with the
ship's deckhouse or the satellite's body solid. Smaller than that, a silhouette is a solid
mark; from orbit every mover becomes a point of light, so density reads as glow. Moored ships
and aircraft on the ground keep only the rim, so a harbour reads differently from traffic
under way. Small hulls are drawn fuller than ships are, so they read as hulls and not
dashes, and take their true proportions only as they grow towards true scale. Sizes by
category live in `GLYPH_SCALE` (`packages/layers/src/movers/movers-shaders.ts`), shared by
the shaders and the selection ring, which grows to clear the silhouette it marks.

From a country away (zoom 5.6 to 6.6) aircraft turn from glyphs into 3D models of their real types:
the glyph fades out as the model fades in, keeping its trail and its click target. The models
are generated from published dimensions (`packages/schema/src/aircraft-types.ts`: length,
span, fuselage, wing sweep and chord, engines, tail layout; about 300 ICAO type codes over 35
models, with a stand-in by ADS-B category when the type is not known), so an A380 is an A380
and a Cessna a Cessna. Each is painted in its airline's colour scheme, picked by the callsign's
ICAO prefix (`packages/schema/src/aircraft-liveries.ts`: about 80 airlines): top and belly
colours, the fin with an optional second colour, engines, plus cabin windows and flight-deck
glass drawn in the shader. No logos, names or artwork, only flat colours; aircraft with no
known airline stay the app's light grey. They bank in turns and pitch on
climbs and descents, and are drawn larger than life (a 40 m airliner 26 px long from a country away,
48 px close in) until true size can be seen, all by the same factor so relative sizes stay
true. At most 3,000 are drawn (800 on the balanced tier, none on the cheapest), nearest the
middle of the view first.

Closer in (zoom 7.5 to 8.5) ships turn from glyphs into 3D models of their kinds in the same
way. AIS gives a category, sometimes a finer type (tug, pilot vessel, law enforcement, sailing),
a name, a length and a beam; `vesselModelFor` (`packages/schema/src/vessel-types.ts`) picks one
of 14 hull forms from them. A cargo ship's form comes from its name where the fleet's naming is
unambiguous (a container line's prefix, NYK's "… LEADER" car carriers), else from its
proportions: under 110 m a general cargo ship, a length over beam of 7.6 or more (or longer than
330 m and wider than 45 m) a container ship, otherwise a bulk carrier. That last rule is a
guess: AIS does not tell container ships from bulk carriers. Passenger ships of 230 m and more
are cruise ships, smaller ones ferries. Each model (`packages/layers/src/vessels/vessel-mesh.ts`)
is a smooth hull with a flared, raked bow and a transom, and boxes for deckhouses, funnels,
containers, hatch covers and cranes, built at the type's typical size and stretched to the
ship's own length and beam. Each vertex says what part it is on, and the shader paints hull
bands, a coast guard's bow stripe, window rows and balconies, funnel tops and every container a
colour of its own. The colours (`packages/schema/src/vessel-schemes.ts`) are by type (tankers
red-brown, bulk carriers black, cruise ships white), by role (coast guard white with a red bow
stripe, search and rescue orange, naval grey, research white) or, where the name identifies the
operator, a few flat colours of the line: Maersk's light blue, MSC's black hull and yellow
funnel, Evergreen's green, ONE's magenta, and so on, with most of their containers in the line's
colour. A ship's batch value packs its length (2 m steps), beam, model and scheme into one exact
float32 (`shipValue`); the glyph keeps its length byte and the model is copied into the fourth
style byte. A model is drawn exactly as long as the glyph it replaces until true size is larger,
so the cross-fade shows no jump. At most 1,500 are drawn (500 on the balanced tier, none on the
cheapest), nearest the middle of the view first.

**3D view** (V, or the button in an aircraft's or ship's detail panel) rides behind the selected
aircraft or ship: the camera sits about four and a half aircraft-lengths behind and above it, turned
22 degrees off its track for a three-quarter view, looking down at 76 degrees, so the horizon
and sky are in the frame. The wheel moves the camera nearer or further (up to 50 times the
starting distance; far back, the other aircraft are enlarged again so they can be seen), and
dragging turns it round the aircraft (sideways) or lifts it towards looking straight down
(upwards). The sky there is the design's (space above, a dim blue glow along
the horizon, haze over the ground), not MapLibre's white. Satellites are hidden in the 3D view: along the horizon
they would fill the sky. V again, the button, or flying elsewhere leaves it.

The Earth's surface, from orbit down to regional zoom, is NASA's Blue Marble (shaded relief and
bathymetry, from NASA GIBS tiles to zoom 8), toned slightly down (brightness to 82%, saturation
-12%) so the data layers stay on top of it. Between zoom 8.5 and 11 it fades into the vector base
map, whose own land and water fills fade in over the same range, so street level is the flat map.
Night lights use an 8192 x 4096 texture on desktop GPUs that allow it, and a 3600 x 1800 one
elsewhere.

The vector base map's own colours: dark and desaturated by day (land `#10151c`, water `#070b11`, lifted by up to
1.6x toward the subsolar point so the terminator reads; land reaches about `#1a222d`),
near-black at night (land about `#05070a`, water `#020204`) with warm city lights (`#ffd9a0`),
and a soft terminator band between them. Borders are ice-white at 20% by day and 7% at night,
so they do not compete with city lights; a coastline hairline (3.5 to 9%) keeps the land's
edge. The atmosphere rim is a thin `#7fb4ff` glow. Selecting something dims the rest of its
layer to 62%.

## Type

Two families, both variable, both self-hosted through Fontsource (no third-party requests).
The stylesheet imports each family's `standard.css`, the entry that carries both the weight
and the width axis; the two Latin files are preloaded from `index.html`.

- **Archivo** (weight 100 to 900, width 62 to 125) for all text.
- **Martian Mono** (weight 100 to 800, width 75 to 112.5) for every numeral that changes: clock,
  counts, coordinates, altitudes, speeds. Tabular by nature, so digits never shift.

| Role    | Family       | Size / line | Weight | Width | Use                                                       |
| ------- | ------------ | ----------- | ------ | ----- | --------------------------------------------------------- |
| Name    | Archivo      | 22 / 26     | 300    | 118   | Selected object's name, wordmark, overlay titles          |
| Title   | Archivo      | 15 / 20     | 500    | 100   | Panel headings, search results, route ends                |
| Body    | Archivo      | 13 / 19     | 400    | 100   | Sentences, descriptions, ticker                           |
| Label   | Archivo      | 12 / 16     | 500    | 82    | Field labels, dock layer names, buttons                   |
| Micro   | Archivo      | 11 / 14     | 500    | 82    | Units, notes under dock rows, attribution, shortcut hints |
| Readout | Martian Mono | 20 / 24     | 200    | 80    | Primary numbers in the detail panel                       |
| Data    | Martian Mono | 12 / 16     | 300    | 80    | Counts, clock, table numerals                             |

Rules: sentence case always. Letter-spacing stays at 0 except the wordmark (0.04em). Thin
weights (200) only at 16px and above; small numerals use 300 so they hold contrast. Units sit
after the number in Micro, `--ink-dim`, lowercase: `10,972 m`, `452 kt`. Negative numbers use a
true minus sign, which shares the digits' advance. Numerals inside running sentences and the
tape's labels are 11px, so they match the x-height of the Label text around them and leave
14px between tape labels. Archivo needs `font-variant-numeric: tabular-nums` (set on `body`).
Width is always set with `font-stretch`, apart from the `font` shorthand, which would reset it.
Measure never exceeds 60 characters in panels.

## Space and shape

- Spacing scale: 2, 4, 8, 12, 16, 24, 32, 48. Panels pad 16; rows are 32 tall (40 on touch).
- The screen keeps a 16px margin (12 on phones) between glass and the viewport edge.
- Corner radius: 10px on panels, 6px on controls inside them, 999px only on the search field.
- Borders are 1px `--line`, with `--line-strong` on the top edge only, as if lit from above.
- Shadows: none. Depth comes from blur and the globe moving behind the glass. Two things that
  look like shadows are light instead: a lit lamp glows (`0 0 6px` of its accent at 50%), and
  text on space carries `--on-space`.
- Icons: 16px, 1.25px stroke, butt caps and mitre joins, drawn for this project (one per layer
  plus a small utility set; source in `docs/mockup/icons.js`, used from `src/ui/icons.tsx`).

## Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ◌ orya halo            ( Search flights, ships, satellites, places        / )       │
│                                                      14:32:07 utc    24,318 live     │
│ ┌──────────────────┐                                         ┌──────────────────────┐│
│ │▍Aircraft   12,410│                                         │▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔││
│ │┋Ships       8,221│                                         │ BAW117               ││
│ │▍Satellites  9,880│               ( the globe )             │ Boeing 777-300ER     ││
│ │▍Earthquakes    14│                                         │ 10,972 m    452 kt   ││
│ │▍Cables        560│                                         │ London ──────○── SIN ││
│ │▏Rain radar       │                                         │ Nearby               ││
│ │▏Wildfires        │                                         │ Follow    Copy link  ││
│ │ ◇ − +     ♪ ⌨ ⓘ │                                         └──────────────────────┘│
│ └──────────────────┘                                                                 │
│  M5.8 earthquake near Tonga, 2 min ago   ┊┊┊┊│┊┊┊┊│┊┊┊┊│┊┊▌live ┊     map credits    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- **Top left:** the wordmark, on space; it opens the about page. **Top centre:** search, 420px
  wide, the only pill. **Top right:** UTC clock and the total live count, on space,
  right-aligned. The total is the sum of the object layers that are showing data (cables,
  being paths, are not counted). While the tape is scrubbed the clock shows the scrubbed time
  and the count reads "in replay" in place of "live".
- **Left:** the layer dock, 208px wide, top at 72px. Each row is one toggle button: a 3 x 14px
  lamp, the layer name, and a right column in Data. The pressed state is the lit lamp, never a
  filled background. Rows by state:

  | State       | Lamp                                              | Name        | Right column                                               | Beneath the row                                                                   |
  | ----------- | ------------------------------------------------- | ----------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
  | Off         | Hollow: 1px inset `--ink-faint`, no colour        | `--ink-dim` | Empty                                                      |                                                                                   |
  | Loading     | Accent at 45%, no glow                            | `--ink`     | The 14px halo ring, turning                                |                                                                                   |
  | Live        | Solid accent, glowing                             | `--ink`     | Count (the provider's worldwide total when it reports one) |                                                                                   |
  | Degraded    | Accent in three 3px segments, 2.5px gaps, no glow | `--ink`     | Count                                                      | The source's sentence, Micro, `--warn`                                            |
  | Needs a key | Hollow                                            | `--ink-dim` | "Needs a key" in Micro                                     | The one-line instruction, Micro, `--ink-dim`                                      |
  | Offline     | Hollow                                            | `--ink-dim` | "Offline" in `--warn`                                      | The source's sentence in `--warn`; gateway rows share one message instead (below) |
  | Error       | Hollow                                            | `--ink-dim` | "Error" in `--warn`                                        | What happened and "Turn it off and on to try again"                               |

  A note under a row is cut at two lines (an ellipsis), so a long sentence from a source never
  stretches the dock; the whole sentence is in a tooltip when the row is hovered or focused,
  and always in the row's description for screen readers.

  When the gateway layers are on but unreachable, one block under the rows says so in Label
  type ("Live traffic is offline." in `--warn`, then what still works). "Try again" appears
  only when this build has a gateway to reach and it is down: there is no retry service, so it
  switches every offline gateway layer off and then on again, which makes the worker drop its
  connection and its backoff and connect at once (measured: 15 ms after the click, against a
  backoff of several seconds). Without a gateway configured the block says so and offers
  nothing to press.

  **Notes about the app itself** sit in the same place, above the gateway block: the engine's
  sentence when the base map is missing or the browser has paused the graphics, first sentence
  in `--warn`, cleared when the engine recovers. A development build adds the engine's hint
  for whoever runs the deployment (in Micro, under a dashed rule, commands in Martian Mono);
  a production build never shows it. They live in the dock rather than in the ticker's place
  because the ticker's corner is too narrow for a sentence on smaller screens and the ticker
  should keep reporting events while the base map is missing.
  **Dock footer:** six 30 x 32 icon buttons: face north, zoom out, zoom in; sound, shortcuts,
  about. Each has a tooltip with its key.

- **Right:** the detail panel, 340px wide, present only while something is selected. Its
  maximum height leaves room at the bottom for the map's credit line: 56px, 88px below 1192px
  wide, where the credits wrap to more lines.
- **Bottom left:** the ticker, one line of Body text on space. **Bottom centre:** the time
  tape, 48 tall and `min(600px, 100% - 544px)` wide. **Bottom right:** the map's own credit
  line, drawn by the engine on the map (several licences require it there); the HUD leaves
  that corner to it and it stays when the HUD fades. The engine keeps the credits 40px clear
  of a 600px tape and never narrower than 240px, so below 1192px the tape gives up width
  instead (544 = 2 x (16 margin + 240 credits + 16 gap)). "Back to live" sits above the tape's
  right end, not beside it, where it would land on the credits.
- **Between phones and 904px** a centred tape would drop below 360px, so it moves to the left
  margin (`100% - 288px` wide) with the ticker above it, and the search pill starts after the
  wordmark instead of centring into the clock.
- Everything is left-aligned except numerals in columns (right-aligned) and the centred search.

**When the globe cannot start** (no WebGL 2, or the engine fails to load) the opening shot
never finishes, so the glass stays hidden: the wordmark stays, and the store's one sentence
sits centred on space in Title type with one action, "Reload", which takes focus.

### Phones (720px and under)

12px margins. Wordmark top left with the clock and count on one Data line beneath it. Search
is a 40px disc top right that opens to the full width; the wordmark and clock fade while it is
open, and results rows are 44 tall.

The dock is one glass strip above the tape: ten equal buttons, each a lamp plus the layer's
16px icon. They share the width (36 x 40 at 390px, one direction under the 40px floor so that
all ten layers stay in view) and only scroll below 34px each. A tap toggles; a long press
(450ms) shows the layer's name and count in a tag above the strip and does not toggle. The
dock footer is not shown: sound and the about page are reached through the wordmark.

The tape is full width and 44 tall, with its needle at 62%. "Back to live" rides inside the
tape's right end as a 40 x 32 icon button. The ticker sits under the clock line (top 70), not
above the dock: the engine lifts the map's credit line to just above the dock strip, and the
two would collide there. The app's notes (live traffic offline, base map or graphics gone)
take the same place, as one full-width glass block at top 74, and the ticker gives way to
them; both fade while search is open.

The detail panel is a bottom sheet with two stops: peek at 132px (name, type and the first two
readouts) and full at 70% of the height. It is dragged by its handle or its heading: the
sheet follows the finger, and on release a flick (0.4 px/ms or faster) decides the direction,
otherwise the nearer stop wins; dragged or flicked below the peek stop it closes and clears
the selection. A tap on the handle steps between the stops. At the peek stop the dock and
tape ride above the sheet so layers and time stay usable; at the full stop they give way. At
the full stop the sheet covers the map's credit line, which the engine places by the camera
padding rather than by the sheet (a known gap; see the HUD report).

## Components

- **Halo reticle (signature).** A thin ring drawn around the hovered or selected object, with
  a 56° gap that points along its heading; objects with no heading get a closed ring. Hover:
  18px ring at 50% plus a 24px glass tag 15px to the right (name in Label, one number in Data,
  unit in Micro, from the worker's structured title, value and unit; until it answers, the
  engine's own label, whole), which flips to the left near the right edge and never takes
  pointer events.
  Selected: 28px ring at full `--halo`, drawn once around its circumference in 240ms. The
  engine draws the rings; the HUD draws the tag. The same ring, 14px and turning once in
  900ms, is the loading indicator, and the keyboard focus outline is its flat cousin: 1px
  `--halo` with 2px offset.
- **Layer lamp row.** See Layout. Hotkeys `1` to `0` in dock order.
- **Readout.** A number in Readout type with its unit and a Label above. When the value
  changes it tweens over 300ms (ease-out); digits never jump width.
- **Time tape (signature).** A ruled strip like an instrument tape, 10px to the minute: a 5px
  tick per minute, an 11px tick with an hh:mm label every five, standing on a base 8px above
  the bottom edge, sliding under a fixed needle. The needle is 1px `--halo` at 78% of the
  width (62% on phones): centred, half the tape would sit empty while live. Its readout is a
  small solid window attached to the needle's right side, reading `live` or `−12 min`; labels
  slide under it and step aside. Minutes older than the recorded history are drawn at 35%, so
  the ruling shows how far back the needle can go. Dragging the tape, or the arrow keys with
  it focused (a minute; five with Shift or the Page keys; Home for the oldest moment, End for
  live), moves through the history; within 20 seconds of now it snaps to live. When scrubbed,
  a `--halo` line at 55% runs along the base from the needle to "now", which ends in a 15px
  `--ink` tick, and "Back to live" appears above the tape's right end (8px up; inside that
  end on phones). Before a minute of history exists the tape is disabled and says so in
  place of its labels.
- **Detail panel.** Accent rule on top (2px, the layer's colour, inset 10px each side). Name,
  type in Title, a quieter line in Label. Two to four Readouts chosen per layer (aircraft:
  altitude, ground speed, heading, climb rate; ships: speed, course, length, draught;
  satellites: altitude, speed, inclination, period; earthquakes: magnitude, depth, felt
  reports; wildfires: radiative power, confidence, brightness; cables: mapped length), taken
  from the source's own fields in the source's units, else from the position fix in metres
  and knots. Then the sparkline, when the selection has a history worth drawing: a Label
  caption that says what the line is ("Altitude, last 23 min" for aircraft, "Speed, last
  12 min" for ships, "Altitude over one orbit" for satellites, whose series is the predicted
  orbit), the lowest and highest values in Data at the right (an en dash in the text face
  between them, since a mono dash reads as a minus), and one 1.25px hairline in the accent,
  40 tall, with a 4px dot at the newest point. No fill, no axes, no base line, no animation:
  a new point redraws it. The vertical scale is rounded outward to a round step of about a
  tenth of the range, so a new point inside it leaves the rest of the line where it was.
  Aircraft altitude uses the unit of the altitude readout above it (feet when the source sends
  feet). Nothing is drawn for no series, fewer than two usable points, or a change too small to
  mean anything (30 m of altitude, 1,000 m for a satellite, a quarter of a metre a second).
  Origin and destination, when known, as a track: both ends in Title, the travelled
  part in `--ink`, the rest in `--line-strong`, a 9px halo ring where the object is. A photo
  or camera image when the source provides one, as the providers' terms ask: the whole image a
  plain link to the provider's page (`rel="noopener"` only: no `nofollow`, and no
  `noreferrer`, so the provider receives the Referer it relies on), the image fetched by the
  browser from the URL exactly as given (no proxy, no `srcset`), lazily, never scaled above its
  natural size, and the credit beneath in visible Micro text. A camera image adds "Updated
  4 min ago" when its source gives a time. The remaining facts as a quiet
  two-column list, starting with the position. Nearby objects (lamp, name, kind, distance;
  click selects). Then "Follow" (things that move; reads "Following" with a lit edge while
  on) or "Fly there" (things that do not), and "Copy link", which confirms with "Link
  copied". Source credit at the bottom in Micro, with "Updated 2 s ago" for things that move.
  While the detail loads the panel shows the ring; if the object has gone it says "This
  aircraft is no longer in view." and what to do.
- **Search.** Opens with `/`. Results are grouped by layer in dock order with the layer's
  lamp, places last with a hollow lamp, 8 at most, arrow keys and Enter to fly there, Esc to
  close. The keyboard position is a `--wash` fill and a 1px `--halo` outline drawn inside the
  row. While the first answer loads: the ring and "Searching". Empty state: "No match. Try a
  flight number, a ship name, a satellite or a city."
- **Ticker.** One line that replaces itself when something notable happens (the new line
  fades up; nothing slides), with a 12px ring in the layer's accent; click to select the
  object or fly there.
- **Overlays.** Two modal glass sheets over a dimmed globe, with a focus trap, Esc, and focus
  returned to where it was. While one is open the HUD behind it is inert as well as hidden
  from assistive tech. _About_ (the wordmark, or the dock's info button): what this is,
  every data source in use with its required credit, licence and notes; the base map
  (Protomaps tiles from OpenStreetMap data, © OpenStreetMap contributors, ODbL), the night
  lights (NASA Earth Observatory's Black Marble, with its full credit), place names (GeoNames,
  CC BY 4.0) and aircraft photos (Planespotters.net); which data is offered under the ODbL
  rather than MIT; the sound switches; and `docs/DATA_LICENCES.md`, linked when
  `VITE_REPO_URL` is set. Wording follows `docs/DATA_LICENCES.md`. _Keyboard shortcuts_
  (`?`). Both load on first use, with their own stylesheet.

**What loads when.** The first paint carries the HUD shell (about 126 kB of JavaScript and
7 kB of CSS, gzipped). The detail panel loads on the first selection and is fetched as soon
as the opening shot ends, so the first click finds it ready; the overlays and the sound code
load when first used.

## Motion

- **Opening shot (the one orchestrated moment).** The wordmark comes up with the stars
  (900ms). Once the globe is turning, the clock fades in (600ms, after 200ms) and the glass
  comes in from its own edges, 12px and 600ms each, a beat apart: search from the top at
  900ms, dock from the left at 1000ms, tape from below at 1100ms, ticker at 1400ms. Then the
  camera glides to the visitor's region. About 4 seconds, skippable by any input; a shared
  link or reduced motion skips it.
- Camera moves are always eased arcs (`flyTo`), 1.2 to 2.4s depending on distance. Never a cut.
- Panels, search results and "Back to live" slide 12px from their own edge and fade in 200ms
  with `cubic-bezier(0.2, 0.8, 0.2, 1)`; out in 150ms ease-in. The phone sheet, and the dock
  and tape lifting above it, take 200ms on the same curve. Hover fills and borders: 120ms.
- Numbers tween when they change. Nothing else animates on its own.
- Only `transform` and `opacity` are animated (and colour on hover): never layout.
- **Idle:** after 8 seconds without input the glass, the ticker and the count fade to 0 over
  600ms and the globe fills the screen; the wordmark and clock, which are not on glass, stay
  at 55%, since a clock suits a screen left running. The map credit stays. Any pointer move or
  key brings everything back in 150ms. After 60 seconds the globe starts a slow orbit and
  occasionally glides to a notable live event.
- **Reduced motion:** camera moves become 200ms fades between positions, the opening shot is
  skipped, panels fade without sliding, numbers change without tweening, rings appear without
  drawing, pulses and trails stay but slow to half rate (the loading ring turns in 1800ms),
  the idle orbit is off. Placement is not motion: on phones the dock and tape still lift above
  the sheet's peek stop, they just do not glide there.

## Sound

Off by default. When on: a soft tick on selection (a little higher) and on layer toggles, and
an optional low ambient hum. Generated with Web Audio, no audio files; the audio code loads the
first time sound is switched on. The dock's speaker button and `M` switch sound; the hum has
its own switch on the about page.

## Voice

Plain, short, sentence case. Name things by what people see: "Aircraft", "Rain radar", not
feed or source names. Buttons say what happens: "Follow", "Back to live", "Copy link".
States give direction: "Ships need a free AISStream key. Add it to the gateway's .env file."
"Live traffic is offline. The gateway isn't reachable; satellites and earthquakes still work."

## Accessibility

- All text meets 4.5:1 against `--glass-solid`; the glass never drops below that because its
  fill is 58% opaque over a globe that is itself dark. Under `prefers-reduced-transparency`
  the glass is solid.
- Every control is reachable by keyboard, with the halo focus outline. Shortcuts: `/` search,
  `1` to `0` layers, `F` follow, `L` back to live, `N` north, `+` and `−` zoom, `H` home,
  `M` sound, `Esc` close search then clear the selection, `?` the list. They are ignored
  while typing in a field, with Ctrl, Alt or Cmd held, and while a dialog is open.
- The globe exposes its selection through a polite live region: selecting or following an
  object announces its name and position.
- The tape is a slider: its value is minutes behind live, announced as "Live" or
  "12 minutes ago".
- Touch targets are at least 40px, with one exception: the phone dock's ten lamp buttons are
  36 x 40 at 390px wide, so that no layer is hidden behind a scroll.
