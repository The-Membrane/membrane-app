import { describe, expect, it } from 'vitest'
import { padHex, toEventSelector, toHex } from 'viem'

import {
  decodeCandidateLiquidationAlertLog,
  type RawLiquidationLog,
} from '@/lib/alerts/liquidationEvents'

const EMITTER = '0x2222222222222222222222222222222222222222'
const OWNER = '0x1111111111111111111111111111111111111111'
const TIMER = toEventSelector('LiquidationTimerStarted(uint256,address,uint64)')
const KEPT = toEventSelector('LiquidationSavedByDelay(uint256,address)')
const POSITION = toHex(41n, { size: 32 })
const OWNER_TOPIC = padHex(OWNER, { size: 32 })
const START = 1_790_000_000

const timerLog: RawLiquidationLog = {
  chainId: 1,
  address: EMITTER,
  topics: [TIMER, POSITION, OWNER_TOPIC],
  data: toHex(START, { size: 32 }),
  transactionHash: `0x${'ab'.repeat(32)}`,
  logIndex: 2,
  blockNumber: 26_000_000,
  blockHash: `0x${'cd'.repeat(32)}`,
}

describe('candidate LiquidationEngine alert decoder', () => {
  it('decodes the exact timer-start event without claiming deployment or finality', () => {
    const result = decodeCandidateLiquidationAlertLog(timerLog, EMITTER)
    expect(result).toEqual({
      status: 'candidate_unfinalized',
      chainId: 1,
      kind: 'delay_started',
      emitter: EMITTER,
      owner: OWNER,
      positionId: 41n,
      startTime: START,
      transactionHash: timerLog.transactionHash,
      logIndex: 2,
      blockNumber: 26_000_000,
      blockHash: timerLog.blockHash,
    })
    expect(result).not.toHaveProperty('occurredAt')
    expect(result).not.toHaveProperty('firstObservedAt')
    expect(result).not.toHaveProperty('subjectAddress')
    expect(result).not.toHaveProperty('finalized')
    expect(
      decodeCandidateLiquidationAlertLog(
        { ...timerLog, finalized: true, subjectAddress: OWNER } as RawLiquidationLog,
        EMITTER,
      ),
    ).toEqual(result)
  })

  it('decodes saved-by-delay with empty nonindexed data only', () => {
    expect(
      decodeCandidateLiquidationAlertLog(
        { ...timerLog, topics: [KEPT, POSITION, OWNER_TOPIC], data: '0x' },
        EMITTER,
      ),
    ).toMatchObject({ kind: 'position_kept', owner: OWNER, positionId: 41n, startTime: null })
  })

  it('accepts viem-shaped bigint block numbers only after trusted chain ID augmentation', () => {
    const viemLog = {
      address: EMITTER,
      topics: [TIMER, POSITION, OWNER_TOPIC],
      data: timerLog.data,
      transactionHash: timerLog.transactionHash,
      logIndex: 2,
      blockNumber: 26_000_000n,
      blockHash: timerLog.blockHash,
      removed: false,
      transactionIndex: 3,
    }
    expect(
      decodeCandidateLiquidationAlertLog({ ...viemLog, chainId: undefined }, EMITTER),
    ).toBeNull()
    expect(decodeCandidateLiquidationAlertLog({ ...viemLog, chainId: 1 }, EMITTER)).toMatchObject({
      status: 'candidate_unfinalized',
      blockNumber: 26_000_000,
    })
  })

  it('rejects wrong chain/emitter/topic and changed topic cardinality', () => {
    const invalid: RawLiquidationLog[] = [
      { ...timerLog, chainId: 31337 },
      { ...timerLog, removed: true },
      { ...timerLog, removed: 'false' },
      { ...timerLog, address: OWNER },
      { ...timerLog, topics: [`0x${'ff'.repeat(32)}`, POSITION, OWNER_TOPIC] },
      { ...timerLog, topics: [TIMER, POSITION] },
      { ...timerLog, topics: [TIMER, POSITION, OWNER_TOPIC, POSITION] },
      { ...timerLog, topics: 'not topics' },
    ]
    for (const raw of invalid) expect(decodeCandidateLiquidationAlertLog(raw, EMITTER)).toBeNull()
    expect(decodeCandidateLiquidationAlertLog(timerLog, OWNER)).toBeNull()
    expect(decodeCandidateLiquidationAlertLog(timerLog, 'not an address')).toBeNull()
  })

  it('rejects noncanonical owner and data, zero position/owner, and impossible start times', () => {
    const invalid: RawLiquidationLog[] = [
      { ...timerLog, topics: [TIMER, POSITION, OWNER] }, // not 32-byte indexed topic
      { ...timerLog, topics: [TIMER, POSITION, `0x${'ff'.repeat(12)}${OWNER.slice(2)}`] },
      { ...timerLog, topics: [TIMER, POSITION, toHex(0n, { size: 32 })] },
      { ...timerLog, topics: [TIMER, toHex(0n, { size: 32 }), OWNER_TOPIC] },
      { ...timerLog, data: '0x' },
      { ...timerLog, data: toHex(1n << 64n, { size: 32 }) },
      { ...timerLog, data: toHex(0n, { size: 32 }) },
      { ...timerLog, data: `${timerLog.data}00` },
      { ...timerLog, topics: [KEPT, POSITION, OWNER_TOPIC], data: timerLog.data },
    ]
    for (const raw of invalid) expect(decodeCandidateLiquidationAlertLog(raw, EMITTER)).toBeNull()
  })

  it('rejects malformed metadata before making a candidate', () => {
    const invalid: RawLiquidationLog[] = [
      { ...timerLog, transactionHash: '0x12' },
      { ...timerLog, transactionHash: {} },
      { ...timerLog, blockHash: '0x12' },
      { ...timerLog, logIndex: -1 },
      { ...timerLog, logIndex: 1.1 },
      { ...timerLog, blockNumber: 0 },
      { ...timerLog, blockNumber: 0n },
      { ...timerLog, blockNumber: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      { ...timerLog, blockNumber: Number.MAX_SAFE_INTEGER + 1 },
      { ...timerLog, address: null },
    ]
    for (const raw of invalid) expect(decodeCandidateLiquidationAlertLog(raw, EMITTER)).toBeNull()
  })
})
