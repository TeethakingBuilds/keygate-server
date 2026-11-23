/**
 * Prometheus exposition for the decision service, rendered by hand.
 *
 * No client library on purpose: the whole surface is a handful of counters and
 * gauges, and a dependency would be one more thing to audit on a service whose
 * job is to say no safely. The format is the Prometheus text format
 * (`text/plain; version=0.0.4`): `# HELP` / `# TYPE` lines, then
 * `name{label="value"} number` lines.
 *
 * Cardinality is bounded by construction. Decision outcomes are labelled by
 * the allow/deny answer and the denial reason only; HTTP requests by route
 * template and status only. Holder addresses and resource names never appear
 * in a label — that would be unbounded cardinality, and it would leak who
 * accessed what (see the logging note in `SECURITY.md`).
 */
import type { Clock } from '../domain/clock.js';
import type { LedgerMirror } from '../domain/mirror.js';
import type { SyncState } from '../ledger/sync.js';

export interface MetricsRenderInput {
  readonly mirror: LedgerMirror;
  readonly clock: Clock;
  /** Omitted when the server runs without a sync loop; the sync series go with it. */
  readonly syncState?: SyncState;
}

export class Metrics {
  private readonly decisions = new Map<string, number>();
  private readonly httpRequests = new Map<string, number>();

  /** Records one answered decision. `reason` is null for an allow. */
  decision(allowed: boolean, reason: string | null): void {
    const key = `${allowed ? 'true' : 'false'}|${reason ?? 'none'}`;
    this.decisions.set(key, (this.decisions.get(key) ?? 0) + 1);
  }

  /** Records one answered HTTP request, labelled by route template and status. */
  httpRequest(route: string, status: number): void {
    const key = `${route}|${status}`;
    this.httpRequests.set(key, (this.httpRequests.get(key) ?? 0) + 1);
  }

  render(input: MetricsRenderInput): string {
    const lines: string[] = [];
    const now = input.clock.now();
    const snapshot = input.mirror.snapshot(now);
    const staleness = input.mirror.staleness(now);

    lines.push(
      '# HELP keygate_decisions_total Decisions answered by the engine.',
      '# TYPE keygate_decisions_total counter',
    );
    for (const [key, count] of sorted(this.decisions)) {
      const [allowed, reason] = key.split('|') as [string, string];
      lines.push(
        `keygate_decisions_total{allowed="${allowed}",reason="${escapeLabel(reason)}"} ${count}`,
      );
    }

    lines.push(
      '# HELP keygate_http_requests_total HTTP requests answered, by route template and status.',
      '# TYPE keygate_http_requests_total counter',
    );
    for (const [key, count] of sorted(this.httpRequests)) {
      const [route, status] = key.split('|') as [string, string];
      lines.push(
        `keygate_http_requests_total{route="${escapeLabel(route)}",status="${status}"} ${count}`,
      );
    }

    lines.push(
      '# HELP keygate_mirror_ready Whether the mirror has completed at least one sync (1) or not (0).',
      '# TYPE keygate_mirror_ready gauge',
      `keygate_mirror_ready ${snapshot.ready ? 1 : 0}`,
    );

    // Staleness is undefined before the first observation; an absent gauge is
    // the honest rendering of "unknown", not a zero.
    if (staleness !== undefined) {
      lines.push(
        '# HELP keygate_mirror_staleness_seconds Age in seconds of the newest state the mirror can vouch for.',
        '# TYPE keygate_mirror_staleness_seconds gauge',
        `keygate_mirror_staleness_seconds ${staleness}`,
      );
    }

    lines.push(
      '# HELP keygate_mirror_grants Live grants in the mirror.',
      '# TYPE keygate_mirror_grants gauge',
      `keygate_mirror_grants ${snapshot.grants}`,
      '# HELP keygate_mirror_rules Policy rules in the mirror.',
      '# TYPE keygate_mirror_rules gauge',
      `keygate_mirror_rules ${snapshot.rules}`,
      '# HELP keygate_mirror_budgets Configured budgets in the mirror.',
      '# TYPE keygate_mirror_budgets gauge',
      `keygate_mirror_budgets ${snapshot.budgets}`,
    );

    if (input.syncState !== undefined) {
      if (input.syncState.lastSuccessAt !== undefined) {
        lines.push(
          '# HELP keygate_sync_last_success_timestamp_seconds Unix time of the last successful poll.',
          '# TYPE keygate_sync_last_success_timestamp_seconds gauge',
          `keygate_sync_last_success_timestamp_seconds ${input.syncState.lastSuccessAt}`,
        );
      }
      lines.push(
        '# HELP keygate_sync_errors_total Failed polls since process start.',
        '# TYPE keygate_sync_errors_total counter',
        `keygate_sync_errors_total ${input.syncState.errors}`,
      );
    }

    return `${lines.join('\n')}\n`;
  }
}

function sorted(map: Map<string, number>): [string, number][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
