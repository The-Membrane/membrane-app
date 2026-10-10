// Pure consistency check for caller-supplied, hash-pinned Vault V2 getter reads.
// This does not fetch chain data, attest a deployed source, or decode adapter bytes.
import { keccak256 } from 'viem'

const ADDRESS = /^0x[0-9a-f]{40}$/i
const HASH = /^0x[0-9a-f]{64}$/i
const SHA256 = /^[0-9a-f]{64}$/i
const BYTES = /^0x(?:[0-9a-f]{2})*$/i
const ZERO = `0x${'0'.repeat(40)}`
const same = (left, right) => String(left).toLowerCase() === String(right).toLowerCase()

function validRead(read, { block, blockHash, vault, adapter }) {
  if (!read) return 'getter-unavailable'
  if (read.block !== block || !HASH.test(read.blockHash) || !same(read.blockHash, blockHash))
    return 'block-or-hash-mismatch'
  if (!ADDRESS.test(read.vault) || !same(read.vault, vault)) return 'vault-mismatch'
  if (!ADDRESS.test(read.adapter) || !same(read.adapter, adapter)) return 'adapter-mismatch'
  if (!BYTES.test(read.liquidityData)) return 'getter-bytes-unavailable'
  if (
    read.sourceAttestation?.status !== 'deployed-verified' ||
    !HASH.test(read.runtimeCodeHash) ||
    !HASH.test(read.sourceAttestation.runtimeCodeHash) ||
    !same(read.runtimeCodeHash, read.sourceAttestation.runtimeCodeHash)
  )
    return 'deployed-source-attestation-unavailable'
  return null
}

function compare(read, expectedHash, context) {
  const reason = validRead(read, context)
  if (reason)
    return {
      status: reason.includes('unavailable') ? 'unavailable' : 'mismatched',
      reason,
      getterHash: null,
    }
  const getterHash = keccak256(read.liquidityData).toLowerCase()
  return {
    status: same(getterHash, expectedHash) ? 'matched' : 'mismatched',
    reason: same(getterHash, expectedHash)
      ? 'indexed-byte-hash-equality'
      : 'indexed-byte-hash-mismatch',
    getterHash,
  }
}

/**
 * Compare exact B and B-1 liquidityData() bytes with indexed event-topic hashes.
 * The manifest prior event can predate B-1; disagreement is evidence to inspect,
 * not proof that a particular transition is wrong.
 */
export function compareRouteDataBytes({
  anchor,
  manifestPhysicalSha256,
  previousBlockHash,
  atB,
  beforeB,
}) {
  if (
    !anchor ||
    !Number.isSafeInteger(anchor.block) ||
    anchor.block < 1 ||
    !Number.isSafeInteger(anchor.transactionIndex) ||
    anchor.transactionIndex < 0 ||
    !Number.isSafeInteger(anchor.logIndex) ||
    anchor.logIndex < 0 ||
    anchor.eventKey !== `${anchor.block}:${anchor.transactionIndex}:${anchor.logIndex}` ||
    !HASH.test(anchor.txHash) ||
    !SHA256.test(manifestPhysicalSha256) ||
    !ADDRESS.test(anchor.vault) ||
    !ADDRESS.test(anchor.fromAdapter) ||
    !ADDRESS.test(anchor.toAdapter) ||
    same(anchor.fromAdapter, ZERO) ||
    same(anchor.toAdapter, ZERO) ||
    same(anchor.fromAdapter, anchor.toAdapter) ||
    !HASH.test(anchor.blockHash) ||
    !HASH.test(anchor.fromDataTopicHash) ||
    !HASH.test(anchor.toDataTopicHash) ||
    !HASH.test(previousBlockHash)
  )
    throw new Error('Exact manifest anchor and B-1 hash required')
  const before = compare(beforeB, anchor.fromDataTopicHash, {
    block: anchor.block - 1,
    blockHash: previousBlockHash,
    vault: anchor.vault,
    adapter: anchor.fromAdapter,
  })
  const after = compare(atB, anchor.toDataTopicHash, {
    block: anchor.block,
    blockHash: anchor.blockHash,
    vault: anchor.vault,
    adapter: anchor.toAdapter,
  })
  const status = [before.status, after.status].includes('mismatched')
    ? 'mismatched'
    : [before.status, after.status].includes('unavailable')
      ? 'unavailable'
      : 'matched'
  return {
    status,
    eventKey: anchor.eventKey,
    manifestPhysicalSha256: manifestPhysicalSha256.toLowerCase(),
    before,
    after,
    assurance: 'caller-consistent-only;manifest-membership-unverified',
    caveat:
      'B is end-of-block, not immediately after this route event. A same-block later write or other transaction effect can change the getter; B-1 can be later than the manifest prior event. Caller-reported manifest SHA does not establish membership or physical verification. Topic equality is byte-hash consistency, not executable withdrawal, headroom, causal attribution, or independent deployed-source/RPC proof.',
  }
}
