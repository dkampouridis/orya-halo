# Deploying Orya Halo

Orya Halo is two things to host: a static web app, and optionally one small long-running
service, the gateway, for aircraft, ships and wildfires. Without the gateway the site still
shows satellites, earthquakes, cables, rain radar, satellite imagery, webcams and day and
night.

## What has not been tested

Be clear about this before you rely on any of it:

- **The Docker image has never been built or run**, here or anywhere. The `Dockerfile` was
  written carefully but no `docker build` has been done.
- **The Fly.io configuration (`apps/gateway/fly.toml`) has never been deployed.**
- No deployment to Cloudflare Pages or Vercel has been made. The static build runs and
  produces the files listed below; serving them from a real host has not been tried.
- The systemd unit, Caddy and nginx snippets below are examples, not configurations that have
  run.

What has been run: the production build of the web app, the gateway on a developer machine
(against the live feeds and in mock mode), and both test suites. If you deploy, please report what worked
and what did not, so this page can lose its caveats.

## The web app

### Build

On a clean machine with Node 22.18 or newer and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm --filter @orya-halo/web tiles
pnpm build
```

The output is `apps/web/dist`:

| Path                                          | What it is                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `index.html`                                  | The page                                                                                                         |
| `assets/`                                     | JavaScript, CSS and fonts with content hashes in their names, plus source maps                                   |
| `tiles/world.pmtiles`                         | The base map extract, zoom 0 to 5, about 14 MiB                                                                  |
| `data/cables.bin`, `data/places.bin`          | Undersea cables and the city gazetteer                                                                           |
| `data/satellites.csv`, `data/satellites.json` | Satellite orbital elements shown when live ones cannot be had, and their dates (about 2.5 MB, 0.9 MB compressed) |
| `textures/black-marble-2016-01deg-gray.jpg`   | The night-lights texture                                                                                         |
| `favicon.svg`                                 | The icon                                                                                                         |

`tiles/world.pmtiles` is not in git, so a build server has to run the `tiles` step (it
downloads under ten requests from Protomaps' build bucket). That step takes the newest daily
build; for a reproducible build, pin one with
`node apps/web/scripts/fetch-tiles.mjs --build=YYYYMMDD` instead. Everything else in `public/`
is committed.

`pnpm build` type-checks first (`tsc`), then runs `vp build`. On 2026-11-14 the JavaScript the
page loads first was about 134 KB gzipped, under the 300 KB budget; the engine (about 540 KB
gzipped) and the MapLibre worker load after the interface is up.

### Build-time settings

The web app's settings are `VITE_` variables, read when you build and compiled into the
JavaScript. Set them in the build environment or in `apps/web/.env.production.local`
(ignored by git). The full list with comments is in [`.env.example`](../.env.example) at the
root.

| Variable                                   | In production                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_GATEWAY_URL`                         | The gateway's address, `wss://gateway.example.org`. A production build without it runs with no gateway: aircraft, ships and wildfires are off. A page served over `https` can only open `wss://` |
| `VITE_PMTILES_URL` or `VITE_PROTOMAPS_KEY` | Base map detail past zoom 5. See [tiles for deep zoom](#tiles-for-deep-zoom)                                                                                                                     |
| `VITE_RADAR_SOURCE`                        | `rainviewer` (default) or `imerg`                                                                                                                                                                |
| `VITE_REPO_URL`                            | Your repository's address, for the links on the about page                                                                                                                                       |

Anything in a `VITE_` variable is public. Never put a secret there.

### Hosting

Any static host works. The app has no routes (the view lives in the address fragment), so no
rewrite rules are needed. It assumes it is served from the root of its domain.

| Host                      | Notes                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Cloudflare Pages          | 25 MiB per file. This limit is why the bundled extract stops at zoom 5 (14 MiB); zoom 6 would be about 43 MiB |
| Vercel                    | Serves `apps/web/dist` as a static site. Check the current limits of your plan                                |
| Object storage with a CDN | Fine, as long as it answers range requests (below)                                                            |

You can let the host build from git (build command
`pnpm --filter @orya-halo/web tiles && pnpm build`, output directory `apps/web/dist`), or build
yourself and upload the folder, for example `pnpm dlx wrangler pages deploy apps/web/dist` for
Cloudflare Pages or `pnpm dlx vercel deploy apps/web/dist` for Vercel. The repository pins
pnpm 12 in `devEngines` rather than `packageManager`; if a host's build image picks the wrong
pnpm, building yourself avoids the question.

**The host must answer HTTP range requests for `.pmtiles` files.** The map reads the extract
in pieces. After deploying, check that a range comes back as `206`:

```sh
curl -s -o /dev/null -w "%{http_code}\n" -r 0-126 https://halo.example.org/tiles/world.pmtiles
```

Files in `assets/` have content hashes in their names and can be cached for a year. Leave
`index.html` uncached or briefly cached so a new deployment shows up.

### Tiles for deep zoom

The base map is [PMTiles](https://docs.protomaps.com/pmtiles/): a whole tile pyramid in one
file, read with range requests, so it needs no tile server.

| Choice               | What you get                                                                                                                              | Cost                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Keyless default      | The bundled extract, zoom 0 to 5. Past zoom 5 the map stretches the deepest tiles: coastlines, borders and large cities, no street detail | Nothing                                                                                                 |
| `VITE_PMTILES_URL`   | Your own archive on object storage (Cloudflare R2, S3 and the like), for zoom 6 and deeper                                                | Storage and traffic. The bucket must send CORS headers for your site's origin and answer range requests |
| `VITE_PROTOMAPS_KEY` | Protomaps' hosted tile API for zoom 6 and deeper                                                                                          | Free for non-commercial use. The key is compiled into the bundle, which is how Protomaps issues it      |

Zoom 0 to 5 always comes from the bundled file, whichever you choose; the two are stitched
together in `apps/web/src/engine/map/tiles.ts`. Do not point `VITE_PMTILES_URL` at Protomaps'
own build bucket: Protomaps asks people to copy builds to their own storage rather than link
to them, and that bucket only sends CORS headers for localhost. Make your own archive from a
daily build with the [`pmtiles` command-line tool](https://docs.protomaps.com/pmtiles/cli)
(`pmtiles extract`, optionally with a bounding box for a region).

If `VITE_PMTILES_URL` cannot be read, the app says so in the map's status and carries on with
the extract.

## The gateway

The gateway is a Rust binary that keeps WebSocket connections open, holds the world's
aircraft and ships in memory, and shares one set of upstream connections and rate limits
between every visitor. That is why it must be a long-running process and not a serverless
function, and why there must be **exactly one instance**: a second would double every upstream
request and show its visitors a different world.

Measured on mock traffic: about 60 MB of memory with 70,000 objects and no visitors, about
150 MB with 600. 256 MB is enough for the keyless feeds; 512 MB leaves room for worldwide
ships. One shared CPU is plenty.

### Configuration

Every setting is an environment variable, listed with its default in
[`apps/gateway/.env.example`](../apps/gateway/.env.example). For a public deployment:

| Variable                                                | Set it to                                                                                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`                                       | Your site's origin, exactly: `https://halo.example.org`. Several are comma-separated. Required: unset, only `localhost` origins are allowed and your site gets `403 origin_not_allowed` |
| `TRUST_PROXY`                                           | `true` only behind a proxy you control that sets the client's address (see [behind a reverse proxy](#behind-a-reverse-proxy))                                                           |
| `ADSBLOL_BUDGET_FILE`                                   | A path on persistent storage (see [the adsb.lol budget file](#the-adsblol-budget-file))                                                                                                 |
| `ADSBLOL_API_KEY`, `AISSTREAM_API_KEY`, `FIRMS_MAP_KEY` | Your keys, as secrets                                                                                                                                                                   |
| `LOG_FORMAT`                                            | `json` if your platform collects structured logs                                                                                                                                        |

`ALLOWED_ORIGINS` is checked on the WebSocket handshake as well as by CORS. Origins are compared
whole (scheme, host and port, no trailing slash). Add preview deployments' origins if they
should work too. `*` allows every site, which lets anyone embed your gateway and spend your
upstream allowances; avoid it.

### Keys

Keys belong to the gateway only. Keep them in the platform's secret store (`fly secrets set`,
a root-readable environment file for systemd, `--env-file` for Docker), never in the
repository and never in a `VITE_` variable. The gateway is written not to log keys or include
them in error messages or proxied responses.

### The adsb.lol budget file

Without a key, adsb.lol allows 500 requests a day per IP address. The gateway keeps its own
count of what it has spent (a token bucket: a tenth of the day's allowance can go at once, the
rest refills evenly over 24 hours) and writes it to `ADSBLOL_BUDGET_FILE` before every request,
so that a restart carries on where it left off.

The default path is under the system's temporary directory. On a host where that does not
survive a restart or a redeploy (most containers), every new start begins with a fresh burst of
requests, and frequent redeploys could go over the daily allowance. Point the variable at a
volume. If the file cannot be written, the gateway logs "the request budget could not be
saved" once and keeps the count in memory.

### Docker

From the repository root:

```sh
docker build -t orya-halo-gateway apps/gateway
```

The image is multi-stage: it compiles on `rust:1-slim-bookworm` and runs on distroless as a
non-root user, listening on port 8787. Run it with your settings in an environment file and a
directory for the budget file:

```sh
sudo install -d -o 65532 -g 65532 /var/lib/orya-halo
docker run -d --name orya-halo-gateway --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  --env-file /etc/orya-halo/gateway.env \
  -e ADSBLOL_BUDGET_FILE=/data/adsb-lol-budget.json \
  -v /var/lib/orya-halo:/data \
  orya-halo-gateway
```

`65532` is the user id of distroless's `nonroot` user, so the directory is writable from inside
the container. Leave `BIND_ADDR` out of the environment file: inside the container the gateway
must listen on `0.0.0.0`, the image's default, and `-p 127.0.0.1:8787:8787` already keeps it
off the public interface for a proxy on the same host. None of this has been run yet (see the
top of this page).

### Fly.io

`apps/gateway/fly.toml` describes one always-on shared-CPU machine with 512 MB, a health check
on `/health`, `TRUST_PROXY=true` (Fly's proxy sets `Fly-Client-IP`) and JSON logs. From
`apps/gateway`:

```sh
fly launch --no-deploy --copy-config
fly secrets set AISSTREAM_API_KEY=... FIRMS_MAP_KEY=...
fly deploy
```

Before the first deploy, set `ALLOWED_ORIGINS` under `[env]` in `fly.toml`, and change `app`
and `primary_region` to suit you. Keep it to one machine (`fly scale count 1`).

The configuration has no volume, so the adsb.lol budget starts afresh on every deploy. To keep
it, create a volume (`fly volumes create orya_halo_data --size 1`), mount it, and point the
budget file at it:

```toml
[mounts]
source = "orya_halo_data"
destination = "/data"

[env]
ADSBLOL_BUDGET_FILE = "/data/adsb-lol-budget.json"
```

The image runs as a non-root user; check after the first deploy that it can write to the volume
(no "could not be saved" warning in `fly logs`).

### Render (free)

This is how the public demo runs. `render.yaml` at the repository root is a Render blueprint
for the gateway on the free plan: open
`https://render.com/deploy?repo=<your repository URL>`, enter `FIRMS_MAP_KEY` and
`AISSTREAM_API_KEY` when asked (both optional), and apply it. The first build compiles the
gateway and takes 10 to 15 minutes. Pushes that touch `apps/gateway` redeploy it.

What the free plan means in practice:

- It sleeps after 15 minutes without visitors and takes about a minute to wake. Meanwhile
  aircraft and ships show as reconnecting, then fill in.
- Its disk is wiped on every restart, so the blueprint sets `ADSBLOL_FIRST_BURST=false`:
  each start begins with an empty adsb.lol budget, and frequent restarts can never add up to
  more than 500 requests a day. Aircraft appear a few minutes after a wake.
- Requests reach it through Cloudflare, so `CLIENT_IP_HEADER=true-client-ip` gives the
  per-address limit the visitor's real address.
- In our tests CelesTrak could not be reached from Render. Build the web app with
  `VITE_SATELLITE_SOURCE=direct` so browsers fetch satellite elements themselves.
- 750 free instance hours a month are shared by every free service in the workspace; one
  service running all month uses at most 744.

Point the web app at it with `VITE_GATEWAY_URL=wss://<service>.onrender.com` and set
`ALLOWED_ORIGINS` in `render.yaml` to your site's address.

### A small VPS with systemd

Build the binary on the server, or on a machine with the same operating system and
architecture:

```sh
cd apps/gateway
cargo build --release
sudo install -m 755 target/release/orya-halo-gateway /usr/local/bin/
```

Put the settings in `/etc/orya-halo/gateway.env`, readable by root only (`chmod 600`):

```sh
BIND_ADDR=127.0.0.1:8787
ALLOWED_ORIGINS=https://halo.example.org
TRUST_PROXY=true
ADSBLOL_BUDGET_FILE=/var/lib/orya-halo/adsb-lol-budget.json
LOG_FORMAT=json
# AISSTREAM_API_KEY=
# FIRMS_MAP_KEY=
```

And a unit, `/etc/systemd/system/orya-halo-gateway.service`:

```ini
[Unit]
Description=Orya Halo gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/orya-halo-gateway
EnvironmentFile=/etc/orya-halo/gateway.env
DynamicUser=yes
StateDirectory=orya-halo
WorkingDirectory=/var/lib/orya-halo
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now orya-halo-gateway
journalctl -u orya-halo-gateway -f
```

`StateDirectory` gives the service a writable `/var/lib/orya-halo` that survives restarts, for
the budget file. The gateway shuts down cleanly on the `SIGTERM` systemd sends.

### Behind a reverse proxy

Browsers on an `https` page need `wss://`, so put TLS in front: Fly.io does it for you; on a
VPS use a reverse proxy. The proxy must pass WebSocket upgrades on `/v1/stream` and plain HTTP
for the other endpoints on the same host name, because the app derives the HTTP address from
the WebSocket one.

With `TRUST_PROXY=true` the gateway counts connections per address using `Fly-Client-IP`, or
else the first address in `X-Forwarded-For`. A client can send those headers itself, so the
proxy must remove `Fly-Client-IP` and replace `X-Forwarded-For` rather than add to it.
Otherwise anyone can get around the per-address limit.

[Caddy](https://caddyserver.com/), which gets certificates by itself and passes WebSockets
without extra settings:

```
gateway.example.org {
    reverse_proxy 127.0.0.1:8787 {
        header_up -Fly-Client-IP
    }
}
```

Caddy sets `X-Forwarded-For` to the client's address and ignores the incoming value unless
you configure trusted proxies.

nginx, inside a `server` block with TLS already set up:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Fly-Client-IP "";
    proxy_read_timeout 120s;
}
```

`proxy_read_timeout` has to be longer than the gateway's 20-second ping interval, or nginx
closes quiet connections.

Upstream rate limits are per IP address too: if your server's outgoing address is shared
with other services, so is the adsb.lol allowance.

### Health and metrics

| Endpoint              | What it gives                                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`         | JSON: `status`, uptime, connected clients, tick timings, each layer's status and credit, each upstream's status, counters and note, the adsb.lol budget under `upstreams[].budget` (`availableNow`, `spentToday`, `leftToday`, `waitS`), and the wildfire cache |
| `GET /metrics`        | Prometheus text: clients, connections refused, entities, ticks, frames and bytes sent, upstream requests, errors, 429s and latency, the request budget (`halo_upstream_budget_*`), wildfire cache hits and misses                                               |
| `GET /v1/attribution` | Every source in use, with its licence, credit, what its terms allow and whether it is active                                                                                                                                                                    |

The gateway also caches CelesTrak's satellite elements for everyone behind it at
`GET /v1/proxy/celestrak/{group}.csv`. CelesTrak serves each group once per update to each
address and refuses repeats, so without this every visitor downloads 1 MB from CelesTrak and
several visitors behind one address are refused. The cache asks CelesTrak at most once per two
hours, only when a visitor wants it, and keeps serving its last copy for up to seven days if
CelesTrak refuses or is down. Set `CELESTRAK_CACHE_DIR` to a persistent volume so a restart
does not spend a download; see `apps/gateway/.env.example` and
[PROTOCOL.md](PROTOCOL.md).

Point the platform's health check at `/health`; `fly.toml` already does. Both endpoints are
public and contain no keys or visitors' addresses. If you would rather not publish them, block
them at the proxy and scrape from the server itself.

## Before you go public

- [ ] Credits are visible: the line on the map for every layer that is on, and the full list on
      the about page. Turn every layer on and look.
- [ ] No secret in the bundle: search the built files for each key
      (`grep -r "<your key>" apps/web/dist` finds nothing), and only `VITE_` variables you meant to
      publish are set.
- [ ] `ALLOWED_ORIGINS` names your site and nothing else, and the gateway's `TRUST_PROXY`
      matches what is in front of it.
- [ ] Rate limits are respected: one gateway instance, the adsb.lol budget file on persistent
      storage, and nothing in front of the site that retries failed provider requests.
- [ ] [`docs/DATA_LICENCES.md`](DATA_LICENCES.md) has been re-read against each provider's
      current terms. Terms change; the dates there say when each was last checked.
- [ ] `VITE_REPO_URL` points at your repository, so the about page's licence links work.
- [ ] The base map extract answers range requests (`206`, see above).
- [ ] `https://<gateway>/health` shows each upstream as you expect, and the dock shows
      aircraft and ships as live.
