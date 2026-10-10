import { getAddress, isAddress, keccak256, type PublicClient } from 'viem'

import { decodeCandidateLiquidationAlertLog, type RawLiquidationLog } from './liquidationEvents'
import { normalizeFinalizedChainLog, type FinalizedChainLog } from './outbox'

// This boundary is intentionally offline and provider-agnostic. The caller must
// supply a trusted finalized-chain reader and an independently reviewed runtime
// hash for the deployed emitter. A proxy hash alone does not attest its logic.
export type LiquidationSourceReads = {
  chainId: () => Promise<number>
  finalizedBlockNumber: () => Promise<bigint>
  block: (number: bigint) => Promise<{ hash: string; timestamp: bigint } | null>
  receipt: (hash: string) => Promise<{
    status: 'success' | 'reverted'
    blockNumber: bigint
    blockHash: string
    logs: RawLiquidationLog[]
  } | null>
  code: (address: string, blockNumber: bigint) => Promise<string | null | undefined>
}

/** Read-only viem adapter; caller controls RPC transport and its trust policy. */
export function viemLiquidationSourceReads(client: PublicClient): LiquidationSourceReads {
  return {
    chainId: () => client.getChainId(),
    finalizedBlockNumber: async () => {
      const block = await client.getBlock({ blockTag: 'finalized' })
      if (block.number === null) throw new Error('finalized height unavailable')
      return block.number
    },
    block: async (number) => {
      const block = await client.getBlock({ blockNumber: number })
      return { hash: block.hash, timestamp: block.timestamp }
    },
    receipt: async (hash) => {
      const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` })
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        logs: receipt.logs.map((log) => ({ ...log, chainId: 1 })),
      }
    },
    code: (address, blockNumber) =>
      client.getCode({ address: address as `0x${string}`, blockNumber }),
  }
}

const HASH = /^0x[0-9a-fA-F]{64}$/
const CODE = /^0x(?:[0-9a-fA-F]{2})+$/
const POSITION_ID = /^[1-9][0-9]*$/

export type LiquidationSourceClaim = FinalizedChainLog & { sourceAttestation?: unknown }
export type VerifiedLiquidationNotice = FinalizedChainLog & {
  positionId: string
  startTime: number | null
}

/** Shared receipt proof. Only an already-stored delivery claim requires a stored attestation. */
async function verifyLiquidationReceipt(
  claimed: LiquidationSourceClaim,
  expectedEmitter: string,
  expectedRuntimeCodeHash: string,
  reads: LiquidationSourceReads,
  requireStoredAttestation: boolean,
): Promise<VerifiedLiquidationNotice> {
  if (!isAddress(expectedEmitter) || !HASH.test(expectedRuntimeCodeHash))
    throw new Error('unverified liquidation deployment configuration')
  const event = normalizeFinalizedChainLog(claimed)
  if (!event || (event.kind !== 'delay_started' && event.kind !== 'position_kept'))
    throw new Error('invalid liquidation source claim')
  if (event.emitter !== getAddress(expectedEmitter).toLowerCase())
    throw new Error('liquidation emitter mismatch')

  const number = BigInt(event.blockNumber)
  if ((await reads.chainId()) !== 1 || (await reads.finalizedBlockNumber()) < number)
    throw new Error('liquidation source is not finalized on chain 1')
  const block = await reads.block(number)
  const receipt = await reads.receipt(event.transactionHash)
  if (
    !block ||
    !HASH.test(block.hash) ||
    block.hash.toLowerCase() !== event.blockHash ||
    block.timestamp < 0n ||
    block.timestamp > 8_640_000_000_000n ||
    new Date(Number(block.timestamp) * 1000).toISOString() !== event.occurredAt ||
    !receipt ||
    receipt.status !== 'success' ||
    receipt.blockNumber !== number ||
    receipt.blockHash.toLowerCase() !== event.blockHash ||
    !Array.isArray(receipt.logs)
  )
    throw new Error('liquidation block or receipt mismatch')

  const code = await reads.code(event.emitter, number)
  if (
    !code ||
    !CODE.test(code) ||
    keccak256(code as `0x${string}`).toLowerCase() !== expectedRuntimeCodeHash.toLowerCase()
  )
    throw new Error('liquidation runtime identity mismatch')

  const matches = receipt.logs.filter((log) => log.logIndex === event.logIndex)
  if (matches.length !== 1) throw new Error('liquidation log index missing or duplicated')
  const candidate = decodeCandidateLiquidationAlertLog(
    { ...matches[0], chainId: 1 },
    expectedEmitter,
  )
  if (
    !candidate ||
    candidate.kind !== event.kind ||
    candidate.owner !== event.subjectAddress ||
    candidate.transactionHash !== event.transactionHash ||
    candidate.blockNumber !== event.blockNumber ||
    candidate.blockHash !== event.blockHash
  )
    throw new Error('liquidation log provenance mismatch')
  const positionId = candidate.positionId.toString()
  if (
    (candidate.kind === 'delay_started' &&
      (candidate.startTime === null || BigInt(candidate.startTime) !== block.timestamp)) ||
    (candidate.kind === 'position_kept' && candidate.startTime !== null)
  )
    throw new Error('liquidation receipt timing mismatch')
  if (requireStoredAttestation) {
    const attestation = claimed.sourceAttestation
    if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation))
      throw new Error('liquidation source attestation unavailable')
    const proof = attestation as Record<string, unknown>
    if (
      proof.proofVersion !== 1 ||
      typeof proof.runtimeCodeHash !== 'string' ||
      proof.runtimeCodeHash.toLowerCase() !== expectedRuntimeCodeHash.toLowerCase() ||
      typeof proof.positionId !== 'string' ||
      !POSITION_ID.test(proof.positionId) ||
      proof.positionId !== positionId ||
      proof.startTime !== candidate.startTime
    )
      throw new Error('liquidation receipt and stored attestation mismatch')
  }
  return {
    chainId: event.chainId,
    emitter: event.emitter,
    transactionHash: event.transactionHash,
    logIndex: event.logIndex,
    blockNumber: event.blockNumber,
    blockHash: event.blockHash,
    occurredAt: event.occurredAt,
    firstObservedAt: event.firstObservedAt,
    kind: event.kind,
    subjectAddress: event.subjectAddress,
    positionId,
    startTime: candidate.startTime,
  }
}

/** Ingestion-only boundary: no DB attestation exists until after this proof succeeds. */
export function verifyUnstoredFinalizedLiquidationSource(
  observed: FinalizedChainLog,
  expectedEmitter: string,
  expectedRuntimeCodeHash: string,
  reads: LiquidationSourceReads,
): Promise<VerifiedLiquidationNotice> {
  if ('sourceAttestation' in observed)
    throw new Error('ingest observation must not carry a stored attestation')
  return verifyLiquidationReceipt(observed, expectedEmitter, expectedRuntimeCodeHash, reads, false)
}

/** Send-loader boundary: the stored attestation must match exact receipt-derived fields. */
export function verifyFinalizedLiquidationSource(
  claimed: LiquidationSourceClaim,
  expectedEmitter: string,
  expectedRuntimeCodeHash: string,
  reads: LiquidationSourceReads,
): Promise<VerifiedLiquidationNotice> {
  return verifyLiquidationReceipt(claimed, expectedEmitter, expectedRuntimeCodeHash, reads, true)
}

/** Adapter for TelegramBatchPorts.loadAttestedEvent; missing DB rows are not silently suppressed. */
export function makeVerifiedLiquidationEventLoader(
  loadClaim: (eventId: string) => Promise<LiquidationSourceClaim | null>,
  expectedEmitter: string,
  expectedRuntimeCodeHash: string,
  reads: LiquidationSourceReads,
): (eventId: string) => Promise<VerifiedLiquidationNotice> {
  return async (eventId) => {
    const claim = await loadClaim(eventId)
    if (!claim) throw new Error('liquidation source claim unavailable')
    return verifyFinalizedLiquidationSource(claim, expectedEmitter, expectedRuntimeCodeHash, reads)
  }
}
