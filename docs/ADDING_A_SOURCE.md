# Adding a data source

Every feed in Orya Halo is a **source plugin**: one object that says where the data comes
from, how often to ask, under which licence, and how to turn the provider's format into the
app's own shapes. Plugins hold no state and touch no DOM, so the same code runs in the
browser's data worker and in Node tests. Feeds that need a server (a secret key, no CORS, a
rate limit that must be shared by every visitor) are written for the gateway instead, as an
`Upstream`; see [the gateway side](#the-gateway-side-upstream) at the end.

Before writing anything, check the source against
[the rule for data sources](../CONTRIBUTING.md#the-rule-for-data-sources). A plugin whose terms
forbid public display will not be merged, however good the code.

This guide builds one plugin, `example-quakes`, for a made-up provider. Every snippet here
was compiled and its tests run against the repository on 2026-11-14; only the provider and its
addresses are invented.

## Where it fits

```
packages/schema/src/source.ts      the contract: SourcePlugin and friends
packages/sources/src/<feed>/       your plugin, its tests and its recorded fixtures
packages/sources/src/index.ts      exports every plugin
apps/web/src/data/registry.ts      the one place plugins are switched on
docs/DATA_LICENCES.md              the human-readable record of the terms
```

A plugin feeds one of the existing layers (`LayerId` in `packages/schema/src/kinds.ts`):
`aircraft`, `ships`, `satellites`, `quakes`, `cables`, `radar`, `imagery`, `fires`, `webcams`
or `nightlights`. Several plugins may feed the same layer, as the two webcam plugins do. A new
layer is a change to the shared contract in `packages/schema` and to the engine and HUD, so
open an issue for it first.

## The contract, field by field

`SourcePlugin<TRaw>` is defined in `packages/schema/src/source.ts`. `TRaw` is whatever `fetch`
returns: the provider's own document, untouched.

| Field                          | Required                         | What it is                                                                                                                                                                                                                           |
| ------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                           | yes                              | Unique, kebab-case: `"usgs-quakes"`. Also the `source` of every update it produces                                                                                                                                                   |
| `name`                         | yes                              | The provider's name as people know it: `"USGS Earthquake Hazards Program"`. Used in status messages ("RainViewer isn't responding")                                                                                                  |
| `layer`                        | yes                              | The `LayerId` it feeds                                                                                                                                                                                                               |
| `transport`                    | yes                              | How data arrives: see [transports](#transports)                                                                                                                                                                                      |
| `schema`                       | yes                              | The fields of the normalised output (`key`, `label`, `type`, optional `unit`), for the detail panel and the docs                                                                                                                     |
| `refreshRate`                  | yes                              | Milliseconds between `fetch` calls. Must respect the provider's limit with margin. `0` for `stream`, `gateway` and one-shot `static` sources                                                                                         |
| `licence`                      | yes                              | `LicenceInfo`: `name`, `url`, `display`, `redistribution`, `commercial`, optional `notes`, and `verified`, the ISO date someone last read the terms. `display` must be `true`                                                        |
| `attribution`                  | yes                              | `text` and `url` of the credit, and `onMap: true` when the terms require it on the map itself                                                                                                                                        |
| `docs`                         | yes                              | Link to the provider's API documentation                                                                                                                                                                                             |
| `recomputeRate`                | no                               | See [timing](#timing-refreshrate-cachettl-recomputerate-viewaware)                                                                                                                                                                   |
| `cacheTtl`                     | no                               | See below                                                                                                                                                                                                                            |
| `viewAware`                    | no                               | See below                                                                                                                                                                                                                            |
| `requiresKey`                  | no                               | Name of an environment variable holding a key. The web app passes no keys to plugins (anything in the bundle is public), so a plugin with `requiresKey` always shows "needs a key" there. Keyed feeds belong in the gateway          |
| `fetch(ctx)`                   | for `fetch`, `compute`, `static` | Pull one batch of raw data                                                                                                                                                                                                           |
| `stream(ctx, onData, onError)` | for `stream`                     | Open a push feed; return a function that closes it                                                                                                                                                                                   |
| `normalise(raw, ctx)`          | yes                              | Turn the raw data into a `SourceOutput`. Pure and synchronous                                                                                                                                                                        |
| `track(raw, id, ctx)`          | no                               | The predicted or recorded path of one object, such as a satellite's orbit                                                                                                                                                            |
| `fallback(ctx)`                | no                               | Older data to show, marked degraded with your `message`, while `fetch` fails or is slow (the satellites plugin returns a bundled snapshot). Its `ctx.fetch` only answers from the response cache and from the app's own static files |
| `detail(id, meta, ctx)`        | no                               | More for the detail panel: subtitle, fields, media, a link to the provider's page. May fetch                                                                                                                                         |

`ctx` is a `SourceContext`: a `fetch` with the app's timeout and retry policy, `now()` (the
scrubbed moment while the time tape is moved back), an `AbortSignal` that fires when the layer
is switched off, `assetBase` for the app's own static files, and `view` for view-aware sources.
Use these instead of globals, so tests can pass fakes.

## Transports

| Transport | Used for                                                                             | The runner                                                                                      |
| --------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `fetch`   | Open JSON or CSV APIs polled from the browser (earthquakes, radar, imagery, webcams) | Calls `fetch` every `refreshRate`, with a little jitter, and `normalise` on the result          |
| `stream`  | A socket or event stream opened by the worker                                        | Calls `stream` once and reopens it with backoff when it reports an error. No plugin uses it yet |
| `gateway` | Layers that arrive through the gateway (aircraft, ships)                             | Never fetches. The plugin only describes the layer: schema, licence, credit, `detail()`         |
| `compute` | Data computed locally from downloaded elements (satellites from orbital elements)    | Fetches like `fetch`, then re-runs `normalise` every `recomputeRate` on the same raw data       |
| `static`  | A file bundled with the app and rebuilt at build time (cables)                       | Fetches once from `ctx.assetBase`                                                               |

## Outputs

`normalise` returns one of three shapes, which must match the layer's shape in `kinds.ts`:

- **`{ type: "entities", update, events? }`** for point objects (quakes, fires, webcams,
  satellites). `update` is an `EntityUpdate`: columns of typed arrays, one value per object, in
  SI units (degrees, metres, metres per second, Unix milliseconds). `createColumns(n)` makes the
  arrays. Set `full: true` when the update is the source's complete current set: anything this
  source sent before and left out is dropped. `meta` holds per-object facts for the detail
  panel. `events` are ticker lines (`HaloEvent`), each with a stable `id` so it is announced
  once.
- **`{ type: "paths", paths }`** for lines (undersea cables): a `PathSet` with flat lon, lat
  pairs and start indices.
- **`{ type: "tiles", overlay }`** for raster overlays (radar, imagery): a `TileOverlay` with
  URL templates, tile size, zoom range, and optional `frames` with times, so the time tape can
  scrub through them.

## Timing: refreshRate, cacheTtl, recomputeRate, viewAware

These four are easy to mix up.

- **`refreshRate`** is how often to ask the provider. Match how often the data changes and stay
  inside the published limit with margin: USGS regenerates its feeds every minute, so
  `usgs-quakes` asks every 60 seconds; RainViewer adds a frame every ten minutes, so it asks
  every five.
- **`cacheTtl`** is for providers that ration downloads. The raw response is kept in the
  browser's Cache Storage, and the provider is not asked again within that time, even after a
  reload, and an error answer waits the whole `cacheTtl` before a retry. CelesTrak serves each
  group once per update per IP address and blocks addresses that keep asking, so the
  satellites plugin sets one. Leave it out for ordinary APIs: without it, failures are retried
  with backoff.
- **`recomputeRate`** is how often to re-run `normalise` on the data already held, without
  asking anyone. Use it when the output depends on the clock: satellites move every second
  although their orbital elements change a few times a day.
- **`viewAware: true`** means `fetch` uses `ctx.view` to ask only for the area on screen. The
  runner fetches again when the camera settles somewhere new, never sooner than `refreshRate`
  after the last fetch.

Nothing polls while the tab is hidden, and switching a layer off aborts its requests.

## Errors

Fail by throwing a `SourceError` from `packages/sources` (`shared/space-earth/errors.ts`) with
one of four codes and a message that is one plain sentence, fit to show as it is. The helpers
`fetchText` (same file) and `fetchJson`, `fetchBody` and `fetchBytes`
(`shared/overlays/http.ts`) already turn HTTP answers into the right code. Never put a URL in
a message; it may carry a key.

| Code        | Use it when                                               | What the runner does                                                                                      | What the dock shows                                                           |
| ----------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `needs-key` | A key is missing or the provider rejected it              | Looks again one full refresh interval later                                                               | "Needs a key", with your message beneath                                      |
| `blocked`   | The provider refused under its usage policy (403, 429)    | Waits a full refresh interval before asking again, never sooner, and remembers the refusal across reloads | Offline, with when it will try again                                          |
| `http`      | Any other unsuccessful answer                             | Retries with exponential backoff (from 2 seconds up to 5 minutes), never sooner than a `Retry-After`      | Offline and "We'll keep trying"; Error for a 4xx that will not mend by itself |
| `bad-data`  | The answer arrived but is not what the provider documents | Drops any cached copy of that answer, retries with backoff                                                | Error, with your message                                                      |

When the layer already has data, any failure shows as Degraded instead, and the last good data
stays on screen. A failure with no `SourceError` at all (the network is down) is treated as
offline. A `SourceError` thrown from `normalise` is reported the same way as one from `fetch`.

## A worked example

`packages/sources/src/example-quakes/index.ts`:

```ts
/**
 * Earthquakes from the Example Seismic Network: one JSON document with the
 * last day's events, regenerated every five minutes.
 *
 * Terms read on 2026-11-14 at https://quakes.example.org/terms: CC BY 4.0,
 * public display and redistribution allowed, credit with a link required.
 */
import { EntityKind, createColumns, defineSource, hashId } from "@orya-halo/schema";
import type {
  Attribution,
  EntityMeta,
  EntityUpdate,
  SchemaField,
  SourcePlugin,
} from "@orya-halo/schema";
import { SourceError, fetchJson } from "../shared/overlays/http.ts";

const SOURCE_ID = "example-quakes";
export const EXAMPLE_FEED = "https://quakes.example.org/api/v1/day.json";

/** The provider's document, as far as this plugin reads it. */
export interface ExampleFeed {
  generatedMs: number;
  events: {
    id: string;
    lon: number;
    lat: number;
    depthKm: number | null;
    mag: number;
    timeMs: number;
    place?: string;
  }[];
}

const ATTRIBUTION: Attribution = {
  text: "Earthquake data: Example Seismic Network",
  url: "https://quakes.example.org/",
};

const SCHEMA: readonly SchemaField[] = [
  { key: "label", label: "Place", type: "string" },
  { key: "magnitude", label: "Magnitude", type: "number" },
  { key: "depthKm", label: "Depth", type: "number", unit: "km" },
  { key: "timeMs", label: "Time", type: "time" },
];

/** Normalise one document. Exported so tests can call it without a context. */
export function normaliseExample(raw: ExampleFeed, now: number): EntityUpdate {
  if (!raw || !Array.isArray(raw.events)) {
    throw new SourceError(
      "bad-data",
      "The Example Seismic Network sent a feed that could not be read.",
    );
  }
  // While the time tape is scrubbed, `now` is in the past: leave out what had not happened yet.
  const events = raw.events.filter(
    (e) =>
      Number.isFinite(e.lon) && Math.abs(e.lat) <= 90 && Number.isFinite(e.mag) && e.timeMs <= now,
  );
  const c = createColumns(events.length);
  const meta: EntityMeta[] = [];
  events.forEach((e, i) => {
    const depthKm = e.depthKm ?? 0;
    // Ids are 32-bit numbers. Prefix the provider's id so two feeds can never collide.
    c.ids[i] = hashId(`${SOURCE_ID}:${e.id}`);
    c.lon[i] = e.lon;
    c.lat[i] = e.lat;
    c.alt[i] = -depthKm * 1000; // SI units: metres, negative below sea level.
    c.fixTimeMs[i] = e.timeMs;
    c.value[i] = e.mag; // The quake layer sizes its rings by `value`.
    meta[i] = { label: e.place ?? "Unnamed location", magnitude: e.mag, depthKm, timeMs: e.timeMs };
  });
  return {
    kind: EntityKind.Quake,
    source: SOURCE_ID,
    timeMs: now,
    full: true,
    count: events.length,
    columns: c,
    meta,
  };
}

export const exampleQuakes: SourcePlugin<ExampleFeed> = defineSource<ExampleFeed>({
  id: SOURCE_ID,
  name: "Example Seismic Network",
  layer: "quakes",
  transport: "fetch",
  schema: SCHEMA,
  // The document changes every five minutes; asking more often gains nothing.
  refreshRate: 5 * 60_000,
  licence: {
    name: "CC BY 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    display: true,
    redistribution: true,
    commercial: true,
    notes: "Credit with a link. The feed is regenerated every five minutes; do not poll faster.",
    verified: "2026-11-14",
  },
  attribution: ATTRIBUTION,
  docs: "https://quakes.example.org/api/",

  fetch(ctx) {
    return fetchJson<ExampleFeed>(ctx, EXAMPLE_FEED, "The Example Seismic Network");
  },

  normalise(raw, ctx) {
    return { type: "entities", update: normaliseExample(raw, ctx.now()) };
  },
});
```

The real plugins are the best reference beyond this: `packages/sources/src/quakes/index.ts`
(three feeds merged, ticker events, `detail()`), `radar/rainviewer.ts` (a tile overlay with
frames), `satellites/index.ts` (`compute` with `cacheTtl` and `recomputeRate`) and
`webcams/digitraffic.ts` (a second plugin on a shared layer, with images in `detail()`).

## Testing with recorded fixtures

Record a real response once (one request, by hand), trim it to a handful of entries, and save
it next to the plugin under `fixtures/`. Say in the test where and when it was recorded. Tests
never touch the network: `fakeContext` from `shared/space-earth/testing.ts` answers requests
from a table of recorded bodies and logs every URL asked for.

`packages/sources/src/example-quakes/example-quakes.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { EntityKind } from "@orya-halo/schema";
import { describe, expect, test } from "vite-plus/test";
import { fakeContext } from "../shared/space-earth/testing.ts";
import { EXAMPLE_FEED, exampleQuakes, normaliseExample } from "./index.ts";
import type { ExampleFeed } from "./index.ts";

// Recorded from quakes.example.org on 2026-11-14 at 15:20 UTC and trimmed to three events.
const BODY = readFileSync(new URL("./fixtures/day.json", import.meta.url), "utf8");
const NOW = 1_794_669_607_000;

describe("example-quakes", () => {
  test("asks for the one document and normalises every event in SI units", async () => {
    const ctx = fakeContext({ now: NOW, routes: { [EXAMPLE_FEED]: BODY } });
    const raw = await exampleQuakes.fetch?.(ctx);
    expect(ctx.requests).toEqual([EXAMPLE_FEED]);
    const out = exampleQuakes.normalise(raw as ExampleFeed, ctx);
    if (out.type !== "entities") throw new Error("expected entities");
    expect(out.update).toMatchObject({
      kind: EntityKind.Quake,
      source: "example-quakes",
      full: true,
      count: 3,
    });
    expect(out.update.columns.alt[0]).toBe(-10_000);
  });

  test("an event after the shown moment has not happened yet", () => {
    const raw = JSON.parse(BODY) as ExampleFeed;
    expect(normaliseExample(raw, raw.events[0].timeMs).count).toBe(1);
  });

  test("failures carry the codes the runner understands", async () => {
    const refused = fakeContext({
      now: NOW,
      routes: { [EXAMPLE_FEED]: { status: 429, body: "Slow down." } },
    });
    await expect(exampleQuakes.fetch?.(refused)).rejects.toMatchObject({
      name: "SourceError",
      code: "blocked",
    });
    const down = fakeContext({ now: NOW, routes: { [EXAMPLE_FEED]: { status: 503, body: "" } } });
    await expect(exampleQuakes.fetch?.(down)).rejects.toMatchObject({
      name: "SourceError",
      code: "http",
    });
    expect(() => normaliseExample({} as ExampleFeed, NOW)).toThrow(/could not be read/);
  });
});
```

Test what could break: one recorded record mapped field by field, the edge cases the provider
really sends (missing depth, a stray longitude, non-earthquake events), each error code, and
how the plugin behaves at a scrubbed moment. Run the tests with `vp test run` in
`packages/sources`, or `pnpm test` at the root.

## Registering it

1. Export it from `packages/sources/src/index.ts`, next to its neighbours:

   ```ts
   export * from "./example-quakes/index.ts";
   ```

2. Add it to `createSources` in `apps/web/src/data/registry.ts`, the one place plugins are
   switched on. The order is the order they start in:

   ```ts
   usgsQuakes,
   exampleQuakes,
   osmCables,
   ```

3. Update the expected list in `apps/web/src/data/registry.test.ts`. That test also checks that
   no registered plugin needs a key and that every licence allows display.

4. Give it a short credit for the line on the map in `MAP_CREDITS` in
   `apps/web/src/app/controller.ts` (without one, the provider's `name` is used), and check the
   full credit appears on the about page.

5. Add its row to [DATA_LICENCES.md](DATA_LICENCES.md): the layer, the source with a link, the
   licence, whether it allows display, redistribution and commercial use, the rate limit you
   stay under, any key, and the path (browser, gateway or static asset). Add the exact credit
   to the "Required credit" table. Keep the facts in the plugin's `licence` and the row in
   step: if they disagree, both are wrong.

Then run `pnpm typecheck`, `pnpm test` and the app, and switch the layer on and off a few
times to see the loading, live and error states in the dock.

## The gateway side: Upstream

Some feeds cannot run in a browser: the key must stay secret, the provider sends no CORS
headers, or its rate limit must be shared by every visitor rather than spent once per tab.
Those are written in Rust for the gateway, which connects once and fans the data out. Today
the gateway carries the `aircraft` and `ships` layers (`Kind` in `apps/gateway/src/model.rs`);
a feed for another layer also needs a protocol change, so open an issue first.

The trait, in `apps/gateway/src/upstream/mod.rs`, is the gateway's mirror of `SourcePlugin`:

```rust
pub trait Upstream: Send + 'static {
    /// Who the provider is and what its terms allow.
    fn info(&self) -> SourceInfo;

    /// Run until shutdown, pushing observations through `ctx`. Reconnects and
    /// rate limiting are the feed's own business.
    fn run(self: Box<Self>, ctx: UpstreamContext) -> BoxFuture;
}
```

- `info()` returns a `SourceInfo`: `id`, `name`, `kind`, a `Licence` (the same fields as
  `LicenceInfo`), the credit line and its link, `docs`, `requires_key` and a short `coverage`
  phrase. `/v1/attribution` serves it, and the layer's credit in `hello` is built from it.
- `run()` loops until shutdown. Hand normalised `Observation`s (an id, an optional `Fix`, a
  category and facts) to `ctx.push()`. Report health with `ctx.state.set_status()` and
  `ctx.state.record_request()`, and wait with `ctx.sleep()`, which returns `false` once the
  gateway is shutting down. The world state merges observations by ICAO address or MMSI
  (newest fix wins, facts accumulate); the fan-out code never changes.

A complete feed, `apps/gateway/src/upstream/example.rs`, polling a made-up JSON snapshot:

```rust
//! Example ship feed: one JSON snapshot of positions, polled every minute.

use std::time::{Duration, Instant};

use anyhow::{anyhow, bail};
use serde::Deserialize;

use super::{BoxFuture, Licence, SourceInfo, Upstream, UpstreamContext};
use crate::config::Config;
use crate::model::{Fix, Kind, Observation, UpstreamStatus};
use crate::protocol::MetaKey;

const URL: &str = "https://ais.example.org/v1/positions.json";
const INTERVAL: Duration = Duration::from_secs(60);

/// One record of the provider's snapshot, as far as this feed reads it.
#[derive(Debug, Deserialize)]
pub struct Record {
    pub mmsi: u32,
    pub lon: f64,
    pub lat: f64,
    /// Knots.
    pub sog: f64,
    /// Degrees, absent when unknown.
    pub cog: Option<f64>,
    /// Unix epoch milliseconds.
    pub time: i64,
    pub name: Option<String>,
}

/// Turn the provider's format into observations. A plain function, so it is
/// tested against a recorded sample in `tests/fixtures`.
pub fn normalise(body: &[u8]) -> anyhow::Result<Vec<Observation>> {
    let records: Vec<Record> = serde_json::from_slice(body)?;
    Ok(records
        .into_iter()
        .filter(|r| r.lon.abs() <= 180.0 && r.lat.abs() <= 90.0)
        .map(|r| {
            let mut o = Observation::new(r.mmsi);
            // SI units in, the wire format's units out: Fix::from_si does the conversion.
            o.fix = Some(Fix::from_si(r.lon, r.lat, 0.0, r.cog, r.sog * 0.514_444, 0.0, 0, r.time));
            if let Some(name) = &r.name {
                o.fact(MetaKey::Label, name);
            }
            o.fact(MetaKey::Source, "example-ais");
            o
        })
        .collect())
}

pub struct ExampleAis;

impl ExampleAis {
    pub fn new(_config: &Config) -> ExampleAis {
        ExampleAis
    }

    async fn fetch(ctx: &UpstreamContext) -> anyhow::Result<Vec<Observation>> {
        let started = Instant::now();
        let result = async {
            let response = ctx
                .http
                .get(URL)
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| anyhow!(e.without_url()))?;
            if !response.status().is_success() {
                bail!("HTTP {}", response.status().as_u16());
            }
            let body = response.bytes().await.map_err(|e| anyhow!(e.without_url()))?;
            normalise(&body)
        }
        .await;
        ctx.state.record_request(started.elapsed(), result.is_ok());
        result
    }

    async fn run_loop(self, mut ctx: UpstreamContext) {
        ctx.state.set_status(UpstreamStatus::Degraded, "Starting.");
        while !ctx.is_shutdown() {
            match Self::fetch(&ctx).await {
                Ok(observations) => {
                    let n = observations.len();
                    ctx.push(observations).await;
                    ctx.state.set_status(UpstreamStatus::Ok, format!("Last snapshot held {n} ships."));
                }
                Err(e) => ctx.state.set_status(UpstreamStatus::Degraded, format!("Last request failed: {e:#}.")),
            }
            // Returns false when the gateway starts shutting down.
            if !ctx.sleep(INTERVAL).await {
                break;
            }
        }
    }
}

impl Upstream for ExampleAis {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "example-ais",
            name: "Example AIS",
            kind: Kind::Ship,
            licence: Licence {
                name: "CC BY 4.0",
                url: "https://creativecommons.org/licenses/by/4.0/",
                display: true,
                redistribution: true,
                commercial: true,
                notes: "Credit with a link. One request a minute at most.",
                verified: "2026-11-14",
            },
            attribution: "Ship positions: Example AIS, CC BY 4.0",
            attribution_url: "https://ais.example.org/",
            docs: "https://ais.example.org/api/",
            requires_key: None,
            coverage: "the example coast",
        }
    }

    fn run(self: Box<Self>, ctx: UpstreamContext) -> BoxFuture {
        Box::pin(self.run_loop(ctx))
    }
}
```

`e.without_url()` matters: request errors otherwise include the URL, which may carry a key.
Never log a key or put one in a status note.

To switch it on, declare the module in `upstream/mod.rs` (`pub mod example;`) and add it to
`build()` there. Decide whether it runs by default; feeds whose terms are unclear for a public
site are off unless listed in `UPSTREAMS`:

```rust
// Off unless listed in UPSTREAMS.
if config.source_enabled("example-ais", false) {
    feeds.push(Box::new(example::ExampleAis::new(config)));
}
```

Test the normaliser against a recorded sample in `apps/gateway/tests/fixtures`, as
`tests/normalisers.rs` does for every real feed:

```rust
use std::path::PathBuf;

use orya_halo_gateway::protocol::MetaKey;
use orya_halo_gateway::upstream::example;

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

#[test]
fn example_ais_sample_parses() {
    let observations = example::normalise(&fixture("example_ais.json")).unwrap();
    // The record with an impossible longitude is dropped.
    assert_eq!(observations.len(), 1);
    let ship = &observations[0];
    assert_eq!(ship.id, 230_123_456);
    assert!((ship.fix.unwrap().lon() - 24.95).abs() < 1e-6);
    assert!(ship.meta.contains(&(MetaKey::Label, "EXAMPLE STAR".to_owned())));
}
```

If the feed takes a key or a setting, read it in `apps/gateway/src/config.rs` and document it
in `apps/gateway/.env.example` (a test fails if the two drift apart). Add the feed to the
sources table in `apps/gateway/README.md` and to [DATA_LICENCES.md](DATA_LICENCES.md) with
"gateway" as its path. Only data whose terms allow redistribution may pass through the
gateway.

Run `cargo test`, `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` in
`apps/gateway`, then try it against the real provider once, gently, and in mock mode for
everything else.
