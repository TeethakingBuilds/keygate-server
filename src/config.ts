/**
 * Environment-driven configuration. Parsing is front-loaded and total: a
 * decision service that starts with a typo in `CORE_CONTRACT` would answer
 * every question about the wrong registry, so the process must fail at boot
 * rather than at first request.
 */
import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

const contractId = z.string().refine((value) => StrKey.isValidContract(value), {
  message: 'expected a Soroban contract id (C…)',
});

const signingKey = z
  .string()
  .min(16, 'KEYGATE_SIGNING_KEY must be at least 16 bytes of secret material');

export const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(8080),

  sorobanRpcUrl: z.string().url(),

  coreContract: contractId,
  policyContract: contractId,
  breakerContract: contractId,

  /**
   * Cold-start replay point. Soroban RPC only retains a limited window of
   * history, so this is a safety net for a fresh deployment rather than a way to
   * rebuild years of state.
   */
  startLedger: z.coerce.number().int().min(0).optional(),

  /**
   * How long a mirror may lag the network before decisions fail closed.
   * Deliberately tight: the whole point of caching is speed, and a stale cache
   * is a security hole rather than an optimisation.
   */
  maxStalenessSeconds: z.coerce.number().int().min(1).default(120),
  syncIntervalMs: z.coerce.number().int().min(100).default(5_000),
  /** Per-page event limit handed to Soroban RPC. */
  syncPageSize: z.coerce.number().int().min(1).max(200).default(100),

  /** Shared secret used to HMAC responses; unset means responses are unsigned. */
  signingKey: signingKey.optional(),

  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/** Reads and validates configuration, throwing `ConfigError` with all issues at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    port: env['KEYGATE_PORT'],
    sorobanRpcUrl: env['KEYGATE_SOROBAN_RPC_URL'],
    coreContract: env['KEYGATE_CORE_CONTRACT'],
    policyContract: env['KEYGATE_POLICY_CONTRACT'],
    breakerContract: env['KEYGATE_BREAKER_CONTRACT'],
    startLedger: env['KEYGATE_START_LEDGER'],
    maxStalenessSeconds: env['KEYGATE_MAX_STALENESS_SECONDS'],
    syncIntervalMs: env['KEYGATE_SYNC_INTERVAL_MS'],
    syncPageSize: env['KEYGATE_SYNC_PAGE_SIZE'],
    signingKey: env['KEYGATE_SIGNING_KEY'],
    logLevel: env['KEYGATE_LOG_LEVEL'],
  });

  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}
