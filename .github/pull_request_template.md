## What this changes

One behaviour. Describe the outcome, not the diff.

## Fail closed?

The rule is that uncertainty produces a denial. If this change makes the service
answer `allowed: true` somewhere it used to refuse, that needs to be argued in an
issue before a pull request.

- [ ] Every new denial has a `DenialReason` member, a comment saying when it fires, and a test that asserts the reason
- [ ] Nothing here treats an unsynced or stale mirror as evidence of absence

## Does it move the wire format?

Check every box that applies, and link the matching change in the other repository:

- [ ] No event decoded differently → the emit in [keygate-contracts](https://github.com/TeethakingBuilds/keygate-contracts)
- [ ] No response shape changed → `Decision` / `DecisionRequest` in [keygate-client](https://github.com/TeethakingBuilds/keygate-client/blob/main/src/types.ts)
- [ ] `canonicalDecision` untouched → if it moved, [keygate-client/src/decision.ts](https://github.com/TeethakingBuilds/keygate-client/blob/main/src/decision.ts) and `test/golden.test.ts` changed with it, in the same release
- [ ] No config key added without a `ConfigSchema` entry and an `.env.example` line

## Tests

- [ ] There is a test that fails without this change
- [ ] The boundary is tested (staleness exactly at the limit, an amount exactly exhausting a budget, an expiry exactly at `now`)
- [ ] No test touches the network

`corepack pnpm check` runs lint, format, typecheck and the suite — the same things
CI does, plus the boot smoke test that asserts `/readyz` is `503` and a decision is
a denial while the mirror is unsynced.

## Notes for the reviewer

Anything the diff does not show: a design you chose over the alternative that
looks simpler, a case you deliberately did not handle.
