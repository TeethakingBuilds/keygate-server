/**
 * Process wiring: config, mirror, sync loop, decision engine, HTTP server.
 *
 * Nothing in here is exported for reuse beyond `main`, which exists so a test
 * can boot the whole stack against a fake ledger source.
 */
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

import { loadConfig, type Config } from './config.js';
import { systemClock } from './domain/clock.js';
import { LedgerMirror } from './domain/mirror.js';
import { DecisionEngine } from './domain/decide.js';
import { RpcSource } from './ledger/soroban.js';
import { StateSync, type LedgerSource, type SyncLogger } from './ledger/sync.js';
import { createKeygateServer } from './http/server.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

function makeLogger(level: keyof typeof LEVELS): SyncLogger {
  const threshold = LEVELS[level];
  const emit = (priority: number, message: string, fields?: Record<string, unknown>): void => {
    if (priority < threshold) {
      return;
    }
    const line = { ts: new Date().toISOString(), message, ...fields };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
  return {
    info: (message, fields) => emit(LEVELS.info, message, fields),
    warn: (message, fields) => emit(LEVELS.warn, message, fields),
  };
}

export interface Running {
  readonly port: number;
  close(): Promise<void>;
}

export interface MainDependencies {
  /** Injected by tests; production uses `RpcSource`. */
  createSource?: (config: Config) => LedgerSource;
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  deps: MainDependencies = {},
): Promise<Running> {
  const config = loadConfig(env);
  const logger = makeLogger(config.logLevel);

  const mirror = new LedgerMirror();
  const source = (
    deps.createSource ??
    ((c: Config) =>
      new RpcSource({
        rpcUrl: c.sorobanRpcUrl,
        limit: c.syncPageSize,
        contracts: { core: c.coreContract, policy: c.policyContract, breaker: c.breakerContract },
        ...(c.startLedger === undefined ? {} : { startLedger: c.startLedger }),
      }))
  )(config);

  const sync = new StateSync(mirror, source, systemClock, logger);
  const engine = new DecisionEngine(mirror, { maxStalenessSeconds: config.maxStalenessSeconds });

  const server = createKeygateServer({
    mirror,
    engine,
    clock: systemClock,
    sync,
    logger,
    maxStalenessSeconds: config.maxStalenessSeconds,
    ...(config.signingKey === undefined ? {} : { signingKey: config.signingKey }),
    ...(config.apiTokens === undefined ? {} : { apiTokens: config.apiTokens }),
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => {
      server.off('error', reject);
      resolve();
    });
  });

  sync.start(config.syncIntervalMs);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  logger.info('keygate-server listening', {
    port,
    rpc: config.sorobanRpcUrl,
    core: config.coreContract,
    maxStalenessSeconds: config.maxStalenessSeconds,
    signing: config.signingKey !== undefined,
  });

  // Sockets with a request in flight are the only thing that can keep
  // `server.close()` waiting; they are tracked so the shutdown deadline can
  // destroy them instead of waiting forever.
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  // One shutdown operation, shared by repeated `close()` calls and repeated
  // signals: the second caller waits on the first caller's promise instead of
  // starting a second drain.
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing === undefined) {
      closing = shutdownServer(server, sockets, sync, config.shutdownTimeoutMs);
    }
    return closing;
  };

  return { port, close };
}

/**
 * Stops the sync loop, stops accepting new connections, lets in-flight
 * requests finish, and force-closes whatever is left at the deadline. The
 * deadline is what makes this bounded: without it a single stalled client
 * could hold a deploy hostage.
 */
async function shutdownServer(
  server: Server,
  sockets: Set<Socket>,
  sync: StateSync,
  timeoutMs: number,
): Promise<void> {
  // Aborts any poll in flight; its late answer is discarded, not applied.
  sync.stop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>((resolve) => {
    server.close(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve();
    });
    // Idle keep-alive connections hold no request; drop them now so the close
    // only ever waits on requests that are actually in flight.
    server.closeIdleConnections?.();
  });
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      server.closeIdleConnections?.();
      for (const socket of sockets) {
        socket.destroy();
      }
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([closed, deadline]);
}

async function shutdown(running: Running, signal: string): Promise<void> {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), message: 'shutting down', signal })}\n`,
  );
  await running.close();
  process.exit(0);
}

// Only run when executed directly, so `import { main }` in a test does not bind
// signal handlers or open a socket. `pathToFileURL` because the comparison is
// against a URL: a Windows argv path (`C:\…`) is not a `file://` URL, and
// hand-stacking the scheme would silently boot nothing on that platform.
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  const running = await main();
  // A second signal during a graceful stop waits on the same shutdown rather
  // than starting another one; the deadline bounds the wait either way.
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      void shutdown(running, signal);
    });
  }
}
