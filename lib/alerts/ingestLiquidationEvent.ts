import { decodeCandidateLiquidationAlertLog, type RawLiquidationLog } from './liquidationEvents'
import { chainLogIdentity, normalizeFinalizedChainLog, type FinalizedChainLog } from './outbox'
import {
  verifyUnstoredFinalizedLiquidationSource,
  type LiquidationSourceReads,
} from './verifyLiquidationSource'

export type VerifiedLiquidationIngestEvent = FinalizedChainLog & {
  eventId: string
  positionId: bigint
  startTime: number | null
  channel: 'telegram'
  sourceAttestation: {
    proofVersion: 1
    runtimeCodeHash: string
    positionId: string
    startTime: number | null
  }
}

export type LiquidationIngestResult =
  | { status: 'queued'; eventId: string }
  | { status: 'duplicate'; eventId: string }
  | { status: 'no_pre_event_consent'; eventId: string }
  | { status: 'conflicting_replay'; eventId: string }

/**
 * This is a required transactional port, not a persistence implementation.
 * In ONE atomic database function/transaction, with a row-level consent lock,
 * the adapter must compare the complete source record under the unique
 * chain/emitter/tx/log key, reject conflicting replay, and preserve
 * firstObservedAt from the FIRST insert. Later local observation
 * times are not source conflicts and must never replace that first timestamp.
 * Insert an outbox row only for a CURRENT wallet-
 * signed preference and confirmed Telegram chat that both predate the event.
 * No historical backfill on later consent. An existing identical event/outbox
 * returns duplicate. Concurrency still needs disposable-PostgreSQL tests.
 * The caller must not infer exactly-once external delivery:
 * Telegram has no send idempotency key and a send can become uncertain.
 */
export type LiquidationAtomicIngestPort = {
  persistAndEnqueue: (event: VerifiedLiquidationIngestEvent) => Promise<LiquidationIngestResult>
}

/** Inert proof + handoff: no database, migration, worker, or network is created here. */
export async function ingestFinalizedLiquidationEvent(input: {
  observedLog: RawLiquidationLog
  expectedEmitter: string
  expectedRuntimeCodeHash: string
  reads: LiquidationSourceReads
  atomic: LiquidationAtomicIngestPort
}): Promise<LiquidationIngestResult> {
  // Capture before any RPC awaits. This is local observation time, not
  // chain-attested lead time; the persistence port keeps the first value.
  const observedAt = new Date()
  if (!Number.isFinite(observedAt.getTime())) throw new Error('invalid local observation time')
  const firstObservedAt = observedAt.toISOString()
  const observed = decodeCandidateLiquidationAlertLog(input.observedLog, input.expectedEmitter)
  if (!observed) throw new Error('invalid observed liquidation log')

  const block = await input.reads.block(BigInt(observed.blockNumber))
  if (!block || block.timestamp < 0n || block.timestamp > 8_640_000_000_000n)
    throw new Error('invalid liquidation block time')

  const proposed = normalizeFinalizedChainLog({
    chainId: 1,
    emitter: observed.emitter,
    transactionHash: observed.transactionHash,
    logIndex: observed.logIndex,
    blockNumber: observed.blockNumber,
    blockHash: observed.blockHash,
    occurredAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    firstObservedAt,
    kind: observed.kind,
    subjectAddress: observed.owner,
  })
  if (!proposed) throw new Error('invalid liquidation observation time')

  // Capture the exact receipt used by the verifier; never independently
  // re-query a possibly changed provider view when deriving the recipient.
  let verifiedReceipt: Awaited<ReturnType<LiquidationSourceReads['receipt']>> = null
  const reads: LiquidationSourceReads = {
    ...input.reads,
    block: async (number) =>
      number === BigInt(observed.blockNumber) ? block : input.reads.block(number),
    receipt: async (hash) => {
      verifiedReceipt = await input.reads.receipt(hash)
      return verifiedReceipt
    },
  }
  const proved = await verifyUnstoredFinalizedLiquidationSource(
    proposed,
    input.expectedEmitter,
    input.expectedRuntimeCodeHash,
    reads,
  )
  const receipt = verifiedReceipt as Awaited<ReturnType<LiquidationSourceReads['receipt']>>
  if (!receipt) throw new Error('verified liquidation receipt unavailable')
  const matching = receipt.logs.filter((log) => log.logIndex === proved.logIndex)
  if (matching.length !== 1) throw new Error('verified liquidation log unavailable')
  const decoded = decodeCandidateLiquidationAlertLog(
    { ...matching[0], chainId: 1 },
    input.expectedEmitter,
  )
  if (!decoded || decoded.kind !== proved.kind || decoded.owner !== proved.subjectAddress)
    throw new Error('verified liquidation event changed')

  const event: FinalizedChainLog = {
    ...proved,
    kind: decoded.kind,
    subjectAddress: decoded.owner,
    emitter: decoded.emitter,
    transactionHash: decoded.transactionHash,
    logIndex: decoded.logIndex,
    blockNumber: decoded.blockNumber,
    blockHash: decoded.blockHash,
  }
  const eventId = chainLogIdentity(event)
  if (!eventId) throw new Error('invalid verified liquidation identity')
  const result = await input.atomic.persistAndEnqueue({
    ...event,
    eventId,
    positionId: decoded.positionId,
    startTime: decoded.startTime,
    channel: 'telegram',
    sourceAttestation: {
      proofVersion: 1,
      runtimeCodeHash: input.expectedRuntimeCodeHash.toLowerCase(),
      positionId: decoded.positionId.toString(),
      startTime: decoded.startTime,
    },
  })
  if (result.eventId !== eventId) throw new Error('atomic liquidation result identity mismatch')
  return result
}
