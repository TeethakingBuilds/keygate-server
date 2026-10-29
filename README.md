# keygate-server

[![CI](https://github.com/TeethakingBuilds/keygate-server/actions/workflows/node.yml/badge.svg)](https://github.com/TeethakingBuilds/keygate-server/actions/workflows/node.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![status: unaudited 0.1](https://img.shields.io/badge/status-unaudited%200.1-orange)](./SECURITY.md)

The off-chain half of [keygate](https://github.com/TeethakingBuilds/keygate-contracts): it mirrors the capability state a Soroban deployment publishes on-chain and answers **may this holder perform this action on this resource right now?** in single-digit milliseconds.

On-chain checks are correct and slow. A service that asks the ledger for every authorisation decision pays a round trip, a simulation and a fee per question — and it couples its uptime to RPC availability. This repository keeps a local projection of the contract's events so the answer is a memory lookup, and fails closed when that projection cannot be trusted.

```
Soroban RPC ──getEvents──▶ decoder ──LedEvent──▶ LedgerMirror ──▶ DecisionEngine ──▶ /v1/decide
   (contracts emit)        (XDR → domain)         (in-memory state)  (pure function)
```

## Quick start

Requires Node 20+ and [pnpm](https://pnpm.io) (this repository pins `packageManager`, and `pnpm` refuses a different package manager on install).

```bash
corepack enable                      # or: npm i -g pnpm
pnpm install
cp .env.example .env                 # then edit the three contract ids
pnpm dev                             # tsx watch, on KEYGATE_PORT
```

```bash
curl -s localhost:8080/readyz
# {"ready":true,"stalenessSeconds":4}

curl -s localhost:8080/v1/decide \
  -H 'content-type: application/json' \
  -d '{"holder":"G…","resource":"vault:main","action":"withdraw","amount":"500"}'
# {"allowed":true,"grantId":7,"expiresAt":1800000600,
#  "budget":{"resource":"vault:main","remaining":"600","requested":"500","windowSeconds":3600},
#  "evaluatedAt":1800000000}
```

Nothing is deployed by this repository. The three contracts come from
[keygate-contracts](https://github.com/TeethakingBuilds/keygate-contracts#deploying);
its README covers the `initialize` / `issue` calls that produce the events this
service reads.

## HTTP API

Every response is `application/json`, `cache-control: no-store`, and body-limited
to 64 KiB on the one POST route (a larger body is answered `413` after draining,
rather than by dropping the socket, so a client cannot mistake an oversized
request for an outage).

| Route                          | Purpose                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                 | process is up; `{"status":"ok"}`. Never consults the mirror.                                                                                                                          |
| `GET /readyz`                  | `200` when the mirror is synced **and** within `KEYGATE_MAX_STALENESS_SECONDS`; otherwise `503` with `stalenessSeconds`. This is the endpoint a load balancer should watch.           |
| `GET /v1/status`               | what the mirror currently believes: grant/rule/budget counts, default effect, pause flag, sync cursor and last error.                                                                 |
| `GET /v1/capabilities/:holder` | the live grants for one address, plus `stateReady`.                                                                                                                                   |
| `POST /v1/decide`              | the decision, described below.                                                                                                                                                        |
| `POST /v1/sync`, `/v1/admin*`  | always `403`. There is no remote write path in this service; capabilities change by sending a transaction, with [keygate-client](https://github.com/TeethakingBuilds/keygate-client). |
| anything else                  | `404 {"error":"not_found"}`.                                                                                                                                                          |

### `POST /v1/decide`

```jsonc
{
  "holder": "G…", // required, a valid Stellar account or contract address
  "resource": "vault:main", // required
  "action": "withdraw", // required
  "amount": "500", // optional; decimal string or integer
}
```

`amount` changes the question. Without it this is "does the holder have this
capability"; with it the decision also accounts for the circuit breaker, because
the caller intends to charge that much. Amounts are `i128` on-chain, so above
`2^53` use the string form — a JS number beyond that is silently wrong, which is
why the schema prefers it.

A decision is `allowed: true` with the grant id, its expiry and the remaining
budget, or `allowed: false` with one of these reasons:

| reason                | meaning                                                        |
| --------------------- | -------------------------------------------------------------- |
| `state_unsynced`      | the mirror has never completed a pass; nothing is knowable yet |
| `state_stale`         | the mirror is older than `KEYGATE_MAX_STALENESS_SECONDS`       |
| `policy_denied`       | a rule, or the default effect, forbids the action              |
| `capability_missing`  | no live grant for this `(resource, action, holder)`            |
| `amount_invalid`      | the requested amount is zero or negative                       |
| `budget_tripped`      | the breaker for this resource is latched closed                |
| `budget_exhausted`    | charging this amount would cross the window limit              |
| `budget_unconfigured` | an amount was requested for a resource with no budget          |

Denying is the safe answer, so an unknown mirror and an absent grant both produce
one — but with different reasons, because an operator needs to know whether the
system is broken or the holder simply is not authorised.

### Signed decisions

Set `KEYGATE_SIGNING_KEY` (`openssl rand -hex 32`) and every decision carries an
HMAC-SHA256 in `x-keygate-signature`, over a canonical rendering of the request
and the answer together. That is what lets a downstream service check that a
decision was issued for _this_ holder and _this_ amount, and cannot be replayed
for someone else after passing through a proxy or a CDN.

The same rendering is implemented in
[keygate-client/src/decision.ts](https://github.com/TeethakingBuilds/keygate-client/blob/main/src/decision.ts)
with WebCrypto instead of `node:crypto`, and the two are pinned against each other
by fixed test vectors in
[keygate-client/test/golden.test.ts](https://github.com/TeethakingBuilds/keygate-client/blob/main/test/golden.test.ts).
A signature produced here verifies there.

## Configuration

Everything comes from `KEYGATE_*` environment variables, validated at boot by
[`src/config.ts`](./src/config.ts). All problems are reported together and the
process exits non-zero — a decision service that starts with a typo in
`KEYGATE_CORE_CONTRACT` would answer every question about the wrong registry, so
the failure has to happen before the first request rather than at it.

See [`.env.example`](./.env.example) for the annotated list. The interesting one
is `KEYGATE_MAX_STALENESS_SECONDS` (default `120`): the point of a cache is speed,
and a stale cache is a security hole rather than an optimisation, so this is
deliberately tight.

## Design

Directory by directory, and why each boundary is where it is:

- **`src/domain/`** — the vocabulary (`types.ts`), the in-memory projection
  (`mirror.ts`) and the decision function (`decide.ts`). No XDR, no RPC JSON, no
  Node imports. `LedgerEvent` is the only ingestion format, which is what makes
  the ledger layer swappable for a test double or a different provider.
- **`src/ledger/`** — `soroban.ts` talks to RPC, `decoder.ts` turns an event's
  topics and data into a `LedgerEvent`, `sync.ts` drives the paging loop and
  keeps the cursor.
- **`src/http/`** — `server.ts` routes and serialises, `signing.ts` is the HMAC.
  `signing.ts` is the only file that has to agree byte-for-byte with the client.
- **`src/index.ts`** — wiring: config, mirror, engine, sync loop, and shutdown on
  `SIGINT`/`SIGTERM`.

Three properties worth knowing before depending on it:

1. **The mirror is reconstructible, not authoritative.** It is built from emitted
   events, so it can be rebuilt from any ledger range the RPC still retains —
   and `KEYGATE_START_LEDGER` exists for exactly that cold start. Soroban RPC
   keeps a limited window of history, so a long-lived deployment should not count
   on replaying from genesis.
2. **A revocation is only as fast as the sync interval.** `KEYGATE_SYNC_INTERVAL_MS`
   is the worst-case delay between an admin revoking on-chain and this service
   honouring it. Anything that must be instant belongs in the contract
   (`require_access`), not here.
3. **Budget state here is advisory.** The breaker's authoritative window lives in
   the contract, and the mirror observes charges from events. Two instances of
   this service do not share a counter; the contract's `enforce` call is what
   makes a budget true.

## Development

```bash
pnpm lint          # eslint, type-aware
pnpm format:check  # prettier
pnpm typecheck     # tsc --noEmit, strict
pnpm test          # vitest
pnpm check         # all four
pnpm build         # tsc to dist/, then: node dist/index.js
```

Tests never touch the network: `test/sync.test.ts` drives the sync loop against a
fake RPC, and the decision engine is tested as the pure function it is. Coverage
thresholds (80% lines and functions, 75% branches) are enforced by
`vitest.config.ts`, so `pnpm test` fails on a drop.

## Status and scope

Version 0.1.0, **unaudited**. It is a single-process, in-memory projection: there
is no persistence, no clustering and no metrics exporter. Read
[SECURITY.md](./SECURITY.md) before pointing it at real value, and
[CONTRIBUTING.md](./CONTRIBUTING.md) before changing the wire format of a
decision.

## Documentation

- [CONTRIBUTING.md](./CONTRIBUTING.md) — setup, style, how to change a response shape
- [SECURITY.md](./SECURITY.md) — reporting and the trust boundaries of a cache
- [SUPPORT.md](./SUPPORT.md) — where to ask questions
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

## License

Apache-2.0. See [LICENSE](./LICENSE).
