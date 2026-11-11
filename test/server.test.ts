import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';

import { FixedClock } from '../src/domain/clock.js';
import { DecisionEngine, type BudgetSummary, type Decision } from '../src/domain/decide.js';
import { LedgerMirror } from '../src/domain/mirror.js';
import type { Grant, Triple } from '../src/domain/types.js';
import { createKeygateServer } from '../src/http/server.js';
import { signDecision, verifyDecision } from '../src/http/signing.js';
import { StateSync, type EventRecord, type LedgerSource } from '../src/ledger/sync.js';

const VAULT: Triple = { resource: 'vault:main', action: 'withdraw' };
const HOLDER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const OTHER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const MAX_STALENESS = 120;

/** Seconds between the mirrored events and the fixed clock, kept well inside staleness. */
const EVENT_AT = 1_900;
const NOW = 2_000;

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: 7,
    holder: HOLDER,
    issuer: OTHER,
    triple: VAULT,
    expiresAt: 10_000,
    ...overrides,
  };
}

interface ServeOptions {
  readonly synced?: boolean;
  readonly signingKey?: string;
  readonly apiTokens?: readonly string[];
  readonly now?: number;
  readonly maxBodyBytes?: number;
  readonly withSync?: boolean;
  readonly engine?: DecisionEngine;
}

interface ServeHandle {
  readonly base: string;
  readonly mirror: LedgerMirror;
  readonly sync: StateSync | undefined;
}

/** A stub source: one page of the mirrored history, then nothing. */
function staticSource(records: EventRecord[]): LedgerSource {
  let sent = false;
  return {
    fetch: () => {
      const page = sent ? [] : records;
      sent = true;
      return Promise.resolve(page);
    },
  };
}

/**
 * Starts the real server on an ephemeral port, runs `fn` against it, and always
 * closes it. Everything goes over sockets rather than calling `route()`
 * directly, because header handling and body limits are the point.
 */
