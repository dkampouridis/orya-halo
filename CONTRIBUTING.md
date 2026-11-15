# Contributing to Orya Halo

Thank you for helping. This page covers setting up, where code goes, what to run before a pull
request, how code and words are written here, and the rule for data sources, which matters
more than any of the others.

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md).

## Set up

Follow the [quick start](README.md#quick-start): Node 22.18 or newer, pnpm, then
`pnpm install` and `pnpm --filter @orya-halo/web tiles`. The gateway needs Rust 1.89 or newer;
on Windows run `source scripts/env.sh` in Git Bash first.

Work against the gateway's mock mode (`cargo run --release -- --mock` in `apps/gateway`)
unless you are working on a feed itself. It costs no one's rate limit.

If several people or agents share one checkout, do not run `pnpm install` or `pnpm add`
directly. Use the wrapper, which takes a lock first:

```sh
node scripts/pnpm-locked.mjs add --filter @orya-halo/web some-package
```

Use pnpm only: never npm, yarn or bun.

## Where code goes

The repository is split into lanes. Keep a change inside the lanes it needs.

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
| `engine/` | MapLibre, deck.gl, camera, picking, the render loop             | The only place that imports map libraries             |
| `data/`   | The data worker, entity stores, gateway client, history, search | Runs off the main thread                              |
| `ui/`     | React HUD                                                       | Reads the store, never touches the map or entity data |
| `app/`    | Controller wiring store, engine and worker together; boot       | The only code that knows all three                    |

`packages/schema` and `apps/web/src/core` are shared contracts. Change them only in a pull
request of their own that says why, and expect it to be reviewed more slowly. The TypeScript
codec (`packages/schema/src/protocol.ts`) and the Rust codec (`apps/gateway/src/protocol.rs`)
are both tested against the golden files in `packages/schema/fixtures/`; a protocol change
updates [docs/PROTOCOL.md](docs/PROTOCOL.md), both codecs and the fixtures together.

The reasons behind this layout are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short:
nothing per object happens on the main thread, and nothing per frame happens in JavaScript.

## Before you open a pull request

From the repository root:

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm fmt
pnpm build
```

`pnpm check` runs the format check, lint and types in one go. If you touched the gateway, from
`apps/gateway`:

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

If you changed what people see, run the browser checks that cover it (they need the dev server;
see [Scripts](README.md#scripts)) and attach before and after screenshots to the pull request.
`node scripts/hud-check.mjs` covers the HUD; the `check-*.mjs` scripts cover the engine. The
scripts that load the real app contact live providers on every page load, so run them once,
not in a loop.

If you changed the bundle, say what `pnpm build` reports for the entry chunk against the
300 KB gzipped budget. If you changed the render path, give before and after numbers from
`node scripts/shot.mjs --perf --headed`.

## Code

- TypeScript 7, strict, with `erasableSyntaxOnly`: no enums, namespaces or parameter
  properties. `verbatimModuleSyntax` is on, so type-only imports use `import type`. Relative
  imports carry the `.ts` extension.
- Tests use Vitest through Vite+: import from `"vite-plus/test"` and run `vp test run` in the
  package.
- Comments say why, not what. Public functions and types get a short doc comment.
- Tests cover behaviour that could break: parsing real samples, edge cases, protocol parity.
  Every source plugin and every protocol path has tests.
- Do not trust memory for library APIs. The versions here are recent (MapLibre GL JS 6,
  deck.gl 9.4, satellite.js 7, TypeScript 7, Vitest 5); read the installed type definitions and
  the current docs.
- The gateway follows `rustfmt.toml` and clippy with warnings as errors.

## Words

Everything a person reads in the app follows the voice in
[docs/DESIGN.md](docs/DESIGN.md#voice):

- Plain, short, sentence case. No all-caps labels and no tracked-out capitals.
- Name things by what people see ("Aircraft", "Rain radar"), not by feed or source names.
- Buttons say what happens: "Follow", "Back to live", "Copy link".
- States say what happened and what to do about it: "Ships need a free AISStream key. Add it
  to the gateway's .env file."
- Error messages are one plain sentence, fit to show as they are.

Documentation follows the same voice, with British spelling for "licence" as a noun.

## The rule for data sources

Orya Halo shows other people's data. Every feed has to pass these before it is merged:

1. **Verify the terms yourself**, from the provider's own pages: the API documentation, rate
   limits, the licence or terms of use, the attribution wording and CORS. Record what you read,
   with its address and the date, in the plugin's `licence` field and in the pull request.
2. **No source that forbids public display.** Orya Halo is a public website. If the terms do not
   allow showing the data to the public, find another source.
3. **Nothing that forbids redistribution passes through the gateway.** If the terms forbid
   passing the data on, the browser must fetch it directly from the provider, and the gateway
   must not proxy or cache it.
4. **Credit exactly as the provider asks**, on the map where the terms require it. Add the
   credit to the plugin's `attribution` and the row to
   [docs/DATA_LICENCES.md](docs/DATA_LICENCES.md).
5. **Cameras: only officially published public webcams**, such as those a public authority
   publishes as open data. Never index unsecured, private or scraped camera feeds.
6. **Never commit a key.** Keys are read from the environment and documented in an
   `.env.example`. Anything in a `VITE_` variable is published in the bundle, so a key whose
   terms forbid publishing it (Windy Webcams is the example in this repository) cannot be used
   in the browser at all; keyed feeds go through the gateway.
7. **Be a polite client** while developing: a handful of requests per provider, recorded
   samples as test fixtures, never a public API in a loop.

[docs/ADDING_A_SOURCE.md](docs/ADDING_A_SOURCE.md) walks through writing a plugin. Proposing a
source without writing it? Open a "New data source" issue with the links to its terms.

## Pull requests

- One change per pull request, with a description of what changed and why.
- Fill in the checklist in the pull request template.
- Screenshots for anything visible; numbers for anything about performance.
- Say what you did not test.
