# Contributing to keygate-server

## Setup

Node 20+ and pnpm. The repository pins `packageManager` in `package.json`, and
`preinstall` refuses any other package manager, so use the wrapper:

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm check          # lint + format:check + typecheck + test
```

`pnpm dev` runs the service on `KEYGATE_PORT` with `tsx watch`. It needs a real
Soroban RPC endpoint and three deployed contract ids — see
[.env.example](./.env.example) — because the whole point of the process is
ingesting events. Tests need none of that.

## Where the code lives

```
src/domain/types.ts    the vocabulary: Triple, Grant, Budget, LedgerEvent
src/domain/mirror.ts   the in-memory projection, fed only by apply(event)
src/domain/decide.ts   the decision function and the DenialReason union
src/ledger/soroban.ts  RPC calls and XDR → ScNode
src/ledger/decoder.ts  ScNode → LedgerEvent, one branch per event topic
src/ledger/sync.ts     the paging loop and the cursor
src/http/server.ts     routing, body limits, serialisation
src/http/signing.ts    the canonical decision string and its HMAC
src/index.ts           wiring and shutdown
```

The rule the layout exists to enforce: **`src/domain/` imports nothing from
`src/ledger/`, `src/http/`, or `node:`.** A `LedgerEvent` is the only ingestion
format, which is why the sync loop can be tested against a fake and why a
different RPC provider is a change to one file.

## How this repository relates to the other two

| In this repository                             | Mirrored elsewhere                                                                                             | As                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| the decode table in `src/ledger/decoder.ts`    | [keygate-contracts](https://github.com/TeethakingBuilds/keygate-contracts)                                     | the event topics and argument order those contracts emit                                      |
| `canonicalDecision()` in `src/http/signing.ts` | [keygate-client/src/decision.ts](https://github.com/TeethakingBuilds/keygate-client/blob/main/src/decision.ts) | a byte-identical rendering, verified by fixed vectors in `keygate-client/test/golden.test.ts` |
| the `DenialReason` union                       | [keygate-client/src/types.ts](https://github.com/TeethakingBuilds/keygate-client/blob/main/src/types.ts)       | the reason type a caller switches on                                                          |

The signing file is the one place a whitespace change breaks a deployment. If you
touch `canonicalDecision`, add the new shape to the golden vectors in the client
and expect to publish both repositories together; old signatures verify only as
long as the canonical string does not move.

Unknown event topics decode to `null` and are skipped rather than thrown, so a
contract upgrade that adds events cannot stop a running indexer. That is
deliberate — but it means a _renamed_ topic silently stops being ingested. When
you change an emit in the contracts, change the decoder here in the same pull
request and add a decode test for it.

## Code style

Prettier and type-aware ESLint decide the mechanical parts; CI runs both.
Beyond that:

- **Fail closed, and say why.** A new check in `decide()` needs a `DenialReason`
  member, a comment on the union saying when it fires, and a test asserting the
  reason — not just `allowed: false`. An operator distinguishes "broken" from
  "not authorised" by that string alone.
- **Never allow on uncertainty.** If the mirror is stale, unsynced, or missing a
  record, the answer is a denial. Adding a fallback that guesses allow is the one
  change this project will refuse.
- **Amounts are strings across the wire.** They are `i128` on-chain; a JS number
  beyond `2^53` is silently wrong. Keep `BigInt` inside the domain and serialise
  with `toString()`.
- **Validation belongs at boot.** A new configuration key goes through
  `ConfigSchema`, which reports every problem at once and exits non-zero. Do not
  add a per-request fallback for a value that should have been caught at start.
- **No new route without a reason it cannot be a client call.** This service has
  no write path on purpose (`/v1/sync` and `/v1/admin*` answer `403`);
  capabilities change by sending a transaction.

## Tests

One hundred and twenty tests in `test/`, all offline. The ledger layer is driven
by a fake RPC that answers from fixtures; the engine is called as the pure
function it is, with an injected clock. Two cases any new test should include,
because they are the ones easy to forget: the reason string on a denial, and the
boundary (staleness exactly at the limit, an amount exactly exhausting a budget,
an expiry exactly at `now`).

Coverage thresholds are enforced by `vitest.config.ts` (80% lines and functions,
75% branches) — `pnpm test` fails on a drop, so an untested branch is a visible
cost rather than a silent one.

## Pull requests

- One behaviour per pull request, with a test that fails without it.
- `corepack pnpm check` green before you push; CI runs the same commands.
- If you changed a response shape, a denial reason, or the canonical signing
  string, say so and link the matching `keygate-client` change.
- By contributing you confirm you may license the change under Apache-2.0, and
  this project follows the [Code of Conduct](./CODE_OF_CONDUCT.md).

## What this project will not add

Persistence, clustering, a shared budget counter between instances, or metrics
exporters. The mirror is a projection that can be rebuilt from events, so a
restart is a re-sync rather than a migration; per-instance sync is simpler than
coordination and no less correct, because the contract is the authority either
way. If you have a design for any of these, open an issue first — a pull request
implementing one is likely to be declined on scope, not on quality.

See also [SUPPORT.md](./SUPPORT.md) for where to ask questions and
[SECURITY.md](./SECURITY.md) for reporting.
