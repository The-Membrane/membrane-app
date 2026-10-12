/**
 * Raw log → decoded event, keyed by the emitter's verified kind. Pure.
 *
 * The collector verifies every emitter against its factory (isMetaMorpho / isVaultV2 /
 * Euler Earn isVault) or a fixed address (Aave PoolConfigurators, Morpho Blue) BEFORE a
 * log reaches here, because topic0 alone is not proof of origin: any contract can emit
 * SetCap(address,bytes32,uint256).
 */

import { decodeLogArgs, eventFor, type AbiValue, type EmitterKind, type RawLog } from './abi'

export interface DecodedEvent {
  kind: EmitterKind
  name: string
  emitter: string
  args: Record<string, AbiValue>
  block: number
  logIndex: number
  tx: string
  ts: number
}

export type DecodeResult =
  | { ok: true; event: DecodedEvent }
  | { ok: false; reason: 'unknown-topic' | 'malformed'; detail?: string }

export function decodeLog(kind: EmitterKind, log: RawLog): DecodeResult {
  const def = eventFor(kind, log.topics[0] ?? '')
  if (!def) return { ok: false, reason: 'unknown-topic' }
  try {
    return {
      ok: true,
      event: {
        kind,
        name: def.name,
        emitter: log.address.toLowerCase(),
        args: decodeLogArgs(def, log),
        block: log.blockNumber,
        logIndex: log.logIndex,
        tx: log.transactionHash.toLowerCase(),
        ts: log.timestamp,
      },
    }
  } catch (e) {
    return { ok: false, reason: 'malformed', detail: String(e).slice(0, 120) }
  }
}

/** Chain order: block, then log index. */
export const byChainOrder = (
  a: { block: number; logIndex: number },
  b: { block: number; logIndex: number },
): number => a.block - b.block || a.logIndex - b.logIndex

// Typed accessors — decoded args are AbiValue; these narrow with a runtime check so a
// catalog/decoder mismatch fails loudly instead of rendering "undefined".
export const argStr = (e: DecodedEvent, k: string): string => {
  const v = e.args[k]
  if (typeof v !== 'string') throw new Error(`${e.name}.${k}: expected string, got ${typeof v}`)
  return v
}
export const argBig = (e: DecodedEvent, k: string): bigint => {
  const v = e.args[k]
  if (typeof v !== 'bigint') throw new Error(`${e.name}.${k}: expected bigint, got ${typeof v}`)
  return v
}
export const argBool = (e: DecodedEvent, k: string): boolean => {
  const v = e.args[k]
  if (typeof v !== 'boolean') throw new Error(`${e.name}.${k}: expected bool, got ${typeof v}`)
  return v
}
export const argList = (e: DecodedEvent, k: string): string[] => {
  const v = e.args[k]
  if (!Array.isArray(v)) throw new Error(`${e.name}.${k}: expected array`)
  return v.map((x) => String(x))
}
