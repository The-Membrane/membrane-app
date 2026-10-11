import {
  carryExitV2ProofRpcFields,
  UMBRELLA_GHO_DECODED_FIELDS,
} from './carry-exit-v2-umbrella-gho-proof.mjs'
// Pure assembly of one measured call document. This checks internal agreement;
// the two RPC transports and stored evidence still require external auditing.
import { isDeepStrictEqual } from 'node:util'

import { validateCarryExitV2RpcProof } from './carry-exit-v2-rpc-proof.mjs'

// JSONB text serialization is not byte-identical to JSON.stringify. Leave a
// substantial margin below the database's hard 32 KiB constraint; the actual
// DB-side octet length must still be checked before insertion.
const MAX_ASSEMBLED_BYTES = 24 * 1024

export class CarryExitV2ProofAssemblyError extends Error {
  constructor(code) {
    super(code)
    this.name = 'CarryExitV2ProofAssemblyError'
    this.code = code
  }
}

function fail(code) {
  throw new CarryExitV2ProofAssemblyError(code)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameDecoded(expected, actual) {
  return (
    object(actual) &&
    actual.holderCoverageRaw === expected.holderCoverageRaw &&
    actual.requiredCoverageRaw === expected.requiredCoverageRaw &&
    actual.actualConsumedRaw === expected.actualConsumedRaw &&
    actual.simulationStatus === expected.simulationStatus &&
    actual.coveredRevert === expected.coveredRevert &&
    (expected.gate === undefined ||
      UMBRELLA_GHO_DECODED_FIELDS.every((field) => actual[field] === expected[field]))
  )
}

function replayedResponseAgrees(proof, responses, frozen, expected) {
  if (!object(responses)) return false
  const replayed = structuredClone(proof)
  for (const field of carryExitV2ProofRpcFields(proof)) {
    if (replayed[field] === null) {
      if (Object.hasOwn(responses, field)) return false
    } else {
      if (!object(responses[field])) return false
      replayed[field].response = responses[field]
    }
  }
  try {
    return sameDecoded(expected, validateCarryExitV2RpcProof({ proof: replayed, ...frozen }))
  } catch {
    return false
  }
}

function replayedHeadersAgree(headers, blockNumber, blockHash) {
  if (!object(headers)) return false
  for (const origin of ['primary', 'secondary']) {
    if (!object(headers[origin])) return false
    for (const time of ['before', 'after']) {
      const reading = headers[origin][time]
      if (!object(reading) || !object(reading.target) || !object(reading.finalized)) return false
      try {
        if (
          BigInt(reading.target.number) !== BigInt(blockNumber) ||
          reading.target.hash !== blockHash ||
          BigInt(reading.finalized.number) < BigInt(blockNumber)
        )
          return false
      } catch {
        return false
      }
    }
  }
  return true
}

function replayedIdentityAgrees(checks, summaries) {
  if (!object(summaries)) return false
  for (const origin of ['primary', 'secondary']) {
    const rows = summaries[origin]
    if (!Array.isArray(rows) || rows.length !== checks.length) return false
    for (const [index, check] of checks.entries()) {
      const row = rows[index]
      if (!object(row) || row.stage !== check.stage) return false
      if (check.method === 'eth_getCode') {
        if (row.codeBytes !== check.codeBytes || row.codeSha256 !== check.codeSha256) return false
      } else if (
        !isDeepStrictEqual(row.response, check.response) ||
        row.decodedAddress !== (check.decodedAToken ?? check.decodedAddress)
      )
        return false
    }
  }
  return true
}

function originHost(identifier) {
  if (typeof identifier !== 'string') fail('invalid_replay_origins')
  let parsed
  try {
    parsed = new URL(identifier)
  } catch {
    fail('invalid_replay_origins')
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    fail('invalid_replay_origins')
  const hostname = parsed.hostname.replace(/\.$/, '').replace(/^www\./, '')
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(hostname) ? 'loopback' : hostname
}

// PostgreSQL jsonb::text inserts a space after object colons and collection
// commas. Count that overhead in addition to the conservative 24 KiB margin.
function jsonbWhitespaceBound(value) {
  if (Array.isArray(value))
    return (
      Math.max(0, value.length - 1) + value.reduce((n, item) => n + jsonbWhitespaceBound(item), 0)
    )
  if (object(value)) {
    const entries = Object.entries(value)
    return (
      entries.length +
      Math.max(0, entries.length - 1) +
      entries.reduce((n, [, item]) => n + jsonbWhitespaceBound(item), 0)
    )
  }
  return 0
}

/** Assemble only after collection and independent replay have both completed. */
export function assembleCarryExitV2CallEvidence({ collector, replay, frozen }) {
  if (!object(frozen) || !object(collector) || !object(replay)) fail('invalid_assembly_input')
  const { routeKey, destination, asset, holder, assetsRaw, blockNumber, blockHash } = frozen
  const proof = collector.proof
  let decoded
  try {
    decoded = validateCarryExitV2RpcProof({
      proof,
      routeKey,
      destination,
      asset,
      holder,
      assetsRaw,
      blockNumber,
      blockHash,
    })
  } catch {
    fail('invalid_collected_proof')
  }
  if (
    collector.status !== 'raw_rpc_collected' ||
    collector.blockNumber !== blockNumber ||
    collector.blockHash !== blockHash ||
    collector.routeKind !== decoded.routeKind ||
    collector.provider !== proof.holderCoverageRpc.provider ||
    collector.provider !== proof.withdrawRpc.provider ||
    collector.source !== proof.holderCoverageRpc.source ||
    collector.source !== proof.withdrawRpc.source ||
    (proof.requiredCoverageRpc &&
      (collector.provider !== proof.requiredCoverageRpc.provider ||
        collector.source !== proof.requiredCoverageRpc.source))
  )
    fail('collector_identity_mismatch')

  const identityEvidence = collector.identityEvidence
  if (
    !object(identityEvidence) ||
    identityEvidence.schema !== 'carry_exit_v2_identity_v1' ||
    identityEvidence.chainId !== '1' ||
    identityEvidence.routeKey !== routeKey ||
    identityEvidence.destination !== destination ||
    identityEvidence.asset !== asset ||
    identityEvidence.holder !== holder ||
    identityEvidence.kind !== decoded.routeKind ||
    identityEvidence.blockNumber !== blockNumber ||
    identityEvidence.blockHash !== blockHash ||
    identityEvidence.provider !== collector.provider ||
    identityEvidence.source !== collector.source ||
    !Array.isArray(identityEvidence.checks) ||
    identityEvidence.checks.length < 3
  )
    fail('identity_evidence_mismatch')

  const replayEvidenceDoc = replay.replayEvidenceDoc
  if (
    replay.status !== 'verified' ||
    !object(replay.verdict) ||
    !object(replayEvidenceDoc) ||
    replayEvidenceDoc.schema !== 'carry_exit_v2_independent_replay_v1' ||
    replayEvidenceDoc.blockNumber !== blockNumber ||
    replayEvidenceDoc.blockHash !== blockHash ||
    !replayedHeadersAgree(replayEvidenceDoc.headers, blockNumber, blockHash) ||
    (decoded.routeKind === 'umbrella_gho' &&
      ['primary', 'secondary'].some((origin) =>
        ['before', 'after'].some(
          (when) =>
            BigInt(replayEvidenceDoc.headers[origin][when].target.timestamp).toString() !==
            proof.blockTimestampSeconds,
        ),
      )) ||
    !object(replayEvidenceDoc.responses) ||
    !replayedResponseAgrees(proof, replayEvidenceDoc.responses.primary, frozen, decoded) ||
    !replayedResponseAgrees(proof, replayEvidenceDoc.responses.secondary, frozen, decoded) ||
    !replayedIdentityAgrees(identityEvidence.checks, replayEvidenceDoc.identityReplay) ||
    !sameDecoded(decoded, replayEvidenceDoc.decoded) ||
    replay.verdict.simulationStatus !== decoded.simulationStatus ||
    replay.verdict.coveredRevert !== decoded.coveredRevert
  )
    fail('replay_evidence_mismatch')
  const origins = replayEvidenceDoc.origins
  if (
    !object(origins) ||
    originHost(origins.primary) === originHost(origins.secondary) ||
    origins.primary === origins.secondary
  )
    fail('non_independent_origins')

  const assembled = {
    ...proof,
    verificationStatus: 'verified',
    identityEvidence,
    replayEvidenceDoc,
  }
  let serialized
  try {
    serialized = JSON.stringify(assembled)
  } catch {
    fail('non_serializable_evidence')
  }
  if (
    !serialized ||
    Buffer.byteLength(serialized, 'utf8') + jsonbWhitespaceBound(assembled) > MAX_ASSEMBLED_BYTES
  )
    fail('evidence_too_large')
  return JSON.parse(serialized)
}
