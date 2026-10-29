# Security policy

## Reporting a vulnerability

Use **Security → Report a vulnerability** on this repository. The advisory is
private: it is visible only to the reporter and the maintainer. Do not open a
public issue, and do not file a pull request that shows the exploit.

Expect an acknowledgement within a week. If a fix is possible, one ships before
the advisory becomes public, and the release notes credit the reporter unless
they ask not to be.

## Supported versions

| Version        | Supported                       |
| -------------- | ------------------------------- |
| 0.1.x          | yes                             |
| anything older | no — deploy the current release |

keygate is versioned 0.x and **this service is unaudited**. It is a projection of
state owned by [keygate-contracts](https://github.com/TeethakingBuilds/keygate-contracts),
which are themselves unaudited; read that repository's
[SECURITY.md](https://github.com/TeethakingBuilds/keygate-contracts/blob/main/SECURITY.md)
too, because a bug in the contracts is a bug in every answer given here.

## What this service is trusted with

An allow from `/v1/decide` is a reason to let something happen. So the interesting
question is not "can the cache be read" but "can the cache be made to say
`allowed: true` for someone who should not be". These are the ways it can, in
rough order of how much they have shaped the design:

1. **It is a cache, so a revocation is late by up to the sync interval.**
   `KEYGATE_SYNC_INTERVAL_MS` is the worst-case gap between an admin revoking
   on-chain and this service honouring it, and `KEYGATE_MAX_STALENESS_SECONDS` is
   added on top of that. A deployment that sets staleness to minutes to stop
   seeing `state_stale` has bought uptime with the property that made this service
   safe to use. Anything that must stop instantly belongs in the contract
   (`require_access`) or in the breaker, not here.
2. **The RPC is believed.** Events come from one endpoint; a lying or truncated
   RPC can withhold a revocation event, and this process cannot tell that apart
   from a quiet chain. `GET /v1/status` publishes the cursor, the counts and the
   last error so you can compare against your own reader, and the mirror is
   reconstructible from any ledger range the RPC retains — but there is no
   cross-check built in. For real value, point `KEYGATE_SOROBAN_RPC_URL` at an
   endpoint you run.
3. **The signing key is the decision.** `KEYGATE_SIGNING_KEY` is a shared secret:
   anyone holding it can produce signatures that `keygate-client` accepts for any
   holder and any amount. That is what makes HMAC the right scheme here (a caller
   only needs to know the answer came from the service, not who in the service
   said it), but it also means there is no non-repudiation and no rotation —
   leak the key and every past and future decision is forgeable until you
   redistribute it. Treat it like a credential that signs money.
4. **A budget answer is advisory and races by design.** `remaining` is headroom
   _before_ the charge and nothing is reserved; N concurrent callers can each be
   approved for the whole remainder and the contract's `enforce` is what decides
   the winner. Two instances of this service do not share a counter. Do not treat
   an allow with an amount as a reservation.
5. **Nothing authenticates the caller.** There is no API key, no mTLS, no rate
   limit — `GET /v1/capabilities/:holder` answers for any address, which means
   anyone who can reach the port can enumerate who holds grants and when. The
   process assumes it sits behind something that does not. Put it on a private
   network or behind authentication before putting it on the internet.
6. **Absence is not proof, and only `ready` says so.** Until the first sync
   completes, the mirror knows nothing and every decision is `state_unsynced`;
   `/v1/capabilities/:holder` can answer `[]` while `stateReady` is false. A
   client that ignores `stateReady` turns "not indexed yet" into "definitely no
   grants", which is safe for the holder's own checks and wrong for anything that
   infers a _denial_ from it.

## What is in scope

- An `allowed: true` from this service for a holder with no live grant, or for an
  action a policy rule denies.
- A stale, unsynced or partially-synced mirror producing an allow instead of a
  fail-closed denial.
- A decision signature that verifies for a different request than the one it was
  issued for (a different holder, amount, or resource).
- A request that makes the process crash, hang a socket, or leak another tenant's
  data — including through logs.
- Reading the private key material, the signing key, or the RPC endpoint's
  credentials out of a response or a log line.
- A body, path, or amount that the ingest loop mis-decodes into a state change the
  contract never emitted.

## What is out of scope

- Being a cache: a revocation honoured one sync interval late, or `state_stale`
  denying traffic while the RPC is down. Both are documented behaviour, and
  denying is the safe direction.
- Compromise of the host: if an attacker can read the process's environment they
  have the signing key, and no design here changes that.
- Attacks on Soroban RPC, the Stellar network, or the contracts' own logic.
- Enumeration of capability holders by someone who can reach an unauthenticated
  port — that is the deployment's boundary, item 5 above.
- Versions older than the table.

## Practical checklist before real value

- `KEYGATE_MAX_STALENESS_SECONDS` as low as your RPC's latency budget allows.
- `KEYGATE_SIGNING_KEY` set (`openssl rand -hex 32`), stored as a secret, never
  committed, and known to as few services as possible.
- The port bound to a private interface or a reverse proxy that authenticates.
- `GET /readyz` wired to the load balancer, so an unsynced instance takes no
  traffic.
- Log shipping treated as sensitive: `request` lines carry the URL, which for
  `/v1/capabilities/G…` includes the holder address. Addresses are on-chain and
  not secret, but _who accessed what, when_ is.
- An on-call rule that `lastError` in `/v1/status` being non-null for more than
  one sync interval pages someone.

## Threat model in one paragraph

This service is an opinion about on-chain state, held in memory, refreshed from an
RPC it trusts, and expressed as a signed yes-or-no. The state itself is not secret
— every grant is an on-chain event, so anyone who can read the ledger can rebuild
the mirror and reason about exactly what it knows. What an attacker cannot do
without either the admin set (to mint a capability on-chain) or the signing key
(to fake a decision off-chain) is turn a denial into an allow that a downstream
service accepts. Between those two, the design bet is that being wrong is
uncomfortable rather than dangerous: every unknown — unsynced, stale, missing
grant, unconfigured budget — resolves to a denial.
