## What and why

<!-- What this changes, and the reason. Link the issue if there is one. -->

## How it was tested

<!-- Commands run, browsers and devices tried. Screenshots before and after for anything visible. -->

## Not tested

<!-- What you could not check, and why. A known gap is fine; a hidden one is not. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint` and `pnpm build` pass
- [ ] Formatted with `pnpm fmt`
- [ ] Gateway changes: `cargo test`, `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` pass
- [ ] The change stays in its lanes; any change to `packages/schema` or `apps/web/src/core` is explained above
- [ ] New behaviour has tests, with recorded samples for anything parsed from a provider
- [ ] Text people read is plain and in sentence case, and says what to do when something fails
- [ ] Visible changes: screenshots attached, relevant browser checks run
- [ ] Performance-sensitive changes: entry bundle size or frame timings before and after

For a new or changed data source:

- [ ] Terms verified on the provider's own pages; links and date in the plugin's `licence` and here
- [ ] The terms allow public display; nothing that forbids redistribution goes through the gateway
- [ ] Attribution set in the plugin and shown where the terms require it
- [ ] Row added or updated in `docs/DATA_LICENCES.md`
- [ ] Webcams: officially published public cameras only
- [ ] No key in the repository, and no secret key in a `VITE_` variable; new variables documented in an `.env.example`
