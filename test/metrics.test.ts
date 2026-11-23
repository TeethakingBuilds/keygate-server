import { describe, expect, it } from 'vitest';

import { FixedClock } from '../src/domain/clock.js';
import { LedgerMirror } from '../src/domain/mirror.js';
import { Metrics } from '../src/http/metrics.js';

function seededMirror(): LedgerMirror {
  const mirror = new LedgerMirror();
  mirror.apply(
    { kind: 'rule_set', triple: { resource: 'vault:main', action: 'withdraw' }, effect: 'allow' },
    1_900,
  );
  mirror.markObserved(1_900);
  return mirror;
}

describe('Metrics', () => {
  it('renders counters only for outcomes that happened', () => {
    const metrics = new Metrics();
    metrics.decision(true, null);
    metrics.decision(false, 'capability_missing');
    metrics.httpRequest('/v1/decide', 200);
    metrics.httpRequest('/v1/decide', 200);
    metrics.httpRequest('other', 404);

    const body = metrics.render({ mirror: seededMirror(), clock: new FixedClock(2_000) });
    expect(body).toContain('keygate_decisions_total{allowed="true",reason="none"} 1');
    expect(body).toContain(
      'keygate_decisions_total{allowed="false",reason="capability_missing"} 1',
    );
    expect(body).toContain('keygate_http_requests_total{route="/v1/decide",status="200"} 2');
    expect(body).toContain('keygate_http_requests_total{route="other",status="404"} 1');
    expect(body).toContain('keygate_mirror_staleness_seconds 100');
    expect(body).not.toContain('keygate_sync_');
  });

  it('omits the sync series without a sync loop, and renders them with one', () => {
    const metrics = new Metrics();
    const input = { mirror: seededMirror(), clock: new FixedClock(2_000) };
    expect(metrics.render(input)).not.toContain('keygate_sync_');

    const withSync = metrics.render({
      ...input,
      syncState: {
        cursor: '42-1',
        applied: 1,
        lastSuccessAt: 1_950,
        lastError: undefined,
        errors: 2,
        running: true,
      },
    });
    expect(withSync).toContain('keygate_sync_last_success_timestamp_seconds 1950');
    expect(withSync).toContain('keygate_sync_errors_total 2');
  });

  it('omits the last-success gauge until a poll has succeeded', () => {
    const metrics = new Metrics();
    const body = metrics.render({
      mirror: seededMirror(),
      clock: new FixedClock(2_000),
      syncState: {
        cursor: '',
        applied: 0,
        lastSuccessAt: undefined,
        lastError: 'rpc down',
        errors: 1,
        running: true,
      },
    });
    expect(body).not.toContain('keygate_sync_last_success_timestamp_seconds');
    expect(body).toContain('keygate_sync_errors_total 1');
  });
});
