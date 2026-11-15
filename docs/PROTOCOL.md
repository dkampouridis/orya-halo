# Halo wire protocol, version 1

How the gateway (`apps/gateway`) talks to clients. The TypeScript codec lives in
`packages/schema/src/protocol.ts`, the Rust codec in `apps/gateway/src/protocol.rs`.
Both are tested against the golden files in `packages/schema/fixtures/*.bin`. If the two
ever disagree, the fixtures are right.

## Transport

- One WebSocket per client: `GET /v1/stream?v=1`. Add `&z=1` to allow compressed frames
  (see [Frame compression](#frame-compression)).
- Server to client data: **binary** frames, little-endian, described below.
- Client to server, and server control messages: small **JSON text** frames. They are rare
  (a subscription change, a ping), so they are not on the hot path.
- `permessage-deflate` is not used. Compression is done per frame instead, so one
  compressed frame can be shared by every client that receives it.

### Refused handshakes

A handshake the gateway will not accept is answered with a plain HTTP response and the
usual error body (`{"error":{"code":"…","message":"…"}}`), not with a WebSocket close.

| Status | Code                   | When                                                   |
| ------ | ---------------------- | ------------------------------------------------------ |
| 400    | `unsupported_version`  | `v` is present and is not `1`. Leaving `v` out means 1 |
| 403    | `origin_not_allowed`   | The `Origin` header is not on the gateway's allow-list |
| 429    | `too_many_connections` | Too many connections from this address (8 by default)  |
| 503    | `server_full`          | The gateway is at its connection limit                 |

### Closing

The gateway closes with code **1001** (going away) and a reason in plain words, in two
cases: it is shutting down, or it heard nothing from the client (no message, no pong) for
about 60 seconds. Reconnect and subscribe again. It pings every 20 seconds; browsers answer
by themselves.

A client that cannot take a frame for 20 seconds, or sends a message larger than 128 KiB,
is disconnected, usually without a close frame. Nothing else a client sends closes the
connection: mistakes are answered with an `error` message and the connection stays open.

## Client to server (JSON)

```jsonc
// Replace the subscription. Sent when the camera settles.
{ "t": "sub",
  "layers": ["aircraft", "ships"],   // layers wanted; others are dropped
  "res": 2,                          // H3 resolution of `cells`: 1, 2 or 3. 0 = whole world
  "cells": ["823f67fffffffff"],      // H3 indexes at `res`, hex. Ignored when res is 0
  "points": true,                    // send individual entities
  "density": false }                 // send per-cell Density frames

{ "t": "ping", "id": 7 }
```

`layers` and `res` are required. `cells` defaults to none, `points` to true, `density` to
false. Duplicate cells are ignored.

A `sub` replaces the previous subscription entirely. A message the gateway cannot accept
is answered with an `error`, and the previous subscription stays in force.

For a layer left out of `layers`, or with `points` set to false, the gateway sends nothing
more about that layer's entities, not even a Remove: the client drops what it holds.

At most 60 messages are accepted per 10 seconds; the rest are answered with
`rate_limited` and otherwise ignored.

## Server to client control (JSON)

```jsonc
{ "t": "hello", "v": 1, "tickMs": 1000, "maxCells": 2000, "densityRes": 2,
  "layers": { "aircraft": { "status": 1, "attribution": "…" },
              "ships":    { "status": 3, "attribution": "…" } } }
{ "t": "pong", "id": 7 }
{ "t": "error", "code": "bad_request", "message": "…" }
```

`hello` is the first message on every connection. `status` is an `UpstreamStatus`:
0 off, 1 ok, 2 degraded, 3 needs key, 4 down. `attribution` is the credit line to show for
the layer. It can end with a sentence about the layer's state, for example which key would
widen coverage, or that a provider's request allowance is used up for now. Later changes of
status arrive in Stats frames; `GET /v1/attribution` has the current text.

`pong` carries the `id` of the `ping`, whatever JSON value that was.

`error` codes:

| Code             | Meaning                                                                                |
| ---------------- | -------------------------------------------------------------------------------------- |
| `bad_request`    | Not JSON, not a known message, a field missing or of the wrong type, or a binary frame |
| `bad_layer`      | A layer other than `aircraft` or `ships`                                               |
| `bad_resolution` | `res` is greater than 3                                                                |
| `bad_cell`       | A cell is not an H3 index, or not at resolution `res`                                  |
| `too_many_cells` | More than `maxCells` cells                                                             |
| `rate_limited`   | Too many messages; wait a few seconds                                                  |

`message` is one plain sentence, fit to show to a person.

## Binary frames

Every frame starts with a 24-byte header.

| Offset | Type | Field    | Notes                                                                      |
| ------ | ---- | -------- | -------------------------------------------------------------------------- |
| 0      | u8   | magic    | `0x48` (`H`)                                                               |
| 1      | u8   | version  | `1`                                                                        |
| 2      | u8   | type     | see below                                                                  |
| 3      | u8   | kind     | `EntityKind`: 1 aircraft, 2 ship. 0 when not about one kind                |
| 4      | u16  | flags    | bit 0 (`0x0001`) `FULL`, Upsert only. Bit 1 (`0x0002`) `DEFLATE`, any type |
| 6      | u16  | reserved | 0                                                                          |
| 8      | f64  | timeMs   | server clock, Unix epoch milliseconds                                      |
| 16     | u32  | count    | records in the body                                                        |
| 20     | u32  | aux      | Density: H3 resolution. Otherwise 0                                        |

Bodies are **columnar**: all values of one field, then all values of the next. With the
24-byte header, every column below starts on a multiple of its element size for any `count`,
so a client can view the columns as typed arrays without copying.

### Frame compression

A client that connects with `?z=1` may receive frames with the `DEFLATE` flag set. In such
a frame bytes 0 to 23 are the header as usual and everything after them is the body
compressed with raw DEFLATE (RFC 1951, no zlib or gzip wrapper). The header describes the
frame as it is after inflating: `count`, `aux`, `timeMs` and the `FULL` flag mean what they
always mean, so a frame can be routed before it is inflated. Inflate the body, clear the
flag, and decode as usual: `inflateFrame` in the TypeScript codec does this with
`DecompressionStream("deflate-raw")`.

- Only bodies of 512 bytes or more are compressed, and only when that makes them smaller.
  Smaller frames, and Stats frames always, arrive as they are, so a client must check the
  flag on every frame.
- Without `?z=1` the flag is never set.
- Inflating is asynchronous in a browser. Frames must still be applied in the order they
  arrived.

### 1 Upsert: positions and motion

22 bytes per entity, `count` = n.

| Column   | Type   | Unit                                                              |
| -------- | ------ | ----------------------------------------------------------------- |
| ids      | u32[n] | ICAO 24-bit address, or MMSI                                      |
| lon      | i32[n] | degrees × 1e7                                                     |
| lat      | i32[n] | degrees × 1e7                                                     |
| alt      | i16[n] | 7.62 m (25 ft). 0 for ships and aircraft on the ground            |
| heading  | u16[n] | course over ground, degrees × 100. `0xFFFF` unknown               |
| speed    | u16[n] | ground speed, 0.1 m/s                                             |
| vrate    | i8[n]  | 0.5 m/s, positive up, clamped to ±127                             |
| age      | u8[n]  | seconds between the fix and `timeMs`, saturating at 255           |
| category | u8[n]  | `AircraftCategory` or `ShipCategory`                              |
| flags    | u8[n]  | `EntityFlag` bits: 1 stationary, 2 emergency, 4 military, 8 stale |

With the `FULL` header flag, the frame is the complete set for the client's subscription and
kind: anything the client holds that is not in it must be dropped. Without it, the frame is a
delta: only entities that are new to the client or have changed since the last frame.

`heading` is the course over ground, except for a ship that is not moving, where it is the
direction the bow points.

`age` 255 means "at least 255 seconds", not exactly that. Whether a position is too old to
rely on is said by the stale bit, not by `age`: it is set once a fix is older than the
layer's freshness window (45 seconds for aircraft, 10 minutes for ships by default), and
turning stale is itself sent as an upsert. So a ship can have `age` 255 without being stale.
The exact fix time of any entity is `fixTimeMs` in `GET /v1/entity/{kind}/{id}`.

An entity whose position and motion have not changed is not re-sent every tick. It is
re-sent once its fix time has moved on by 30 seconds (aircraft) or 5 minutes (ships), so
the fix time a client works out as `timeMs` minus `age` is never further behind than that.

### 2 Remove

`ids` u32[n]: entities that left the subscribed area or expired.

### 3 Meta: static facts

Sent with the Upsert that first gives a connection an entity, and again when any field
changes; a record always carries all of the entity's fields. Records are packed back to
back:

```
u32 id · u8 fieldCount · fieldCount × ( u8 key · u8 length · length bytes of UTF-8 )
```

Fields are written in ascending key order. Values longer than 255 bytes are cut at a
character boundary. Decoders skip keys they do not know. A field is only present when it is
known, and is never empty.

| Key | Name         | Value                                                                         |
| --- | ------------ | ----------------------------------------------------------------------------- |
| 1   | label        | Callsign or flight number; ship name. Trimmed                                 |
| 2   | registration | Aircraft registration, e.g. `EI-DVM`                                          |
| 3   | typeCode     | ICAO type designator, e.g. `A320`                                             |
| 4   | typeName     | Type in words: aircraft e.g. `AIRBUS A-320`; ships, see below                 |
| 5   | operator     | Operator or owner                                                             |
| 6   | origin       | Not sent in Meta. Routes come from the detail endpoint                        |
| 7   | destination  | Ships: destination as broadcast, free text                                    |
| 8   | country      | Reserved, not sent yet                                                        |
| 9   | squawk       | Transponder code, four octal digits, e.g. `7700`                              |
| 10  | imo          | IMO number: seven digits, no prefix. Left out when the ship broadcasts none   |
| 11  | callsign     | Ship radio callsign                                                           |
| 12  | lengthM      | Whole metres, decimal digits, e.g. `203`                                      |
| 13  | widthM       | Whole metres, decimal digits, e.g. `32`                                       |
| 14  | draughtM     | Metres with one decimal, e.g. `7.1`                                           |
| 15  | navStatus    | AIS navigational status as an English phrase, see below                       |
| 16  | eta          | UTC, `2026-11-15T08:00Z`, or `2026-11-15` when the time is unknown            |
| 17  | source       | Id of the feed that first reported the entity, e.g. `adsb-lol`, `digitraffic` |

`navStatus` is one of: `Under way using engine`, `At anchor`, `Not under command`,
`Restricted manoeuvrability`, `Constrained by draught`, `Moored`, `Aground`,
`Engaged in fishing`, `Under way sailing`, `Towing astern`,
`Pushing ahead or towing alongside`, `AIS-SART active`.

For ships, `typeName` is the AIS ship-and-cargo type as one of these phrases, which are
stable: the web app picks a ship's 3D model and colours from them, so changing one is a
protocol change. `Wing in ground craft`, `Fishing vessel`, `Towing vessel`,
`Dredger or underwater operations`, `Diving vessel`, `Military`, `Sailing vessel`,
`Pleasure craft`, `High-speed craft`, `Pilot vessel`, `Search and rescue vessel`, `Tug`,
`Port tender`, `Anti-pollution vessel`, `Law enforcement`, `Medical transport`,
`Passenger ship`, `Cargo ship`, `Tanker`, `Other type`. It is left out for undefined codes.

AIS broadcasts an ETA without a year. The gateway picks the year that puts the date nearest
to today.

Numbers are sent as text because Meta is rare and small; parse `lengthM`, `widthM` and
`draughtM` with `Number`.

### 4 Density: per-cell counts

20 bytes per cell; `aux` is the H3 resolution (`densityRes` in `hello`).

| Column | Type   | Notes                       |
| ------ | ------ | --------------------------- |
| cellLo | u32[n] | low 32 bits of the H3 index |
| cellHi | u32[n] | high 32 bits                |
| lon    | f32[n] | cell centre, degrees        |
| lat    | f32[n] | cell centre, degrees        |
| counts | u32[n] | entities in the cell        |

Density is **global per kind**: every cell on Earth that holds at least one entity, whatever
the subscription's `cells`. Each frame is complete for its kind and replaces the previous
one. Cells are in ascending index order.

It is sent to subscriptions with `density: true`, for each of their layers:

- once straight after the `sub` that switches it on;
- then whenever the counts have changed, at most once every 5 seconds.

A `sub` that keeps density on for a kind (a pan or a zoom) does not cause it to be sent
again.

### 5 Stats

8 bytes per entry: `u8 kind · u8 status · u16 reserved · u32 total`. `total` is everything the
gateway is tracking worldwide for that kind, regardless of subscription. Sent about once a
second to every connection, subscribed or not. Never compressed.

### 6 Events

Body is a UTF-8 JSON array of `HaloEvent` (see `protocol.ts`): ticker lines such as an
emergency squawk. `count` is the array length, `kind` is 0.

```jsonc
{
  "id": "emergency-4ca7b5-7700", // stable: the same event is never announced twice
  "topic": "emergency",
  "timeMs": 1794670560000,
  "title": "EIN4KD is squawking 7700 (general emergency).",
  "lon": -5.1,
  "lat": 53.4, // four decimals
  "ref": { "kind": 1, "id": 5023669 },
  "severity": 2,
}
```

Events go to every connection that has subscribed to anything. On the tick after its first
`sub`, a connection is sent the events of the last 30 minutes in one frame (at most 64,
oldest first), if there are any; after that, each event is sent once, as it happens.

The only topic so far is `emergency`, raised when an aircraft starts squawking an emergency
code:

| Squawk     | Title                                               | Severity |
| ---------- | --------------------------------------------------- | -------- |
| 7500       | `{name} is squawking 7500 (unlawful interference).` | 2        |
| 7600       | `{name} is squawking 7600 (radio failure).`         | 1        |
| 7700       | `{name} is squawking 7700 (general emergency).`     | 2        |
| none known | `{name} is reporting an emergency.`                 | 1        |

- `id` is `emergency-{icao}-{squawk}`: the ICAO address as six lower-case hex digits, then
  the squawk, or `x` when it is not known.
- `{name}` is the callsign, or `Aircraft {icao}` when there is none.
- `severity`: 0 routine, 1 notable, 2 major.
- The same aircraft squawking the same code again within 30 minutes is the same event and is
  not repeated.
- Ships raise no events. A ship with an active AIS-SART has the emergency flag in its Upsert.

## Server behaviour

- The gateway indexes every entity by its H3 cell at resolution 3 and derives the parents at
  2 and 1. A subscription is a set of cells at one resolution, or the whole world.
- Per connection the gateway knows which entities the client holds. On each tick (`tickMs`)
  it sends, per subscribed kind, what changed: entities that are new to the client or have
  changed, the facts the client lacks, and the entities that left the subscription or expired.
- **Order within a tick.** For each kind, aircraft first: Remove, then Upsert, then Meta. So
  an id that expired and came back between two ticks ends up present, and facts never arrive
  before their entity. After the entity frames come Density, Events and Stats. Apply frames in
  the order they arrive.
- **After a `sub`**, the first Upsert for each subscribed kind carries `FULL`, even when the
  area is empty (a FULL with `count` 0 clears what the client holds). The Meta for everything
  in it follows directly.
  - A subscription to cells is answered at once, without waiting for the tick.
  - A whole-world subscription (`res: 0`) is answered on the next tick, up to `tickMs` later.
  - Because a FULL for cells can arrive between two ticks, the next delta may repeat an
    entity, or its facts, that the FULL already carried. Upsert and Meta are idempotent:
    apply them again.
- **A large FULL is split.** A set of more than 4,096 entities arrives as several Upsert
  frames in the same tick, each followed by the Meta for its entities. Only the first carries
  `FULL`; the rest are ordinary upserts that add to it. So `FULL` means "drop what you hold,
  then keep adding", not "this frame is everything". There are at most 8 such pairs by
  default; beyond 32,768 entities the frames grow instead.
- **Whole-world subscriptions** are sent at a slower cadence. Each entity has a turn every 5
  seconds (by default) and is sent then if it changed since its last turn. Clients
  dead-reckon between fixes, so this still looks continuous. Removes are not held back for a
  turn. Nothing the FULL carried is sent again until it changes.
- **A slow client never blocks others.** If its outbound queue is full, its deltas are
  dropped, and when it has caught up it is sent a `FULL` for every kind. Density, Events and
  Stats frames may simply be skipped for a client that is behind.

## HTTP endpoints

| Endpoint                                    | Purpose                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /health`                               | Liveness and per-upstream status and counters, JSON                         |
| `GET /metrics`                              | Prometheus text: clients, entities, upstream latency, frames and bytes sent |
| `GET /v1/entity/{kind}/{id}`                | Detail for one entity: latest fix, facts, recent track                      |
| `GET /v1/search?q=`                         | Find entities anywhere by callsign, registration, name or MMSI              |
| `GET /v1/attribution`                       | Upstream sources in use, with licence and credit text                       |
| `GET /v1/proxy/firms/{source}/world/{days}` | NASA FIRMS active fires as CSV                                              |
| `GET /v1/proxy/celestrak/{group}.csv`       | CelesTrak satellite elements as OMM CSV                                     |

CORS allows `GET` from the origins on the gateway's allow-list (any localhost origin when
none is configured).

### Errors

Every error from these endpoints, and from a refused handshake, has this body, with a
status that fits:

```json
{ "error": { "code": "not_found", "message": "Nothing with that id is being tracked right now." } }
```

`message` is one plain sentence, fit to show to a person.

| Status | Code                                 | Endpoint                                                  |
| ------ | ------------------------------------ | --------------------------------------------------------- |
| 400    | `bad_kind`, `bad_id`                 | entity                                                    |
| 404    | `not_found`                          | entity: nothing with that id has a position right now     |
| 400    | `missing_query`, `query_too_long`    | search: `q` empty, or longer than 64 bytes                |
| 400    | `bad_source`, `bad_days`             | wildfire proxy                                            |
| 502    | `upstream_error`, `upstream_limited` | wildfire proxy                                            |
| 503    | `needs_key`                          | wildfire proxy: no key, or NASA rejected it               |
| 503    | `unavailable`                        | the gateway is shutting down; wildfire proxy in mock mode |

### `GET /v1/entity/{kind}/{id}`

`kind` is `aircraft`, `ship`, `ships`, `1` or `2`. `id` is the number sent in Upsert frames,
or hex with a prefix (`0x4ca7b5`).

```jsonc
{
  "kind": 1,
  "id": 5023669,
  "layer": "aircraft",
  "lon": -5.1,
  "lat": 53.4,
  "alt": 10668, // metres
  "heading": 271.5, // degrees, or null when unknown
  "speed": 231.5, // metres per second
  "vrate": -6, // metres per second, positive up
  "fixTimeMs": 1794670560000, // when the position was observed
  "category": 3,
  "flags": 0, // as in Upsert
  "meta": { "label": "EIN4KD", "registration": "EI-DVM", "source": "adsb-lol" },
  "track": [[-5.3, 53.38, 10660.4, 1794670500000]], // [lon, lat, metres, timeMs], oldest first
  "source": "adsb-lol", // feed that supplied the latest fix
  "attribution": { "text": "…", "url": "https://www.adsb.lol/" },
  // Aircraft only, and only when the route is known and the aircraft is on it:
  "origin": { "code": "DUB", "name": "Dublin", "lon": -6.27, "lat": 53.42 },
  "destination": { "code": "LHR", "name": "London Heathrow", "lon": -0.46, "lat": 51.47 },
  "routeAttribution": "…",
}
```

`meta` holds the Meta fields under the names in the table above, all strings. `track` has
up to 32 points for an aircraft (at least 15 seconds apart) and 16 for a ship (at least 2
minutes apart). An airport's `code` is its IATA code, or ICAO when it has none; `name` may
be missing. The response may be cached for 2 seconds.

### `GET /v1/search?q=&limit=`

```jsonc
{
  "query": "baw4",
  "results": [
    {
      "kind": 1,
      "id": 4194305,
      "layer": "aircraft",
      "title": "BAW4", // label, or the hex address or MMSI when there is none
      "subtitle": "G-EUUU · A320", // aircraft: registration and type; ships: "MMSI 230123456"; or null
      "lon": 10.0,
      "lat": 50.0,
      "score": 100,
    },
  ],
}
```

Matching ignores case and looks at label, registration, ship callsign, IMO, the hex address
(aircraft) and the MMSI (ships). `score` is 100 for an exact match, 80 for a prefix, 50 for
a substring; an exact type code (`A320`) scores 40. Best first. `limit` defaults to 20 and
is capped at 50. No match is an empty `results`, not an error.

### `GET /v1/proxy/firms/{source}/world/{days}`

NASA FIRMS active-fire detections for the whole world, as the CSV FIRMS itself serves,
unchanged. FIRMS sends no CORS headers and its key must not ship in a browser, so the
gateway holds the key and shares one cached copy of each file with every client.

- `source`: `MODIS_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT` or `VIIRS_SNPP_NRT`.
- `days`: 1 to 5.

A successful answer is `200` with `Content-Type: text/csv; charset=utf-8`, sent gzip-encoded
to clients that accept it, and these headers:

| Header          | Meaning                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `X-Halo-Cache`  | `hit`: from the cache. `miss`: fetched for this request. `stale`: see below |
| `Age`           | Seconds since the gateway fetched the file from NASA                        |
| `Cache-Control` | `public, max-age=…`: up to 5 minutes; 1 minute for a stale copy             |

A file is fetched from NASA at most once every 20 minutes (by default), however many
clients ask, and clients that ask while it is being fetched wait for that one answer. When
NASA cannot be reached, or the key is over its limit, the last copy is served instead
(`X-Halo-Cache: stale`) for up to 6 hours; `Age` says how old it is. With no copy to serve,
the answer is `502`. A missing key, or one NASA rejects, is `503` with code `needs_key`.
Errors are sent with `Cache-Control: no-store`.

Credit: "Active fire data: NASA FIRMS".

### `GET /v1/proxy/celestrak/{group}.csv`

CelesTrak GP element sets for one group, as the OMM CSV CelesTrak itself serves for
`gp.php?GROUP={group}&FORMAT=CSV`, unchanged. CelesTrak serves each group once per data
update (every 2 hours) to each IP address and refuses repeats with `403`, so the gateway
downloads each group at most once per update and shares that copy with every client.

- `group`: `active` (every active object, what the web app uses) or `stations` (a few
  dozen, for testing). Anything else is `400` with code `bad_group`.

A successful answer is `200` with `Content-Type: text/csv; charset=utf-8`, sent gzip-encoded
to clients that accept it, and these headers:

| Header          | Meaning                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Halo-Cache`  | `hit`: from the cache. `miss`: fetched for this request. `stale`: see below                                                                                                   |
| `Age`           | Seconds since the gateway fetched the file from CelesTrak                                                                                                                     |
| `Cache-Control` | `public, max-age=…`: counted from the fetch, as `Age` is, so a cache holds the answer until the gateway could have a newer copy: at most an hour, at least a minute, from now |
| `ETag`          | A weak tag of the file's content. `If-None-Match` with it gets `304 Not Modified`                                                                                             |

A group is fetched only when a client asks for it and the cached copy is more than 2 hours
old, and at most once per 2 hours whatever the outcome: after a `403`, any other status, a
redirect, a timeout or a file that is not OMM CSV the gateway does not ask again until the
window is over. Meanwhile the last good copy is served (`X-Halo-Cache: stale`) for up to 7
days. With no copy to serve, the answer is `503` with code `unavailable` and `Retry-After`
set to the seconds until the gateway may ask CelesTrak again; in mock mode it is `503`
`unavailable` without `Retry-After`. Errors are sent with `Cache-Control: no-store`.

Credit: "Satellite orbits: CelesTrak, from U.S. Space Force GP data".

## Versioning

The version byte changes only for incompatible layout changes. New frame types and new Meta
keys are additive: decoders must ignore Meta keys they do not know, and may close the
connection on an unknown frame type. A flag that changes how a body is read, as `DEFLATE`
does, is only ever sent to clients that asked for it.
