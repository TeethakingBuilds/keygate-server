/**
 * HTTP surface. Built on `node:http` rather than a framework on purpose: the
 * entire attack surface of a decision service is its request handling, and a
 * dependency-free router is one fewer thing to audit on every security release.
 *
 * Read-only by design. Mutating the registry is a transaction on Stellar and
 * belongs in `keygate-client`, where the caller's key never leaves their own
 * process.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

import type { Clock } from '../domain/clock.js';
import { type DecisionEngine, type Decision, type DecisionRequest } from '../domain/decide.js';
import type { LedgerMirror, MirrorSnapshot } from '../domain/mirror.js';
import { silentLogger, type StateSync, type SyncLogger } from '../ledger/sync.js';
import { signDecision } from './signing.js';

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

const address = z
  .string()
  .refine((value) => StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value), {
    message: 'holder must be a Stellar account (G…) or contract (C…) address',
  });

const nameSegment = z.string().min(1).max(128);

const DecideBodySchema = z.object({
  holder: address,
  resource: nameSegment,
  action: nameSegment,
  /**
   * Accepts a decimal string or an integer. Amounts are i128 on-chain, so a JS
   * number beyond `Number.MAX_SAFE_INTEGER` would be silently wrong — the
   * string form is the one that should be used above 2^53.
   */
  amount: z.union([z.string().regex(/^-?\d+$/), z.number().int()]).optional(),
});

export interface KeygateServerOptions {
  readonly mirror: LedgerMirror;
  readonly engine: DecisionEngine;
  readonly clock: Clock;
  readonly sync?: StateSync;
  readonly signingKey?: string;
  readonly logger?: SyncLogger;
  readonly maxBodyBytes?: number;
  /** Decisions older than this are refused as `state_stale` even if fresh locally. */
  readonly maxStalenessSeconds: number;
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export function createKeygateServer(options: KeygateServerOptions): Server {
  const logger = options.logger ?? silentLogger;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const started = process.hrtime.bigint();
    try {
      const result = await route(request, options, maxBodyBytes);
      write(response, result);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      logger.info('request', {
        method: request.method,
        url: request.url,
        status: result.status,
        ms: Math.round(ms * 100) / 100,
      });
    } catch (error) {
      // One catch-all: an unexpected throw must not print a stack to a client,
      // and must not leave the socket hanging.
      logger.warn('request failed', { error: describe(error), url: request.url });
      write(response, { status: 500, body: { error: 'internal_error' } });
    }
  };

  return createServer((request, response) => {
    void handler(request, response);
  });
}

async function route(
  request: IncomingMessage,
  options: KeygateServerOptions,
  maxBodyBytes: number,
): Promise<HttpResult> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    return { status: 200, body: { status: 'ok' } };
  }

  if (method === 'GET' && path === '/readyz') {
    const staleness = options.mirror.staleness(options.clock.now());
    const ready =
      options.mirror.ready && staleness !== undefined && staleness <= options.maxStalenessSeconds;
    return {
      status: ready ? 200 : 503,
      body: { ready, stalenessSeconds: staleness ?? null },
    };
  }

  if (method === 'GET' && path === '/v1/status') {
    const snapshot = options.mirror.snapshot(options.clock.now());
    return {
      status: 200,
      body: {
        ...serialiseSnapshot(snapshot),
        stalenessSeconds: options.mirror.staleness(options.clock.now()) ?? null,
        sync: options.sync
          ? { cursor: options.sync.state.cursor, lastError: options.sync.state.lastError ?? null }
          : null,
      },
    };
  }

  if (method === 'GET' && path.startsWith('/v1/capabilities/')) {
    const holder = decodeURIComponent(path.slice('/v1/capabilities/'.length));
    const parsed = address.safeParse(holder);
    if (!parsed.success) {
      return {
        status: 400,
        body: { error: 'invalid_holder', detail: parsed.error.issues[0]?.message },
      };
    }
    const grants = options.mirror.capabilitiesOf(parsed.data, options.clock.now());
    return {
      status: 200,
      body: {
        holder: parsed.data,
        // A caller that needs an authoritative answer for a holder with no
        // mirrored grants must treat this as "unknown", not "definitely none".
        stateReady: options.mirror.ready,
        capabilities: grants.map((grant) => ({
          id: grant.id,
          resource: grant.triple.resource,
          action: grant.triple.action,
          expiresAt: grant.expiresAt,
        })),
      },
    };
  }

  if (method === 'POST' && path === '/v1/decide') {
    return decide(request, options, maxBodyBytes);
  }

  if (method === 'POST' && (path === '/v1/sync' || path.startsWith('/v1/admin'))) {
    return { status: 403, body: { error: 'write_path_not_offered' } };
  }

  return { status: 404, body: { error: 'not_found' } };
}

async function decide(
  request: IncomingMessage,
  options: KeygateServerOptions,
  maxBodyBytes: number,
): Promise<HttpResult> {
  const raw = await readBody(request, maxBodyBytes);
  if (raw === null) {
    return { status: 413, body: { error: 'body_too_large' } };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }

  const parsed = DecideBodySchema.safeParse(json);
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      },
    };
  }

  const amount =
    parsed.data.amount === undefined
      ? undefined
      : typeof parsed.data.amount === 'number'
        ? BigInt(parsed.data.amount)
        : BigInt(parsed.data.amount);

  const decisionRequest: DecisionRequest = {
    holder: parsed.data.holder,
    triple: { resource: parsed.data.resource, action: parsed.data.action },
    ...(amount === undefined ? {} : { amount }),
  };

  const decision = options.engine.decide(decisionRequest, options.clock.now());
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (options.signingKey !== undefined) {
    headers['x-keygate-signature'] = signDecision(options.signingKey, decisionRequest, decision);
  }

  return { status: 200, body: serialiseDecision(decision), headers };
}

function serialiseDecision(decision: Decision): Record<string, unknown> {
  if (decision.allowed) {
    return {
      allowed: true,
      grantId: decision.grantId,
      expiresAt: decision.expiresAt,
      budget: decision.budget,
      evaluatedAt: decision.evaluatedAt,
    };
  }
  return {
    allowed: false,
    reason: decision.reason,
    grantId: decision.grantId,
    evaluatedAt: decision.evaluatedAt,
  };
}

function serialiseSnapshot(snapshot: MirrorSnapshot): Record<string, unknown> {
  return {
    ready: snapshot.ready,
    liveGrants: snapshot.grants,
    rules: snapshot.rules,
    budgets: snapshot.budgets,
    defaultEffect: snapshot.defaultEffect,
    registryPaused: snapshot.registryPaused,
    lastAppliedAt: snapshot.lastAppliedAt ?? null,
    lastObservedAt: snapshot.lastObservedAt ?? null,
    appliedEvents: snapshot.appliedEvents,
  };
}

/** Resolves with the body, or null when it exceeds `maxBytes`. */
function readBody(request: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!rejected) {
          rejected = true;
          resolve(null);
        }
        // Deliberately keeps draining instead of destroying the socket: an
        // aborted connection can surface to the caller as a network failure,
        // which is indistinguishable from an outage. A clean 413 is the answer.
        return;
      }
      if (!rejected) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    request.on('error', reject);
  });
}

function write(response: ServerResponse, result: HttpResult): void {
  const payload = JSON.stringify(result.body);
  response.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...result.headers,
  });
  response.end(payload);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
