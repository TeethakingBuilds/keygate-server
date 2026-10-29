/**
 * The I/O boundary: Soroban RPC polling plus XDR lifting.
 *
 * This is the only module in the server that imports `@stellar/stellar-sdk` for
 * reads, and it is deliberately thin. Everything above it speaks `ScNode` and
 * `LedgerEvent`, so an operator who prefers a private indexer or a different RPC
 * provider implements `LedgerSource` without touching the domain.
 *
 * Soroban RPC rather than Horizon because contract events are a ledger-level
 * concept: `getEvents` is the only endpoint that hands back `ScVal`s already
 * parsed, with the ledger they were written in.
 *
 * Covered by `test/soroban.test.ts` for the mapping logic. The live call itself
 * needs an RPC endpoint, so `test/rpc.integration.test.ts` exercises it against
 * testnet and is skipped unless `KEYGATE_IT_RPC_URL` is set.
 */
import { StrKey, rpc, type xdr } from '@stellar/stellar-sdk';

import { decodeEvent, type ContractRole, type RawEvent, type ScNode } from './decoder.js';
import type { EventRecord, LedgerSource } from './sync.js';
import type { LedgerEvent, Timestamp } from '../domain/types.js';

export interface RpcSourceOptions {
  readonly rpcUrl: string;
  readonly contracts: {
    readonly core: string;
    readonly policy: string;
    readonly breaker: string;
  };
  /**
   * Ledger to begin from on a cold start. The only way to rebuild a mirror of
   * grants issued before this service existed is to replay the window Soroban
   * RPC retains (typically ~17k ledgers), so a deployment that must survive a
   * long outage should checkpoint its cursor externally.
   */
  readonly startLedger?: number;
  readonly limit?: number;
  /** Only for a local RPC node without TLS. */
  readonly allowHttp?: boolean;
}

const EVENT_PAGE_LIMIT = 100;

function roleOf(contractId: string, contracts: RpcSourceOptions['contracts']): ContractRole | null {
  if (contractId === contracts.core) {
    return 'core';
  }
  if (contractId === contracts.policy) {
    return 'policy';
  }
  if (contractId === contracts.breaker) {
    return 'breaker';
  }
  return null;
}

const TWO_POW_64 = 1n << 64n;

/**
 * `UInt128`/`Int128` arrive as a struct of two 64-bit halves, and js-xdr wraps
 * each half rather than handing back a bigint. The halves are `hi: i64|u64` and
 * `lo: u64`, so `hi * 2^64 + lo` is exact for both signed and unsigned variants
 * — verified against real `ScVal`s in `test/soroban.ts`.
 */
function combine128(raw: unknown): bigint {
  const halves = raw as { hi(): unknown; lo(): unknown };
  return BigInt(String(halves.hi())) * TWO_POW_64 + BigInt(String(halves.lo()));
}

/**
 * Lifts a parsed `ScVal` into the small structural view the decoder consumes.
 *
 * js-xdr unions expose `switch()`/`value()`, whose return types are `any`, so
 * every case here converts through an explicit runtime check instead of trusting
 * the generated typings.
 */
export function scValToNode(scval: xdr.ScVal): ScNode {
  const name = scval.switch().name as string;
  const raw: unknown = scval.value();

  switch (name) {
    case 'scvVoid':
      return { kind: 'void' };
    case 'scvBool':
      return { kind: 'bool', value: Boolean(raw) };
    case 'scvU32':
    case 'scvI32':
      return { kind: 'u32', value: Number(raw) };
    case 'scvU64':
      return { kind: 'u64', value: BigInt(String(raw)) };
    case 'scvI64':
      return { kind: 'i128', value: BigInt(String(raw)) };
    case 'scvU128':
    case 'scvI128':
      return { kind: 'i128', value: combine128(raw) };
    case 'scvSymbol':
    case 'scvSymbolSmall':
      return { kind: 'symbol', value: String(raw) };
    case 'scvString':
      return { kind: 'string', value: decodeBytes(raw) };
    case 'scvAddress':
      return { kind: 'address', value: addressToStrkey(raw) };
    case 'scvVec':
      return { kind: 'vec', value: (raw as xdr.ScVal[]).map(scValToNode) };
    case 'scvMap':
      return {
        kind: 'map',
        // js-xdr hands back `ScMapEntry` structs, whose fields are accessor
        // methods rather than plain properties.
        value: (raw as { key(): xdr.ScVal; val(): xdr.ScVal }[]).map(
          (entry) => [scValToNode(entry.key()), scValToNode(entry.val())] as const,
        ),
      };
    default:
      // Ledger keys, errors and scalars keygate does not use keep their
      // discriminant, so a mapping gap shows up in a log rather than silently
      // becoming a string.
      return { kind: 'other', tag: name };
  }
}

