import { describe, expect, it } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';

import { ConfigError, loadConfig } from '../src/config.js';

const contract = (byte: number): string => StrKey.encodeContract(Buffer.alloc(32, byte));

const CONTRACT = contract(1);
const POLICY = contract(2);
const BREAKER = contract(3);

/** The minimal environment a deployment can boot with. */
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    KEYGATE_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    KEYGATE_CORE_CONTRACT: CONTRACT,
    KEYGATE_POLICY_CONTRACT: POLICY,
    KEYGATE_BREAKER_CONTRACT: BREAKER,
    ...overrides,
  };
}

describe('loadConfig defaults', () => {
  it('fills in the operational knobs an operator is unlikely to set', () => {
    const config = loadConfig(baseEnv());

    expect(config.port).toBe(8080);
    expect(config.maxStalenessSeconds).toBe(120);
    expect(config.syncIntervalMs).toBe(5_000);
    expect(config.syncPageSize).toBe(100);
    expect(config.logLevel).toBe('info');
    // Unsigned responses must be an explicit choice, not an accident of defaults.
    expect(config.signingKey).toBeUndefined();
    expect(config.startLedger).toBeUndefined();
  });

  it('coerces the numeric strings an environment always provides', () => {
    const config = loadConfig(
      baseEnv({
        KEYGATE_PORT: '9000',
        KEYGATE_MAX_STALENESS_SECONDS: '30',
        KEYGATE_START_LEDGER: '123',
      }),
    );

    expect(config).toMatchObject({ port: 9000, maxStalenessSeconds: 30, startLedger: 123 });
  });
});

describe('loadConfig rejection', () => {
  it('refuses a contract id that is not a contract id', () => {
    // An account (G…) or a typo would silently point the mirror at nothing.
    expect(() =>
      loadConfig(
        baseEnv({
          KEYGATE_CORE_CONTRACT: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ2345678901234567890123456789',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('reports every problem at once instead of one per restart', () => {
    let caught: unknown;
    try {
      loadConfig({ KEYGATE_PORT: '0', KEYGATE_LOG_LEVEL: 'verbose' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const issues = (caught as ConfigError).issues;
    // The missing required fields plus the two bad values above.
    expect(issues.some((issue) => issue.startsWith('sorobanRpcUrl:'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('coreContract:'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('port:'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('logLevel:'))).toBe(true);
    expect((caught as Error).message).toContain('invalid configuration');
  });

  it('refuses a short signing key, which would be brute-forceable', () => {
    expect(() => loadConfig(baseEnv({ KEYGATE_SIGNING_KEY: 'hunter2' }))).toThrow(ConfigError);
    expect(loadConfig(baseEnv({ KEYGATE_SIGNING_KEY: '0123456789abcdef' })).signingKey).toBe(
      '0123456789abcdef',
    );
  });

  it('refuses a page size the RPC would reject', () => {
    expect(() => loadConfig(baseEnv({ KEYGATE_SYNC_PAGE_SIZE: '5000' }))).toThrow(ConfigError);
  });

  it('refuses a nonsense rpc url rather than failing at first poll', () => {
    expect(() => loadConfig(baseEnv({ KEYGATE_SOROBAN_RPC_URL: 'soroban.stellar.org' }))).toThrow(
      ConfigError,
    );
  });
});

describe('loadConfig API tokens', () => {
  const TOKEN_A = 'a'.repeat(32);
  const TOKEN_B = 'b'.repeat(40);

  it('reads a comma-separated list of tokens', () => {
    const config = loadConfig(baseEnv({ KEYGATE_API_TOKENS: `${TOKEN_A},${TOKEN_B}` }));

    expect(config.apiTokens).toEqual([TOKEN_A, TOKEN_B]);
  });

  it('leaves the routes open when the variable is unset', () => {
    expect(loadConfig(baseEnv()).apiTokens).toBeUndefined();
  });

  it('refuses an empty entry rather than silently dropping it', () => {
    let caught: unknown;
    try {
      loadConfig(baseEnv({ KEYGATE_API_TOKENS: `${TOKEN_A},,${TOKEN_B}` }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).issues).toContain(
      'apiTokens.1: KEYGATE_API_TOKENS must not contain empty entries',
    );
  });

  it('refuses a token shorter than 32 characters', () => {
    let caught: unknown;
    try {
      loadConfig(baseEnv({ KEYGATE_API_TOKENS: `${TOKEN_A},hunter2` }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).issues).toContain(
      'apiTokens.1: KEYGATE_API_TOKENS entries must be at least 32 characters',
    );
  });
});
