# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability
reporting on this repository: "Report a vulnerability" under the
[Security tab](https://github.com/dkampouridis/orya-halo/security/advisories/new).

Say what you found, how to reproduce it, and what an attacker could do with it. You will get
an answer within a week. When the fix is published we will credit you, unless you would rather
not be named.

Orya Halo is a small volunteer project with no bug bounty.

## In scope

- **The gateway** (`apps/gateway`): anything that lets a client crash it, exhaust its memory or
  connections past its limits, get around `ALLOWED_ORIGINS` or the per-address limits, read
  another client's data, or make it send requests the operator did not configure. That includes
  the wildfire and CelesTrak proxies (`/v1/proxy/…`): getting them to fetch anything other than
  their fixed upstreams, or to ask those upstreams more often than their limits allow.
- **Key leaks**: any way to get a key the gateway holds (`ADSBLOL_API_KEY`,
  `AISSTREAM_API_KEY`, `FIRMS_MAP_KEY`) out of it, through an error message, a log line, a
  proxy response or anything else.
- **The web app** (`apps/web`): script injection through data from a feed (a ship's name, a
  place name, a webcam title), links that lead somewhere other than they say, or anything that
  runs code from a provider's response.
- **The wire protocol decoders** in TypeScript and Rust: input that crashes or hangs them.
- **The build**: anything that would put a secret into the published bundle.

## Out of scope

- Problems in the upstream providers' own services. Report those to the provider.
- Rate limits being reached by normal use. That is expected, and the app says so.
- Missing security headers on a deployment, which belong to whoever hosts it, unless the
  repository's own configuration causes them.
- Denial of service by sheer volume against a deployment.

## No secrets in the client bundle

Everything in `apps/web` is public once it is built: any variable starting with `VITE_` is
compiled into JavaScript that every visitor downloads. Never put a secret there. Keys that must
stay private belong to the gateway, in its environment or `apps/gateway/.env`, never in the
repository. `VITE_PROTOMAPS_KEY` is the one key in the bundle, and Protomaps issues it for
browser use. If you find a secret in the bundle or the repository, report it as above.
