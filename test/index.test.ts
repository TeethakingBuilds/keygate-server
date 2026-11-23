import { once } from 'node:events';
import { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';

import { main, type Running } from '../src/index.js';
import type { LedgerSource } from '../src/ledger/sync.js';

const HOLDER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    KEYGATE_SOROBAN_RPC_URL: 'https://rpc.invalid/',
    // Structurally valid strkeys, unassigned addresses — the same placeholders
    // the CI workflow boots against.
    KEYGATE_CORE_CONTRACT: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
    KEYGATE_POLICY_CONTRACT: 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ',
    KEYGATE_BREAKER_CONTRACT: 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3',
    KEYGATE_PORT: String(20_000 + Math.floor(Math.random() * 9_000)),
    KEYGATE_SYNC_INTERVAL_MS: '60000',
    KEYGATE_LOG_LEVEL: 'error',
    ...overrides,
  };
}

const emptySource: LedgerSource = { fetch: () => Promise.resolve([]) };

async function boot(overrides: Record<string, string> = {}): Promise<Running> {
  return main(env(overrides), { createSource: () => emptySource });
}

describe('Running.close', () => {
  it('shares one shutdown between repeated close calls', async () => {
    const running = await boot();
    const first = running.close();
    const second = running.close();
    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('lets an in-flight request finish instead of dropping it', async () => {
    const running = await boot({ KEYGATE_SHUTDOWN_TIMEOUT_MS: '2000' });
    const socket = new Socket();
    try {
      socket.connect(running.port, '127.0.0.1');
      await once(socket, 'connect');
      let received = '';
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
      });

      // A POST whose body arrives in two chunks: the request is in flight
      // while close() is called, and must still get its answer.
      const body = JSON.stringify({
        holder: HOLDER,
        resource: 'vault:main',
        action: 'withdraw',
      });
      const head =
        'POST /v1/decide HTTP/1.1\r\n' +
        'host: 127.0.0.1\r\n' +
        'content-type: application/json\r\n' +
        'connection: close\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n\r\n`;
      socket.write(head + body.slice(0, 10));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const closing = running.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.write(body.slice(10));

      // The answer arrives before the close resolves, well inside the deadline.
      const answered = await Promise.race([
        new Promise<boolean>((resolve) => {
          const check = (): void => {
            if (received.includes('HTTP/1.1 200')) {
              resolve(true);
            } else {
              setTimeout(check, 10);
            }
          };
          check();
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500)),
      ]);
      expect(answered).toBe(true);
      await closing;
    } finally {
      socket.destroy();
    }
  });

  it('force-closes a stalled request at the shutdown deadline', async () => {
    const running = await boot({ KEYGATE_SHUTDOWN_TIMEOUT_MS: '50' });
    const socket = new Socket();
    try {
      socket.connect(running.port, '127.0.0.1');
      await once(socket, 'connect');
      // A POST that never finishes its body: the server waits for it forever.
      socket.write(
        'POST /v1/decide HTTP/1.1\r\n' +
          'host: 127.0.0.1\r\n' +
          'content-type: application/json\r\n' +
          'content-length: 100\r\n\r\n{}',
      );
      const closed = new Promise<void>((resolve) => {
        socket.on('close', () => resolve());
      });
      const started = Date.now();
      await running.close();
      // Bounded by the 50ms deadline, with generous room for a loaded machine.
      expect(Date.now() - started).toBeLessThan(2_000);
      await closed;
    } finally {
      socket.destroy();
    }
  });
});
