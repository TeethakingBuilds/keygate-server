/**
 * Process wiring: config, mirror, sync loop, decision engine, HTTP server.
 *
 * Nothing in here is exported for reuse beyond `main`, which exists so a test
 * can boot the whole stack against a fake ledger source.
 */
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

  return {
    port,
    close: async () => {
      sync.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
    },
  };
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
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(running, signal);
    });
  }
}
