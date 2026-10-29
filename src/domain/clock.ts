/**
 * Time is injected rather than read from `Date.now()` so that staleness and
 * expiry — the two behaviours most likely to be silently wrong — can be tested
 * by moving a clock forward instead of sleeping.
 */
import type { Timestamp } from './types.js';

export interface Clock {
  /** Current wall-clock time in ledger-compatible seconds. */
  now(): Timestamp;
}

export const systemClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
};

/** Test/dev clock with an explicit, monotonic reading. */
export class FixedClock implements Clock {
  constructor(private at: Timestamp = 0) {}

  now(): Timestamp {
    return this.at;
  }

  set(at: Timestamp): void {
    this.at = at;
  }

  advance(seconds: number): void {
    this.at += seconds;
  }
}