async function serve(
  options: ServeOptions,
  fn: (handle: ServeHandle) => Promise<void>,
): Promise<void> {
  const mirror = new LedgerMirror();
  const clock = new FixedClock(options.now ?? NOW);
  if (options.synced ?? true) {
    mirror.apply({ kind: 'rule_set', triple: VAULT, effect: 'allow' }, EVENT_AT);
    mirror.apply({ kind: 'grant_issued', grant: grant() }, EVENT_AT);
    mirror.apply(
      { kind: 'budget_configured', resource: VAULT.resource, limit: 1_000n, windowSeconds: 3_600 },
      EVENT_AT,
    );
    // The poll that produced these events closed at the same ledger time; the
    // clock then sits inside the staleness budget until a test moves it out.
    mirror.markObserved(EVENT_AT);
  }

  const sync =
    options.withSync === true
      ? new StateSync(mirror, staticSource([pendingPage()]), clock)
      : undefined;
  const engine =
    options.engine ?? new DecisionEngine(mirror, { maxStalenessSeconds: MAX_STALENESS });
  const server = createKeygateServer({
    mirror,
    engine,
    clock,
    maxStalenessSeconds: MAX_STALENESS,
    ...(options.signingKey === undefined ? {} : { signingKey: options.signingKey }),
    ...(options.apiTokens === undefined ? {} : { apiTokens: options.apiTokens }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(sync === undefined ? {} : { sync }),
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, mirror, sync });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function pendingPage(): EventRecord {
  return {
    event: { kind: 'default_effect', effect: 'allow' },
    ledgerClosedAt: EVENT_AT,
    contractId: 'C1',
    cursor: '42-1',
  };
}

function decideBody(body: unknown): Record<string, unknown> {
  expect(body).toBeInstanceOf(Object);
  return body as Record<string, unknown>;
}

describe('health and readiness', () => {
  it('reports liveness even with nothing mirrored', async () => {
    await serve({ synced: false }, async ({ base }) => {
      const response = await fetch(`${base}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    });
  });

  it('refuses readiness before the first sync', async () => {
    await serve({ synced: false }, async ({ base }) => {
      const response = await fetch(`${base}/readyz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ready: false, stalenessSeconds: null });
    });
  });

  it('is ready while the mirror is inside the staleness budget', async () => {
    await serve({}, async ({ base }) => {
      const response = await fetch(`${base}/readyz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ready: true, stalenessSeconds: NOW - EVENT_AT });
    });
  });

  it('falls back to unready once the mirror lags, without any new event', async () => {
    await serve({ now: EVENT_AT + MAX_STALENESS + 1 }, async ({ base }) => {
      const response = await fetch(`${base}/readyz`);
      expect(response.status).toBe(503);
      expect(decideBody(await response.json())['ready']).toBe(false);
    });
  });

  it('normalises trailing slashes so a proxy rewrite cannot turn 200 into 404', async () => {
    await serve({}, async ({ base }) => {
      expect((await fetch(`${base}/healthz/`)).status).toBe(200);
    });
  });
});

describe('POST /v1/decide', () => {
  const request = { holder: HOLDER, resource: VAULT.resource, action: VAULT.action };

  function post(base: string, body: unknown): Promise<Response> {
    return fetch(`${base}/v1/decide`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('answers an allowed capability and says the response is uncacheable', async () => {
    await serve({}, async ({ base }) => {
      const response = await post(base, request);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');

      const body = decideBody(await response.json());
      expect(body).toMatchObject({ allowed: true, grantId: 7, expiresAt: 10_000 });
      expect(response.headers.get('x-keygate-signature')).toBeNull();
    });
  });

  it('signs a decision so a downstream service can attribute it', async () => {
    const key = 'a-signing-secret-worth-at-least-16-bytes';
    await serve({ signingKey: key }, async ({ base }) => {
      const response = await post(base, { ...request, amount: '500' });
      const signature = response.headers.get('x-keygate-signature');
      expect(signature).toMatch(/^[0-9a-f]{64}$/);

      const body = decideBody(await response.json());
      const decision: Decision = {
        allowed: true,
        reason: null,
        grantId: body['grantId'] as number,
        expiresAt: body['expiresAt'] as number,
        budget: body['budget'] as BudgetSummary | null,
        evaluatedAt: body['evaluatedAt'] as number,
      };
      const signed = { holder: HOLDER, triple: VAULT, amount: 500n };
      expect(verifyDecision(key, signed, decision, signature ?? '')).toBe(true);
      // The same signature must not validate for a different subject.
      expect(verifyDecision(key, { ...signed, holder: OTHER }, decision, signature ?? '')).toBe(
        false,
      );
    });
  });

  it('returns a denial as a 200, because "no" is a valid answer', async () => {
    await serve({}, async ({ base }) => {
      const response = await post(base, { ...request, holder: OTHER });
      expect(response.status).toBe(200);
      expect(decideBody(await response.json())).toMatchObject({
        allowed: false,
        reason: 'capability_missing',
      });
    });
  });

  it('fails closed with an explicit reason while unsynced', async () => {
    await serve({ synced: false }, async ({ base }) => {
      const response = await post(base, request);
      expect(response.status).toBe(200);
      expect(decideBody(await response.json())).toMatchObject({
        allowed: false,
        reason: 'state_unsynced',
      });
    });
  });

  it('rejects a holder that is not a Stellar address', async () => {
    await serve({}, async ({ base }) => {
      const response = await post(base, { ...request, holder: 'alice' });
      expect(response.status).toBe(400);
      const body = decideBody(await response.json());
      expect(body['error']).toBe('invalid_request');
      expect(body['detail']).toBeInstanceOf(Array);
    });
  });

  it.each([1.5, -1.5, '1.5', '-1.5'])('rejects fractional amount %s', async (amount) => {
    await serve({}, async ({ base }) => {
      const response = await post(base, { ...request, amount });
      expect(response.status).toBe(400);
      expect(decideBody(await response.json())['error']).toBe('invalid_request');
    });
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1])(
    'rejects unsafe numeric amount %s',
    async (amount) => {
      await serve({}, async ({ base }) => {
        const response = await post(base, { ...request, amount });
        expect(response.status).toBe(400);
        expect(decideBody(await response.json())['error']).toBe('invalid_request');
      });
    },
  );

  it('rejects a raw JSON integer that loses precision during parsing', async () => {
    await serve({}, async ({ base }) => {
      const raw = `${JSON.stringify(request).slice(0, -1)},"amount":9007199254740993}`;
      const response = await post(base, raw);
      expect(response.status).toBe(400);
      expect(decideBody(await response.json())['error']).toBe('invalid_request');
    });
  });

  it.each([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0, -1])(
    'passes safe numeric amount %s to the domain exactly',
    async (amount) => {
      const key = 'a-signing-secret-worth-at-least-16-bytes';
      await serve({ signingKey: key }, async ({ base }) => {
        const response = await post(base, { ...request, amount });
        const decision: Decision = {
          allowed: false,
          reason: amount <= 0 ? 'amount_invalid' : 'budget_exhausted',
          grantId: 7,
          evaluatedAt: NOW,
        };
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(decision);
        expect(
          verifyDecision(
            key,
            { holder: HOLDER, triple: VAULT, amount: BigInt(amount) },
            decision,
            response.headers.get('x-keygate-signature') ?? '',
          ),
        ).toBe(true);
      });
    },
  );

  it.each([
    '9007199254740993',
    '-9007199254740993',
    '340282366920938463463374607431768211455',
    '-340282366920938463463374607431768211455',
  ])('preserves large decimal string %s exactly', async (amount) => {
    const key = 'a-signing-secret-worth-at-least-16-bytes';
    await serve({ signingKey: key }, async ({ base }) => {
      const response = await post(base, { ...request, amount });
      const decision: Decision = {
        allowed: false,
        reason: BigInt(amount) <= 0n ? 'amount_invalid' : 'budget_exhausted',
        grantId: 7,
        evaluatedAt: NOW,
      };
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(decision);
      expect(
        verifyDecision(
          key,
          { holder: HOLDER, triple: VAULT, amount: BigInt(amount) },
          decision,
          response.headers.get('x-keygate-signature') ?? '',
        ),
      ).toBe(true);
    });
  });

  it('rejects a body that is not JSON', async () => {
    await serve({}, async ({ base }) => {
      const response = await post(base, 'grant me please');
      expect(response.status).toBe(400);
      expect(decideBody(await response.json())).toEqual({ error: 'invalid_json' });
    });
  });

  it('rejects an oversized body with 413 rather than an empty response', async () => {
    await serve({ maxBodyBytes: 64 }, async ({ base }) => {
      const padded = { ...request, resource: `${VAULT.resource}${'x'.repeat(4_096)}` };
      const response = await post(base, padded);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'body_too_large' });
    });
  });
});

describe('read-only projections', () => {
  const capabilities = (base: string, holder: string): Promise<Response> =>
    fetch(`${base}/v1/capabilities/${encodeURIComponent(holder)}`);

  it('lists a holder live capabilities and flags whether the state is trustworthy', async () => {
    await serve({}, async ({ base }) => {
      const response = await capabilities(base, HOLDER);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        holder: HOLDER,
        stateReady: true,
        capabilities: [
          { id: 7, resource: VAULT.resource, action: VAULT.action, expiresAt: 10_000 },
        ],
      });
    });
  });

  it('says "unknown", not "definitely none", for a cold mirror', async () => {
    await serve({ synced: false }, async ({ base }) => {
      expect(decideBody(await (await capabilities(base, HOLDER)).json())['stateReady']).toBe(false);
    });
  });

  it('hides expired grants while keeping live ones', async () => {
    await serve({ now: 11_000 }, async ({ base, mirror }) => {
      // Applied at the current clock so the mirror itself stays fresh; only the
      // capability is old.
      mirror.apply({ kind: 'grant_issued', grant: { ...grant(), expiresAt: 10_999 } }, 11_000);
      mirror.apply(
        {
          kind: 'grant_issued',
          grant: {
            ...grant(),
            id: 8,
            triple: { resource: 'vault:backup', action: 'read' },
            expiresAt: 20_000,
          },
        },
        11_000,
      );

      const body = decideBody(await (await capabilities(base, HOLDER)).json());
      expect(body['capabilities']).toEqual([
        { id: 8, resource: 'vault:backup', action: 'read', expiresAt: 20_000 },
      ]);
    });
  });

  it('rejects a malformed holder in the path', async () => {
    await serve({}, async ({ base }) => {
      const response = await capabilities(base, 'not-an-address');
      expect(response.status).toBe(400);
      expect(decideBody(await response.json())['error']).toBe('invalid_holder');
    });
  });

  it('exposes the mirror and the sync cursor through /v1/status', async () => {
    await serve({ withSync: true }, async ({ base, sync }) => {
      expect((await sync?.syncOnce()) ?? 0).toBe(1);

      const body = decideBody(await (await fetch(`${base}/v1/status`)).json());
      expect(body['ready']).toBe(true);
      expect(body['liveGrants']).toBe(1);
      expect(body['budgets']).toBe(1);
      expect(body['defaultEffect']).toBe('allow');
      expect(body['appliedEvents']).toBe(4);
      expect(body['sync']).toEqual({ cursor: '42-1', lastError: null });
    });
  });

  it('reports no sync section when the server runs without one', async () => {
    await serve({}, async ({ base }) => {
      expect(decideBody(await (await fetch(`${base}/v1/status`)).json())['sync']).toBeNull();
    });
  });
});

describe('bearer token authentication', () => {
  const TOKEN = 'k'.repeat(32);
  const WRONG = 'w'.repeat(32);
  const CAPABILITIES = `/v1/capabilities/${HOLDER}`;

  it('rejects a /v1 request with no authorization header', async () => {
    await serve({ apiTokens: [TOKEN] }, async ({ base }) => {
      const response = await fetch(`${base}${CAPABILITIES}`);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    });
  });

  it('rejects a wrong token', async () => {
    await serve({ apiTokens: [TOKEN] }, async ({ base }) => {
      const response = await fetch(`${base}${CAPABILITIES}`, {
        headers: { authorization: `Bearer ${WRONG}` },
      });
      expect(response.status).toBe(401);
    });
  });

  it('accepts any configured token', async () => {
    await serve({ apiTokens: [WRONG, TOKEN] }, async ({ base }) => {
      const response = await fetch(`${base}${CAPABILITIES}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(200);
    });
  });

  it('keeps the health routes open without a token', async () => {
    await serve({ apiTokens: [TOKEN] }, async ({ base }) => {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
    });
  });

  it('leaves /v1 open when no tokens are configured', async () => {
    await serve({}, async ({ base }) => {
      const response = await fetch(`${base}${CAPABILITIES}`);
      expect(response.status).toBe(200);
    });
  });
});

describe('generated responses are uncacheable', () => {
  const key = 'a-signing-secret-worth-at-least-16-bytes';
  const request = { holder: HOLDER, resource: VAULT.resource, action: VAULT.action };
  const post = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const throwingEngine = new DecisionEngine(new LedgerMirror(), {
    maxStalenessSeconds: MAX_STALENESS,
  });
  vi.spyOn(throwingEngine, 'decide').mockImplementation(() => {
    throw new Error('unexpected engine failure');
  });
  const allowed: Decision = {
    allowed: true,
    reason: null,
    grantId: 7,
    expiresAt: 10_000,
    budget: null,
    evaluatedAt: NOW,
  };
  const denied: Decision = {
    allowed: false,
    reason: 'capability_missing',
    grantId: null,
    evaluatedAt: NOW,
  };
  const cases: {
    name: string;
    path: string;
    status: number;
    body: Record<string, unknown>;
    options?: ServeOptions;
    init?: RequestInit;
    signature?: string;
    authenticate?: string;
  }[] = [
    {
      name: 'health',
      path: '/healthz',
      status: 200,
      body: { status: 'ok' },
      options: { synced: false },
    },
    {
      name: 'ready',
      path: '/readyz',
      status: 200,
      body: { ready: true, stalenessSeconds: NOW - EVENT_AT },
    },
    {
      name: 'unready before sync',
      path: '/readyz',
      status: 503,
      body: { ready: false, stalenessSeconds: null },
      options: { synced: false },
    },
    {
      name: 'unready when stale',
      path: '/readyz',
      status: 503,
      body: { ready: false, stalenessSeconds: MAX_STALENESS + 1 },
      options: { now: EVENT_AT + MAX_STALENESS + 1 },
    },
    {
      name: 'status',
      path: '/v1/status',
      status: 200,
      body: { ready: true, liveGrants: 1, budgets: 1, sync: null },
    },
    {
      name: 'capabilities',
      path: `/v1/capabilities/${HOLDER}`,
      status: 200,
      body: {
        holder: HOLDER,
        stateReady: true,
        capabilities: [{ id: 7, ...VAULT, expiresAt: 10_000 }],
      },
    },
    {
      name: 'allowed decision',
      path: '/v1/decide',
      init: post(request),
      status: 200,
      body: { allowed: true, grantId: 7, expiresAt: 10_000, budget: null, evaluatedAt: NOW },
      signature: signDecision(key, { holder: HOLDER, triple: VAULT }, allowed),
    },
    {
      name: 'denied decision',
      path: '/v1/decide',
      init: post({ ...request, holder: OTHER }),
      status: 200,
      body: { ...denied },
      signature: signDecision(key, { holder: OTHER, triple: VAULT }, denied),
    },
    {
      name: 'invalid JSON',
      path: '/v1/decide',
      init: post('not JSON'),
      status: 400,
      body: { error: 'invalid_json' },
    },
    {
      name: 'invalid request',
      path: '/v1/decide',
      init: post({ ...request, amount: 1.5 }),
      status: 400,
      body: { error: 'invalid_request' },
    },
    {
      name: 'invalid holder',
      path: '/v1/capabilities/not-an-address',
      status: 400,
      body: { error: 'invalid_holder' },
    },
    {
      name: 'unauthorized',
      path: '/v1/status',
      status: 401,
      body: { error: 'unauthorized' },
      options: { apiTokens: ['k'.repeat(32)] },
      authenticate: 'Bearer',
    },
    {
      name: 'forbidden sync',
      path: '/v1/sync',
      init: post({}),
      status: 403,
      body: { error: 'write_path_not_offered' },
    },
    {
      name: 'forbidden admin',
      path: '/v1/admin/grant',
      init: post({}),
      status: 403,
      body: { error: 'write_path_not_offered' },
    },
    {
      name: 'not found',
      path: '/v1/nope',
      status: 404,
      body: { error: 'not_found' },
    },
    {
      name: 'oversized body',
      path: '/v1/decide',
      init: post(request),
      status: 413,
      body: { error: 'body_too_large' },
      options: { maxBodyBytes: 64 },
    },
    {
      name: 'unexpected engine failure',
      path: '/v1/decide',
      init: post(request),
      status: 500,
      body: { error: 'internal_error' },
      options: { engine: throwingEngine },
    },
  ];

  it.each(cases)('sets no-store for $name', async (testCase) => {
    await serve({ ...testCase.options, signingKey: key }, async ({ base }) => {
      const response = await fetch(`${base}${testCase.path}`, testCase.init);
      expect(response.status).toBe(testCase.status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('x-keygate-signature')).toBe(testCase.signature ?? null);
      expect(response.headers.get('www-authenticate')).toBe(testCase.authenticate ?? null);
      const payload = await response.text();
      expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(payload)));
      expect(JSON.parse(payload) as unknown).toMatchObject(testCase.body);
    });
  });
});

describe('write paths are not offered', () => {
  it('refuses to be used as a way to mutate the registry', async () => {
    await serve({}, async ({ base }) => {
      for (const path of ['/v1/admin/grant', '/v1/sync']) {
        const response = await fetch(`${base}${path}`, { method: 'POST', body: '{}' });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'write_path_not_offered' });
      }
    });
  });

  it('answers 404 for anything else', async () => {
    await serve({}, async ({ base }) => {
      expect((await fetch(`${base}/v1/nope`)).status).toBe(404);
      expect((await fetch(`${base}/`)).status).toBe(404);
    });
  });
});