function decodeBytes(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return new TextDecoder().decode(raw);
  }
  throw new TypeError(`expected bytes for a string value, received ${typeof raw}`);
}

function addressToStrkey(raw: unknown): string {
  const scAddress = raw as { switch(): { name: string }; value(): unknown };
  const kind = scAddress.switch().name;
  const inner = scAddress.value();

  if (kind === 'scAddressTypeContract') {
    // A contract id is the 32-byte hash directly, with no key-type union under
    // it, unlike an account.
    return StrKey.encodeContract(asBytes(inner, kind));
  }
  if (kind === 'scAddressTypeAccount') {
    const publicKey = inner as { switch(): { name: string }; value(): unknown };
    const type = publicKey.switch().name;
    if (type !== 'publicKeyTypeEd25519') {
      throw new TypeError(`unsupported account key type ${type}`);
    }
    return StrKey.encodeEd25519PublicKey(asBytes(publicKey.value(), type));
  }
  throw new TypeError(`unsupported ScAddress type ${kind}`);
}

/** StrKey encoders take a Buffer, and js-xdr hands back a plain Uint8Array. */
function asBytes(value: unknown, context: string): Buffer {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`expected a 32-byte hash from ${context}`);
  }
  return Buffer.from(value);
}

/** ISO-8601 ledger close time to the epoch seconds keygate contracts compare against. */
export function toTimestamp(iso: string): Timestamp {
  const value = Math.floor(Date.parse(iso) / 1000);
  if (Number.isNaN(value)) {
    throw new TypeError(`unreadable ledger time ${iso}`);
  }
  return value;
}

export class RpcSource implements LedgerSource {
  private readonly server: rpc.Server;
  private readonly contracts: RpcSourceOptions['contracts'];
  private readonly limit: number;
  private readonly startLedger?: number;
  /**
   * Soroban RPC rejects `startLedger` and `cursor` together, so the first page
   * of a cold start is the only one that names a ledger.
   */
  private coldStart = true;

  constructor(options: RpcSourceOptions) {
    this.server = new rpc.Server(options.rpcUrl, { allowHttp: options.allowHttp ?? false });
    this.contracts = options.contracts;
    this.limit = options.limit ?? EVENT_PAGE_LIMIT;
    if (options.startLedger !== undefined) {
      this.startLedger = options.startLedger;
    }
  }

  async fetch(cursor: string, signal?: AbortSignal): Promise<EventRecord[]> {
    // `getEvents` in this SDK version cannot carry an AbortSignal, so the signal
    // is honoured at this boundary instead: a stopped sync will still let the
    // request it already sent finish, and throws away the answer. Throwing rather
    // than returning an empty page matters, because an empty page would be
    // recorded as a successful observation of a quiet chain.
    signal?.throwIfAborted();

    const filters: rpc.Api.EventFilter[] = [
      {
        type: 'contract',
        contractIds: [this.contracts.core, this.contracts.policy, this.contracts.breaker],
      },
    ];

    const response = await this.server.getEvents({
      filters,
      limit: this.limit,
      ...(cursor === '' && this.coldStart
        ? { startLedger: this.startLedger ?? 0 }
        : { cursor: cursor === '' ? '0' : cursor }),
    });

    this.coldStart = false;
    const records: EventRecord[] = [];
    for (const event of response.events) {
      const record = this.toRecord(event);
      if (record !== null) {
        records.push(record);
      }
    }
    return records;
  }

  /**
   * Converts one event. Returns null for anything this deployment does not
   * administer, for topics the decoder does not recognise, and — importantly —
   * for events emitted by a transaction that ultimately failed, whose effects
   * never landed.
   */
  private toRecord(event: rpc.Api.EventResponse): EventRecord | null {
    // The SDK parses a contract event's id into a `Contract` instance; the strkey
    // is what the rest of the server compares against.
    const contractId = event.contractId?.contractId();
    if (contractId === undefined) {
      return null;
    }
    if (!event.inSuccessfulContractCall) {
      return null;
    }
    const role = roleOf(contractId, this.contracts);
    if (role === null) {
      return null;
    }

    const decoded: LedgerEvent | null = decodeEvent(
      role,
      {
        topics: event.topic.map(scValToNode),
        data: scValToNode(event.value),
      } satisfies RawEvent,
      toTimestamp(event.ledgerClosedAt),
    );
    if (decoded === null) {
      return null;
    }

    return {
      event: decoded,
      ledgerClosedAt: toTimestamp(event.ledgerClosedAt),
      contractId,
      cursor: event.pagingToken,
    };
  }
}
