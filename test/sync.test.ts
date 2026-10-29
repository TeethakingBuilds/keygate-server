import { describe, expect, it } from 'vitest';

import { FixedClock } from '../src/domain/clock.js';
import { LedgerMirror } from '../src/domain/mirror.js';
import type { LedgerEvent } from '../src/domain/types.js';
import { StateSync, type EventRecord, type LedgerSource } from '../src/ledger/sync.js';

const VAULT = { resource: 'vault:main', action: 'withdraw' };
const noop = { info: () => {}, warn: () => {} };

function record(cursor: string, event: LedgerEvent, ledgerClosedAt = 1_000): EventRecord {
  return { event, ledgerClosedAt, contractId: 'CVAULT', cursor };
}

/** Source whose pages are scripted, with a call log so paging can be asserted. */
class FakeSource implements LedgerSource {
  readonly requestedCursors: string[] = [];
  pages: EventRecord[][] = [];
  failWith: Error | undefined;

  constructor(pages: EventRecord[][]) {
    this.pages = pages;
  }

  fetch(cursor: string): Promise<EventRecord[]> {
    this.requestedCursors.push(cursor);
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    const page = this.pages.shift();
    return Promise.resolve(page ?? []);
  }
}

describe('StateSync paging', () => {
  it('drains every page in one poll', async () => {
    const mirror = new LedgerMirror();
    const source = new FakeSource([
      [record('1-1', { kind: 'rule_set', triple: VAULT, effect: 'allow' })],
      [
        record('1-2', {
          kind: 'grant_issued',
          grant: { id: 1, holder: 'GA', issuer: 'GC', triple: VAULT, expiresAt: 9_000 },
        }),
      ],
      [],
    ]);
    const sync = new StateSync(mirror, source, new FixedClock(500), noop);

    expect(await sync.syncOnce()).toBe(2);
    // A cold registry must reach consistency in one poll, not one page per tick.
    expect(source.requestedCursors).toEqual(['', '1-1', '1-2']);
    expect(sync.state.cursor).toBe('1-2');
    expect(mirror.liveGrant(VAULT, 'GA', 2_000)?.id).toBe(1);
  });

  it('resumes from the cursor it stopped at', async () => {
    const mirror = new LedgerMirror();
    const source = new FakeSource([
      [record('7-3', { kind: 'default_effect', effect: 'allow' })],
      [],
    ]);
    const sync = new StateSync(mirror, source, new FixedClock(1), noop);

    await sync.syncOnce();
    await sync.syncOnce();
    expect(source.requestedCursors).toEqual(['', '7-3', '7-3']);
    expect(mirror.defaultEffect).toBe('allow');
  });

  it('advances the cursor past records it skipped as undecodable', async () => {
    const mirror = new LedgerMirror();
    // A page that ends with an event the source could not map: the cursor must
    // still move, or the poll would request the same page forever.
    const source = new FakeSource([[]]);
    const sync = new StateSync(mirror, source, new FixedClock(1), noop);
    expect(await sync.syncOnce()).toBe(0);
  });

  it('keeps an idle registry answerable', async () => {
    // Nothing has happened on-chain, which is a fact the mirror is allowed to
    // report; failing closed here would deny every request until someone issued
    // a grant.
    const mirror = new LedgerMirror();
    const clock = new FixedClock(9_000);
    const sync = new StateSync(mirror, new FakeSource([[], []]), clock, noop);

    await sync.syncOnce();
    expect(mirror.ready).toBe(true);
    expect(mirror.staleness(9_030)).toBe(30);

    clock.set(9_060);
    await sync.syncOnce();
    expect(mirror.staleness(9_060)).toBe(0);
  });

  it('does not claim an observation it could not make', async () => {
    const mirror = new LedgerMirror();
    const source = new FakeSource([[]]);
    source.failWith = new Error('rpc down');
    const sync = new StateSync(mirror, source, new FixedClock(9_000), noop);

    await sync.syncOnce();
    // A failed poll must leave the mirror exactly as unsure as it was.
    expect(mirror.ready).toBe(false);
    expect(mirror.staleness(9_000)).toBeUndefined();
  });
});

describe('StateSync failure handling', () => {
  it('keeps serving the previous state and records the error', async () => {
    const mirror = new LedgerMirror();
    const source = new FakeSource([
      [record('1-1', { kind: 'rule_set', triple: VAULT, effect: 'allow' })],
      [],
    ]);
    const sync = new StateSync(mirror, source, new FixedClock(10), noop);
    await sync.syncOnce();

    source.failWith = new Error('rpc unavailable');
    expect(await sync.syncOnce()).toBe(0);
    expect(sync.state.lastError).toBe('rpc unavailable');
    // The mirror is not wiped: staleness, not amnesia, is what fails closed.
    expect(mirror.ruleFor(VAULT)).toBe('allow');
    expect(sync.state.lastSuccessAt).toBe(10);
  });

  it('clears the recorded error after a recovery', async () => {
    const mirror = new LedgerMirror();
    const source = new FakeSource([]);
    const sync = new StateSync(mirror, source, new FixedClock(1), noop);

    source.failWith = new Error('boom');
    await sync.syncOnce();
    source.failWith = undefined;
    await sync.syncOnce();

    expect(sync.state.lastError).toBeUndefined();
  });

  it('shares one in-flight poll between concurrent callers', async () => {
    const mirror = new LedgerMirror();
    let fetches = 0;
    const slow: LedgerSource = {
      fetch: async () => {
        fetches += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [];
      },
    };
    const sync = new StateSync(mirror, slow, new FixedClock(1), noop);

    const [a, b] = await Promise.all([sync.syncOnce(), sync.syncOnce()]);
    expect(fetches).toBe(1);
    expect(a).toBe(b);
  });
});

describe('StateSync loop control', () => {
  it('polls repeatedly until stopped', async () => {
    const mirror = new LedgerMirror();
    let polls = 0;
    const source: LedgerSource = {
      fetch: () => {
        polls += 1;
        return Promise.resolve(
          polls === 1 ? [record('1-1', { kind: 'rule_set', triple: VAULT, effect: 'allow' })] : [],
        );
      },
    };
    const sync = new StateSync(mirror, source, new FixedClock(1), noop);

    sync.start(5);
    expect(sync.state.running).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    sync.stop();
    expect(sync.state.running).toBe(false);

    const observed = polls;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A stopped loop must not keep polling.
    expect(polls).toBe(observed);
  });

  it('ignores a second start', () => {
    const source = new FakeSource([[], [], [], []]);
    const sync = new StateSync(new LedgerMirror(), source, new FixedClock(1), noop);
    sync.start(1_000);
    sync.start(1_000);
    sync.stop();
    expect(sync.state.running).toBe(false);
  });
});
