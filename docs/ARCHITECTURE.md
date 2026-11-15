# Architecture

Orya Halo is a static web app plus one small realtime service.

```
                 public feeds                         browser
┌──────────────────────────────┐       ┌────────────────────────────────────────────┐
│ adsb.lol, AIS …  (rate-      │       │  data worker                main thread     │
│ limited, keyed or CORS-less) │       │ ┌───────────────────┐   ┌────────────────┐ │
└──────────────┬───────────────┘       │ │ gateway client    │   │ engine         │ │
               │ one connection        │ │ source plugins    │──▶│ MapLibre globe │ │
        ┌──────▼───────┐  WebSocket    │ │ entity stores     │   │ deck.gl layers │ │
        │ apps/gateway │──────────────▶│ │ history buffer    │   └───────▲────────┘ │
        │ Rust, Axum   │ binary deltas │ │ search index      │           │          │
        │ H3 index     │ by viewport   │ └─────────▲─────────┘   ┌───────┴────────┐ │
        └──────────────┘               │           │ fetch       │ controller     │ │
┌──────────────────────────────┐       │           │             │ Zustand store  │ │
│ CelesTrak, USGS, RainViewer, │───────┼───────────┘             │ React HUD      │ │
│ NASA GIBS … (open, CORS ok)  │       │                         └────────────────┘ │
└──────────────────────────────┘       └────────────────────────────────────────────┘
```

## Workspace

| Path               | What it is                                                           | Depends on       |
| ------------------ | -------------------------------------------------------------------- | ---------------- |
| `packages/schema`  | Types, layer registry, the binary wire protocol, the plugin contract | nothing          |
| `packages/sources` | One plugin per data feed: fetch, normalise, licence, attribution     | schema           |
| `packages/layers`  | deck.gl layers and shaders                                           | schema           |
| `apps/web`         | The app: engine, data worker, controller, HUD                        | all of the above |
| `apps/gateway`     | Rust service: connects upstream once, fans out to clients            | protocol spec    |

Inside `apps/web/src`:

| Folder    | Owns                                                            | Rule                                                  |
| --------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| `core/`   | Contracts: `HaloEngine`, `DataClient`, the Zustand store        | No implementation, no heavy imports                   |
| `engine/` | MapLibre, deck.gl, camera, picking, the render loop             | Only place that imports map libraries                 |
| `data/`   | The data worker, entity stores, gateway client, history, search | Runs off the main thread                              |
| `ui/`     | React HUD                                                       | Reads the store, never touches the map or entity data |
| `app/`    | Controller wiring store, engine and worker together; boot       | The only code that knows all three                    |

## The hot path

Nothing per-object happens on the main thread, and nothing per-frame happens in JavaScript.

1. Data arrives in the worker as binary frames (gateway) or small JSON documents (open feeds).
2. Plugins normalise it to `EntityUpdate`: struct-of-arrays in SI units.
3. The worker's stores merge updates and, when something changed, build a `RenderBatch`:
   interleaved `Float32Array` attributes with each object's last fix, velocity and fix time.
   The buffers are transferred to the main thread, not copied.
4. The engine hands the arrays to deck.gl as binary attributes: one buffer upload, no
   per-object JavaScript.
5. The vertex shader dead-reckons every object from its fix to the current render time and
   eases out any correction from the previous fix. Per frame, only a time uniform changes.
   Comet tails are drawn the same way, from heading and speed, with no trail geometry.

So 20,000 aircraft cost one buffer upload about once a second and one instanced draw call per
frame. `extrapolate()` in `packages/schema/src/entity.ts` is the reference implementation of
the shader maths; picking, labels and follow mode use it so they agree with the pixels.

## Time

The store holds one clock: `live`, or `scrub` at a moment in the past. The worker keeps a
ring buffer of keyframes for moving layers and re-emits batches for the scrubbed moment;
satellites are propagated analytically for any time; rain radar picks its nearest frame; the
terminator is computed for the shown moment. Every layer honours the same clock.

## The gateway

Why a service at all: aircraft and ship feeds are rate-limited, keyed or not CORS-enabled, and
a browser should not hold the keys. The gateway connects upstream once, normalises, indexes
every entity by H3 cell, and sends each client only what its viewport needs.
See [PROTOCOL.md](PROTOCOL.md).

Why Rust (Axum + Tokio) rather than Go: the work is a steady fan-out loop that encodes binary
frames for many sockets every tick. Rust gives that loop no garbage-collector pauses and a
small, flat memory footprint on a 256 MB instance; `h3o` is a pure-Rust H3 (no cgo, no C
toolchain in the container); and the frame layout is checked at compile time. Go would have
been quicker to write and its H3 binding needs cgo. The service is small enough that Rust's
extra ceremony costs little.

Everything client-side keeps working with no gateway: satellites, earthquakes, weather,
cables, day and night need only static hosting.

## Performance budgets

| Budget           | Target                     | How                                                                             |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------- |
| Entry JavaScript | under 300 KB gzipped       | HUD shell only; engine and layers are dynamic imports                           |
| Frame rate       | 60 fps with 20,000+ movers | GPU dead reckoning, instancing, no per-frame JS per object                      |
| Under load       | degrade, do not stutter    | Quality tiers: fewer tails, lower device pixel ratio, density instead of points |
| Memory           | flat over an hour          | Fixed-size ring buffers, entity expiry, buffers transferred not copied          |
