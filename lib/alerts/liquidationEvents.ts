import { getAddress, isAddress, toEventSelector } from 'viem'

// Decoding a receipt is not proof of the emitter's deployment, canonicality,
// finality, or owner attribution at a later block. An indexer must establish
// those facts independently before constructing a FinalizedChainLog.
export type CandidateLiquidationAlertLog = {
  status: 'candidate_unfinalized'
  chainId: 1
  kind: 'delay_started' | 'position_kept'
  emitter: string
  owner: string
  positionId: bigint
  startTime: number | null
  transactionHash: string
  logIndex: number
  blockNumber: number
  blockHash: string
}

export type RawLiquidationLog = {
  chainId: unknown
  address: unknown
  topics: unknown
  data: unknown
  transactionHash: unknown
  logIndex: unknown
  blockNumber: unknown
  blockHash: unknown
  removed?: unknown
}

const TIMER_TOPIC = toEventSelector('LiquidationTimerStarted(uint256,address,uint64)')
const KEPT_TOPIC = toEventSelector('LiquidationSavedByDelay(uint256,address)')
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS_TOPIC = /^0x0{24}[0-9a-fA-F]{40}$/
const EMPTY_DATA = '0x'
const MAX_DATE_SECONDS = BigInt(Math.floor(8_640_000_000_000_000 / 1000))

function word(value: unknown): bigint | null {
  return typeof value === 'string' && HASH.test(value) ? BigInt(value) : null
}

function safeIndex(value: unknown, positive = false): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0)
  )
}

function safeBlockNumber(value: unknown): number | null {
  if (safeIndex(value, true)) return value
  if (typeof value === 'bigint' && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER))
    return Number(value)
  return null
}

/** Parse only two exact Solidity event encodings from an explicitly expected chain-1 emitter. */
export function decodeCandidateLiquidationAlertLog(
  raw: RawLiquidationLog,
  expectedEmitter: string,
): CandidateLiquidationAlertLog | null {
  const blockNumber = raw ? safeBlockNumber(raw.blockNumber) : null
  if (
    !raw ||
    raw.chainId !== 1 ||
    (raw.removed !== undefined && raw.removed !== false) ||
    !isAddress(expectedEmitter) ||
    typeof raw.address !== 'string' ||
    !isAddress(raw.address) ||
    getAddress(raw.address).toLowerCase() !== getAddress(expectedEmitter).toLowerCase() ||
    !Array.isArray(raw.topics) ||
    raw.topics.length !== 3 ||
    typeof raw.topics[0] !== 'string' ||
    typeof raw.topics[1] !== 'string' ||
    typeof raw.topics[2] !== 'string' ||
    typeof raw.transactionHash !== 'string' ||
    !HASH.test(raw.transactionHash) ||
    typeof raw.blockHash !== 'string' ||
    !HASH.test(raw.blockHash) ||
    !safeIndex(raw.logIndex) ||
    blockNumber === null
  )
    return null

  const eventTopic = raw.topics[0].toLowerCase()
  if (eventTopic !== TIMER_TOPIC && eventTopic !== KEPT_TOPIC) return null
  const positionId = word(raw.topics[1])
  if (positionId === null || positionId === 0n || !ADDRESS_TOPIC.test(raw.topics[2])) return null
  const owner = getAddress(`0x${raw.topics[2].slice(26)}`).toLowerCase()
  if (owner === '0x0000000000000000000000000000000000000000') return null

  let startTime: number | null = null
  if (eventTopic === TIMER_TOPIC) {
    const timestamp = word(raw.data)
    // uint64 must be canonically ABI-padded; zero and unrenderable dates do
    // not represent a usable countdown start.
    if (timestamp === null || timestamp === 0n || timestamp > MAX_DATE_SECONDS) return null
    startTime = Number(timestamp)
  } else if (raw.data !== EMPTY_DATA) return null

  return {
    status: 'candidate_unfinalized',
    chainId: 1,
    kind: eventTopic === TIMER_TOPIC ? 'delay_started' : 'position_kept',
    emitter: getAddress(raw.address).toLowerCase(),
    owner,
    positionId,
    startTime,
    transactionHash: raw.transactionHash.toLowerCase(),
    logIndex: raw.logIndex,
    blockNumber,
    blockHash: raw.blockHash.toLowerCase(),
  }
}
