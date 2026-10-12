import { encodeAbiParameters, encodeEventTopics, type AbiEvent } from 'viem'

import { emptyLedger } from '@/lib/exitQueue/ledger'
import type { RawLog, VenueKey, VenueLedger } from '@/lib/exitQueue/types'
import { venueByKey, type VenueDef } from '@/lib/exitQueue/venues'

// Shared builders for the exit-queue tests (not a test file: vitest only collects *.test.ts).

export const T0 = 1_790_000_000
export const tsOf = (block: number) => T0 + (block - 1_000) * 12
export const hex32 = (n: number | bigint) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
export const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

export function mkLog(
  address: string,
  event: AbiEvent,
  args: Record<string, unknown>,
  o: { block: number; logIndex?: number; tx?: string; ts?: number },
): RawLog {
  const topics = encodeEventTopics({
    abi: [event],
    eventName: event.name,
    args,
  } as never) as string[]
  const nonIndexed = event.inputs.filter((i) => !i.indexed)
  const data = nonIndexed.length
    ? encodeAbiParameters(
        nonIndexed,
        nonIndexed.map((i) => args[i.name!]),
      )
    : '0x'
  const logIndex = o.logIndex ?? 0
  return {
    address,
    topics,
    data,
    blockNumber: o.block,
    logIndex,
    transactionHash: o.tx ?? hex32(o.block * 1_000 + logIndex),
    blockTimestamp: o.ts ?? tsOf(o.block),
  }
}

export const def = (key: VenueKey): VenueDef => venueByKey(key)!

export function ledgerWithCoverage(
  key: VenueKey,
  fromBlock: number,
  throughBlock: number,
): VenueLedger {
  const l = emptyLedger(key)
  l.coverage = { fromBlock, fromTs: tsOf(fromBlock), throughBlock, throughTs: tsOf(throughBlock) }
  return l
}
