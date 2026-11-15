# Orya Halo gateway

One small Rust service that connects to public aircraft and ship feeds once,
normalises them, and fans out to browsers over WebSocket, sending each client
only what its viewport needs. The wire protocol is in
[`docs/PROTOCOL.md`](../../docs/PROTOCOL.md); the reasons for a gateway, and for
Rust, are in [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

## Run it

On Windows, put cargo and gcc on the path first: `source scripts/env.sh`
(from the repository root, in Git Bash). Linux and macOS need only a Rust
toolchain (1.89 or newer) and a C compiler.

```sh
cd apps/gateway
cargo run --release              # live feeds, no keys needed
cargo run --release -- --mock    # synthetic traffic, no network access
```

It listens on `0.0.0.0:8787`. Then:

```sh
curl http://localhost:8787/health
curl "http://localhost:8787/v1/search?q=BAW"
```

and point the web app at `ws://localhost:8787`.

| Endpoint                                    | What it does                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/stream?v=1`                        | The WebSocket. Add `&z=1` for frame compression (below).                                                                                                                                 |
| `GET /health`                               | Liveness, entity counts, tick timings, per-upstream status and counters, the adsb.lol request budget, aircraft sweep progress, the wildfire cache, the satellite element cache.          |
| `GET /metrics`                              | Prometheus text: clients, entities, ticks, frames and bytes sent, upstream requests, errors, 429s and latency, request budget, wildfire and satellite cache hits and misses.             |
| `GET /v1/entity/{kind}/{id}`                | Latest fix, facts, recent track; for airline flights, origin and destination. `kind` is `aircraft`, `ship`, `1` or `2`; `id` is the number sent in Upsert frames (or hex as `0x4ca7b5`). |
| `GET /v1/search?q=&limit=`                  | Callsign, registration, ship name, IMO, MMSI or hex address. Exact matches first, then prefixes, then substrings. At most 50 results.                                                    |
| `GET /v1/attribution`                       | Every source in use with licence, credit text and what its terms allow.                                                                                                                  |
| `GET /v1/proxy/firms/{source}/world/{days}` | NASA FIRMS active fires as CSV, from a shared cache (below).                                                                                                                             |
| `GET /v1/proxy/celestrak/{group}.csv`       | CelesTrak satellite elements (OMM CSV) for `active` or `stations`, one download per update for everybody (below).                                                                        |

Tests, lints and the load check:

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo run --release --example loadcheck
```

## Configuration

Everything is an environment variable; a `.env` file in the working directory
is read too (never commit it). [`.env.example`](.env.example) lists every
variable with its default, and a test keeps that file in step with the code.
The ones most deployments touch:

| Variable              | Default                              | Meaning                                                                                                                  |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `BIND_ADDR`, `PORT`   | `0.0.0.0:8787`                       | Where to listen.                                                                                                         |
| `ALLOWED_ORIGINS`     | any localhost origin                 | Sites that may use the API and open a stream. Enforced on the WebSocket handshake as well as by CORS.                    |
| `TRUST_PROXY`         | `false`                              | Take the client address from `Fly-Client-IP` / `X-Forwarded-For`.                                                        |
| `UPSTREAMS`           | `adsb-lol,digitraffic,aisstream`     | Which feeds run.                                                                                                         |
| `ADSBLOL_API_KEY`     | none                                 | Raises adsb.lol's request quota.                                                                                         |
| `ADSBLOL_BUDGET_FILE` | under the system temporary directory | Where the adsb.lol request budget is kept between runs. `off` keeps it in memory.                                        |
| `FIRMS_MAP_KEY`       | none                                 | NASA FIRMS key for the wildfire proxy.                                                                                   |
| `CELESTRAK_CACHE_DIR` | under the system temporary directory | Where the satellite cache keeps its last copy and the time of its last request between runs. `off` keeps them in memory. |
| `AISSTREAM_API_KEY`   | none                                 | Ships worldwide.                                                                                                         |
| `MOCK`                | off                                  | `aircraft:20000,ships:50000` for synthetic traffic.                                                                      |

## Sources and their terms

Terms were read on 2026-11-14. `/v1/attribution` serves this table as JSON.

| Id               | Layer              | Coverage                                                          | Licence                                                                                                             | Key                 | On by default                        |
| ---------------- | ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------ |
| `adsb-lol`       | aircraft           | 250 nm circles: watched areas first, the rest as the quota allows | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)                                                          | optional            | yes                                  |
| `adsb-lol-reapi` | aircraft           | whole world, every 30 s                                           | ODbL 1.0                                                                                                            | feeder IP           | no                                   |
| `adsb-fi`        | aircraft           | whole world, one 250 nm circle a second                           | [personal, non-commercial](https://github.com/adsbfi/opendata)                                                      | none                | no                                   |
| `digitraffic`    | ships              | Finnish waters, northern Baltic (class A, no fishing vessels)     | [CC BY 4.0](https://www.digitraffic.fi/en/terms-of-service/)                                                        | none                | yes                                  |
| `aisstream`      | ships              | worldwide                                                         | none published                                                                                                      | `AISSTREAM_API_KEY` | yes, idle without a key              |
| route lookup     | aircraft detail    | scheduled airline flights                                         | [CC0](https://github.com/vradarserver/standing-data)                                                                | none                | yes                                  |
| `nasa-firms`     | wildfires (proxy)  | worldwide                                                         | [NASA open data, CC0](https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance) | `FIRMS_MAP_KEY`     | yes, answers "needs key" without one |
| `celestrak-gp`   | satellites (cache) | worldwide                                                         | [CelesTrak usage policy](https://celestrak.org/usage-policy.php), U.S. Government data                              | none                | yes, fetches only when asked         |

### Aircraft: what is achievable for free

No free source serves the whole sky to an anonymous client any more.

- **adsb.lol without a key**: 500 requests a day per IP address, each a circle
  of at most 250 nm. In a live test, bursts were also refused above roughly
  ten requests a minute, so the gateway spaces unkeyed requests ten seconds
  apart. Covering the Earth takes 1,236 such circles, so a keyless gateway
  shows the areas people are looking at and little else.
- **adsb.lol ad-hoc key** (free, by [request form](https://www.adsb.lol/request)):
  1,000 requests a day. Set `ADSBLOL_API_KEY`.
- **adsb.lol feeder key** (free for anyone who runs a receiver and feeds the
  network): 7,200 requests a day. Set `ADSBLOL_API_KEY` and
  `ADSBLOL_DAILY_QUOTA=7200`. A feeder may also fetch the **whole world twice a
  minute** from the re-api, which only answers the feeding station's own IP
  address: run the gateway there (or route through it) with
  `UPSTREAMS=adsb-lol-reapi,digitraffic,aisstream`. This is the legitimate way
  to a full, fresh globe, and it is not tested here because it needs a feeder.

#### The adsb.lol request budget

The daily allowance is never exceeded, however many people watch and however
often the gateway is restarted. It is kept as a token bucket
(`src/upstream/budget.rs`):

- The bucket holds a tenth of the day's allowance, the _burst_. While it has
  requests to give and somebody is watching aircraft, one goes out per
  spacing interval.
- It refills evenly with the other nine tenths over 24 hours. Burst plus a
  day's refill is exactly the allowance, so no 24-hour window, wherever it
  starts, holds more requests than that.
- **Nobody watching, nothing spent.** With no client subscribed to the
  aircraft layer the feed makes no requests at all; a client that only
  watches ships does not count. The bucket refills meanwhile, up to the burst.
- The bucket is written to `ADSBLOL_BUDGET_FILE` before each request and
  read back at start-up, so a restart resumes with what was left. Two
  gateways on one machine share the file (under a lock), as they share the
  allowance at adsb.lol, which counts per IP address. With the file switched
  off, or lost, a restart begins with a full burst: keep it on, and on a host
  whose temporary directory does not survive a redeploy, point it at a volume.
- When the bucket is empty the aircraft layer reports _degraded_, its credit
  line in `hello` and `/v1/attribution` gains a sentence saying that
  positions refresh slowly for now, and requests carry on at the refill
  rate. It recovers by itself. `/health` shows the numbers under
  `upstreams[].budget` (`availableNow`, `spentToday`, `leftToday`, `waitS`),
  `/metrics` as `halo_upstream_budget_*`.
- If adsb.lol itself answers 429 with a long `Retry-After`, nothing is sent
  until that time has passed, across restarts too.

What that means for someone opening the map:

| Key    | Allowance   | First minutes                                                                                  | After that, while watched                                                                                            | Nobody watching                                 |
| ------ | ----------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| none   | 500 a day   | 50 requests, one every 10 s: the area in view fills at once and stays live for about 8 minutes | one request every 3 min 12 s: the area in view is refreshed a few times an hour, the rest of the world hardly at all | no requests; the burst is back after 2 h 40 min |
| ad-hoc | 1,000 a day | 100 requests, one every 2 s                                                                    | one request every 96 s                                                                                               | no requests                                     |
| feeder | 7,200 a day | 720 requests, one every 2 s: 24 minutes                                                        | one request every 13 s: an area in view stays close to live, and the busy parts of the world fill in slowly          | no requests                                     |

So without a key the aircraft layer is a demonstration: live where you look
for the first minutes, then slow. A free ad-hoc key doubles that. A feeder
key keeps a watched area live all day; the re-api (feeders only) is what
gives the whole world.

- **adsb.fi** allows one request a second. In a four-minute live test that
  found 10,400 aircraft from the 212 busiest circles; the first pass over
  the whole world takes about an hour, and after it airspace with traffic is
  re-read every four to five minutes (whatever somebody is looking at, every
  few seconds). Its open data is "for personal, non-commercial use only", so
  it is off by default. Turn it on (`UPSTREAMS=adsb-lol,adsb-fi,...`) for a
  private instance, or after asking adsb.fi about a public one. Credit and
  link adsb.fi if you do.

Feeds that poll by circle share one scheduler (`src/upstream/aircraft.rs`):

- Tiles overlapping what clients are looking at are _hot_: refreshed every
  `AIRCRAFT_HOT_INTERVAL_S` and given three request slots in four.
- The rest are _background_. Of their slots, two in three go to tiles already
  fetched (those that held aircraft as fast as the budget allows, empty ones
  backing off from five minutes to an hour) and one in three to tiles never
  fetched, likeliest traffic first. So a cold start shows busy airspace
  within seconds, and the first pass over the oceans never stalls it.
- An aircraft missing from a fresh answer for the circle it was well inside
  is removed at once; otherwise aircraft are kept for one and a half revisits
  of their area (at most `AIRCRAFT_MAX_TTL_S`) and flagged stale after
  `AIRCRAFT_STALE_S`, so nothing blinks out between sweeps and nothing old
  pretends to be live.
- On HTTP 429 the feed waits for `Retry-After`, then halves its pace; a
  `Retry-After` of fifteen minutes or more is treated as the daily quota
  and nothing is sent until it has passed.

Not used: **OpenSky Network** (its terms restrict use to research and
forbid passing data to third parties) and **airplanes.live** (its terms forbid
public display and redistribution without written permission, and its API
answered 403).

### Ships

- **Digitraffic** needs no key: a REST snapshot fills the map at start-up
  (two requests), then MQTT over WebSocket delivers every position report.
  The service asks for a `Digitraffic-User` header naming the application
  (`DIGITRAFFIC_USER`).
- **AISStream** covers the world with a free key. It publishes no licence or
  terms of use; its documentation tells integrators to keep the key on a
  server and "proxy only the information your clients need", which is what
  the gateway does. Treat it as tolerated rather than licensed, and ask the
  provider before anything commercial. The connection uses
  `permessage-deflate`, which the service now expects.
- Without a key the ships layer reports status _ok_ with only the Digitraffic
  coverage, and the attribution text in `hello` says so and names the key that
  would widen it. With neither feed running it reports _needs key_.
- Checked and not used: the **Norwegian Coastal Administration**'s open AIS
  stream (NLOD licence, free to redistribute) would add the Norwegian coast,
  but its raw TCP endpoint could not be reached from the development network,
  so it is not integrated.

### Wildfires: the NASA FIRMS proxy

The web app's fire layer reads NASA FIRMS, which sends no CORS headers and
whose key must not ship in a browser. So the gateway holds the key and serves
`GET /v1/proxy/firms/{source}/world/{days}`: the CSV exactly as FIRMS
returns it, for `MODIS_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT` or
`VIIRS_SNPP_NRT` and 1 to 5 days. Anything else is a 400.

- **One request for everybody.** Each of the 20 possible files is cached,
  gzip-compressed, for `FIRMS_CACHE_TTL_S` (20 minutes). Clients that ask
  while a file is being fetched wait for that one answer.
- **Far inside the limit.** A FIRMS key allows 5,000 transactions per ten
  minutes, and a large request may count as several. The proxy can make at
  most 20 requests per cache lifetime, does not retry a failed file for a
  minute, stops asking altogether for ten minutes when FIRMS refuses the
  key, and has a hard ceiling of 60 requests per ten minutes whatever
  clients do.
- **When FIRMS fails**, the last copy is served for up to six hours, marked
  `X-Halo-Cache: stale` with its age in `Age`. With no copy the answer is a
  502 with a plain message.
- **Without a key** the answer is `503` with code `needs_key`, and the same
  when FIRMS answers "Invalid MAP_KEY". Get a free key at
  <https://firms.modaps.eosdis.nasa.gov/api/map_key/> and set `FIRMS_MAP_KEY`.
- **The key stays put.** It is added to the outgoing request only. It is not
  logged, not part of any error message, and nothing FIRMS says is passed on
  in an error.
- Files larger than `FIRMS_MAX_BYTES` are refused, and the whole cache is
  kept under 48 MB by dropping the oldest files.
- In mock mode the proxy is off (503 `unavailable`), like every other
  outside request.

Point the web app's fire source at `{gateway}/v1/proxy/firms`. FIRMS data is
open NASA data (CC0 for NASA-led missions), so passing it on is allowed; NASA
asks to be acknowledged as the source and must not be shown as endorsing the
app.

### Satellites: the CelesTrak cache

The web app's satellite layer propagates CelesTrak GP element sets in the
browser. CelesTrak serves each group once per data update (every 2 hours) to
each IP address and answers a repeat with HTTP 403; addresses that keep
erroring end up in its firewall. Its [usage policy](https://celestrak.org/usage-policy.php)
asks deployments with many users behind one address to cache through their
own proxy, and this is it: `GET /v1/proxy/celestrak/{group}.csv` for
`active` (what the web app uses, about 2.5 MB, 17,000 objects) or
`stations` (a few dozen, for testing). Anything else is a 400 `bad_group`.

- **One download per update for everybody.** Each group is kept in memory,
  gzip-compressed, and served to every client. It is refreshed only when a
  client asks and the copy is older than `CELESTRAK_REFRESH_S` (2 hours,
  never less); an idle gateway asks CelesTrak nothing. Clients that ask while
  a refresh is running wait for that one answer.
- **One attempt per window, whatever happens.** A 403, any other status, a
  redirect (not followed: CelesTrak uses 301 for outdated URLs), a timeout, a
  file over `CELESTRAK_MAX_BYTES` or one that is not OMM CSV ends the attempt,
  and the group is not asked for again until two hours after it. There is no
  retry loop.
- **When CelesTrak refuses or cannot be reached**, the last good copy is
  served for up to `CELESTRAK_MAX_STALE_S` (7 days), marked
  `X-Halo-Cache: stale` with its age in `Age`. With no copy the answer is
  `503` with code `unavailable`, a plain message and `Retry-After` set to
  when the gateway may ask again.
- **Caching downstream.** `Cache-Control: public, max-age` lets browsers and
  CDNs keep an answer until the gateway could have a newer copy, between one
  minute and an hour (`max-age` counts from the fetch, as `Age` does). A
  weak `ETag` comes with it, and `If-None-Match` gets a `304`.
- **Restarts.** The last good copy and the time of the last request are saved
  in `CELESTRAK_CACHE_DIR`, so a restart (or a crash mid-download) neither
  spends another download nor forgets a refusal.
- **Manners.** The User-Agent is `HTTP_USER_AGENT` plus a description of the
  cache, nothing about the operator.
- In mock mode the cache is off (`503` `unavailable`, no `Retry-After`): the
  web app then shows the satellite snapshot it ships with, which is the full
  catalogue rather than a small sample.

The web app uses `{gateway}/v1/proxy/celestrak/active.csv` whenever
`VITE_GATEWAY_URL` is set. CelesTrak data carries no licence restriction on
passing it on; credit "Satellite orbits: CelesTrak, from U.S. Space Force GP
data".

### Attribution you must show

- NASA FIRMS, when the fire layer is on: "Active fire data: NASA FIRMS", with
  a link to <https://firms.modaps.eosdis.nasa.gov/>.
- CelesTrak, when the satellite layer is on: "Satellite orbits: CelesTrak,
  from U.S. Space Force GP data", with a link to <https://celestrak.org/>.

- adsb.lol: "Contains information from adsb.lol, which is made available here
  under the Open Database License (ODbL)", with links to adsb.lol and the
  licence. ODbL is share-alike for databases derived from it.
- Digitraffic: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY", with a
  link, and a note that the data has been modified (it is normalised).
- adsb.fi, if enabled: cite adsb.fi and link to its home page.
- AISStream: none requested; "Ship positions from AISStream.io" is sent.

## Adding a source

Implement `Upstream` (`src/upstream/mod.rs`): `info()` describes the provider,
its licence and credit; `run()` loops, turning the provider's format into
`Observation`s and handing them to `ctx.push()`. Add one line to
`upstream::build`. The world state merges by ICAO address or MMSI (newest fix
wins, facts accumulate), and the fan-out code is untouched. Normalisers are
plain functions tested against recorded samples in `tests/fixtures`.

## Mock mode

`--mock` or `MOCK=aircraft:20000,ships:50000` replaces every feed with a
seeded simulation: aircraft fly between real hubs and report every second,
ships follow the main sea lanes or sit in port and report at AIS cadence, and
one aircraft squawks 7700 for a minute every ten so the ticker has something
to show. No request leaves the machine.

## How it stays cheap

- One task owns the world state and the hub. Upstreams, sockets and HTTP
  handlers talk to it through channels, so nothing is locked on the hot path.
- Every entity is indexed by its H3 cell at resolution 3. A subscription is a
  set of cells at resolution 1, 2 or 3, or the whole world.
- Clients with the same subscription form a group, and each frame is built
  (and compressed) once per group per tick. A client in step with its group
  holds exactly the entities in the group's cells, so its "known set" never
  has to be stored: FULL after a `sub`, then deltas.
- A slow client has a bounded queue. When it fills, that client's deltas are
  dropped and it gets a FULL when it has caught up; the tick never waits. A
  client that cannot take a frame for twenty seconds is disconnected.
- A large FULL is split: the first 4,096 entities carry the FULL flag, the
  rest follow as ordinary upserts. No single message is larger than a chunk.

### Frame compression

Axum's WebSocket stack (tungstenite) does not implement `permessage-deflate`,
so compression is done per frame instead, which also lets a compressed frame
be shared by every client in a group. A client that connects with `?z=1` may
receive frames with header flag bit 1 (`0x0002`) set: bytes 0 to 23 are the
normal header, and everything after is raw DEFLATE (RFC 1951) of the body. In
a browser that is `DecompressionStream("deflate-raw")`. Only bodies of
`COMPRESS_MIN_BYTES` or more are compressed, and only when that makes them
smaller.

Measured on mock traffic (20,000 aircraft, 50,000 ships), compressed size as
a share of the original:

| Frame                              | Level 1   | Level 4   | Level 9   |
| ---------------------------------- | --------- | --------- | --------- |
| Upsert, FULL or delta              | 65 to 77% | 63 to 77% | 62 to 77% |
| Meta                               | 14 to 31% | 12 to 26% | 12 to 25% |
| Density                            | 54 to 58% | 52 to 57% | 51 to 56% |
| A whole-world session's first 12 s | 42%       | 40%       | 39%       |
| Speed                              | 375 MB/s  | 112 MB/s  | 25 MB/s   |

Level 1 is the default. Facts compress very well, positions poorly (they are
close to random bits), so the saving is large when a view loads and about a
quarter in steady state.

### Load check

`cargo run --release --example loadcheck` starts a mock gateway and connects
simulated clients with a mix of subscriptions; `LOAD_TARGET=host:port`
measures a gateway running as its own process instead. On a desktop PC, the
gateway alone, with every aircraft moving every second:

|                 | 300 clients    | 600 clients | 400 clients, all viewports distinct |
| --------------- | -------------- | ----------- | ----------------------------------- |
| Tick time, mean | 6.5 ms         | 9.6 ms      | 12.7 ms                             |
| Tick time, max  | 26 ms          | 26 ms       | 32 ms                               |
| CPU             | 8.5% of a core | 15.7%       | 9.2%                                |
| Memory          | 96 MB          | 130 MB      | 102 MB                              |

With nobody connected the same world (70,000 entities) takes 56 MB and a tick
takes under half a millisecond. Per client and second: about 105 KB for the
whole world as points (mock worst case; real feeds change far less often),
11 KB for density only, 8 to 33 KB for a viewport.

## Deploying

The gateway must be a long-running process: clients hold WebSockets open,
the state is in memory, and upstream connections and quotas are shared by
everyone. Serverless functions fit none of that.

- [`Dockerfile`](Dockerfile): multi-stage, distroless, non-root, about 35 MB.
  `docker build -t orya-halo-gateway apps/gateway`
- The adsb.lol request budget is saved under the temporary directory. If
  that does not survive a redeploy on your host, set `ADSBLOL_BUDGET_FILE` to
  a path on a volume, or every redeploy starts with a fresh burst.
- [`fly.toml`](fly.toml): one always-on shared-CPU machine with a health
  check. Set `ALLOWED_ORIGINS` and any keys (`fly secrets set ...`) first.
- Run exactly one instance. A second would double every upstream request and
  show its clients a different world.
- Put it behind TLS (browsers on an `https` page need `wss`) and set
  `TRUST_PROXY=true` only when the proxy in front is yours.
- Note that upstream request quotas are per IP address: a shared egress
  address shares the quota with whoever else uses it.
