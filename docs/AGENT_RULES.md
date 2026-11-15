# Working rules for contributors and coding agents

Read this, `docs/ARCHITECTURE.md` and the contract files it points to before writing code.

## Ground rules

- **Stay in your lane.** Write only inside the directories your task names. `packages/schema`
  and `apps/web/src/core` are shared contracts: do not edit them. If a contract is wrong or
  missing something, work around it locally and say exactly what should change in your report.
- **Do not commit, branch or push.** Leave changes in the working tree.
- **Dependencies:** never run `pnpm install` or `pnpm add` directly; several people may be
  working in this checkout at once. Use the mutex wrapper:
  `node scripts/pnpm-locked.mjs add --filter @orya-halo/<package> <dependency>`.
  Never use npm, yarn or bun.
- **Toolchain:** Vite+ (`vp`). Tests: `vp test run` inside the package, importing from
  `"vite-plus/test"`. Types: `pnpm exec tsc -p tsconfig.json` inside the package.
  TypeScript 7, strict, `erasableSyntaxOnly` (no enums, namespaces or parameter properties),
  `verbatimModuleSyntax`, relative imports carry the `.ts` extension.
- **Rust:** on Windows run `source scripts/env.sh` first (puts cargo and gcc on PATH).
- **Do not trust memory for APIs.** Installed versions are recent (MapLibre GL JS 6, deck.gl
  9.4, satellite.js 7, Vitest 5, TypeScript 7, Axum current). Read the installed package's
  type definitions and the current online docs before using an API.
- **Verify every data source before integrating it:** current API docs, rate limits, licence
  and terms, attribution wording, CORS. Record what you verified and the URL. If the terms
  forbid public display, do not use the source: find one that allows it. If they forbid
  redistribution, the data must not pass through the gateway.
- **Be a polite client** while developing: a handful of requests per provider, cache samples
  as test fixtures, never hammer a public API in a loop.
- **Keys:** never write a real key into the repo. Read keys from the environment and document
  them in `.env.example`.
- **Cameras:** only officially published public webcams. Never index unsecured or private feeds.
- **Leave nothing running:** stop any dev server, gateway or browser you start.
- **Screenshots:** Playwright with `channel: "msedge"` (Edge is installed; do not download
  browsers). Save under `.screenshots/`, which is ignored by git.
- On Windows the shell is Git Bash. Write files with your file-writing tool, not heredocs.

## Code

- Comments say why, not what. Public functions and types get a short doc comment.
- Tests cover behaviour that could break: parsing real samples, edge cases, protocol parity.
  Every source plugin and every protocol path has tests.
- User-facing text is plain and sentence case. No all-caps labels. Say what happened and what
  to do about it.

## Report when you finish

1. What you built, by file or module.
2. Facts you verified about external services, each with its URL and the date.
3. Where you deviated from the brief or the contracts, and why.
4. What you did not test or could not make work. Be exact; a known gap is fine, a hidden one is not.
5. Contract changes you need from the lead.
