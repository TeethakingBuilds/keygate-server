/**
 * Polls a `LedgerSource` and feeds the mirror.
 *
 * A failed poll is logged and swallowed. That is intentional: the mirror keeps
 * its last known state, whose age grows, and once it crosses
 * `maxStalenessSeconds` the decision engine denies everything. Recovery needs no
 * special case — the next successful poll makes the state fresh again.
 */
import { systemClock, type Clock } from '../domain/clock.js';
import type { LedgerMirror } from '../domain/mirror.js';
import type { Address, LedgerEvent, Timestamp } from '../domain/types.js';

export interface EventRecord {
  readonly event: LedgerEvent;
  /** Ledger close time of the transaction that emitted the event. */
  readonly ledgerClosedAt: Timestamp;
  readonly contractId: Address;
  /**
   * Opaque position of this record in the stream. The source defines it; the
   * sync loop only ever copies the newest one it has applied.
   */
  readonly cursor: string;
}

export interface LedgerSource {
  /** Events strictly after `cursor`, oldest first. `''` means "from the start". */
  fetch(cursor: string, signal?: AbortSignal): Promise<EventRecord[]>;
}

export interface SyncLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: SyncLogger = {
  info: () => {},
  warn: () => {},
};

export interface SyncState {
  readonly cursor: string;
  readonly applied: number;
  readonly lastSuccessAt: Timestamp | undefined;
  readonly lastError: string | undefined;
  readonly running: boolean;
}

export class StateSync {
  private cursor = '';
  private applied = 0;
  private lastSuccessAt: Timestamp | undefined;
  private lastError: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<number> | undefined;
  private running = false;

  constructor(
    private readonly mirror: LedgerMirror,
    private readonly source: LedgerSource,
    private readonly clock: Clock = systemClock,
    private readonly logger: SyncLogger = silentLogger,
  ) {}

  get state(): SyncState {
    return {
      cursor: this.cursor,
      applied: this.applied,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      running: this.running,
    };
  }

  /**
   * Concurrent callers share one poll. Without this, a slow RPC page lets a
   * timer tick and a `/sync` request apply the same events twice.
   */
  syncOnce(signal?: AbortSignal): Promise<number> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const attempt = this.drain(signal).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = attempt;
    return attempt;
  }

  /**
   * Drains every available page rather than one per tick, so a cold registry
   * with tens of thousands of grants reaches consistency in a single poll
   * instead of denying decisions for hundreds of intervals.
   */
  private async drain(signal?: AbortSignal): Promise<number> {
    let applied = 0;
    try {
      for (;;) {
        const page = await this.source.fetch(this.cursor, signal);
        // Marked before the records are applied: an empty page still proves the
        // mirror is current, and that is what keeps an idle registry answerable.
        this.mirror.markObserved(this.clock.now());
        if (page.length === 0) {
          break;
        }
        for (const record of page) {
          this.mirror.apply(record.event, record.ledgerClosedAt);
          applied += 1;
          this.cursor = record.cursor;
        }
      }
      this.applied += applied;
      this.lastSuccessAt = this.clock.now();
      this.lastError = undefined;
      if (applied > 0) {
        this.logger.info('sync applied events', { applied, cursor: this.cursor });
      }
      return applied;
    } catch (error) {
      this.lastError = describe(error);
      this.logger.warn('sync failed', { error: this.lastError, cursor: this.cursor });
      return applied;
    }
  }

  /** Repeating poll. Overlapping ticks are collapsed by `syncOnce`. */
  start(intervalMs: number): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const tick = (): void => {
      if (!this.running) {
        return;
      }
      void this.syncOnce().finally(() => {
        if (this.running) {
          this.timer = setTimeout(tick, intervalMs);
          this.timer.unref?.();
        }
      });
    };
    tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
