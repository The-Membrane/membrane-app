// Offline research-only as-of join. No RPC, writer, threshold, or alert path.
// The quote reader verifies the physical source before this module uses it.
import { createHash } from 'node:crypto'
import { readValidatedCheckpoints, sourceIdentity, STUDY_V2 } from './curve-prospective-quote.mjs'

export const STUDY = 'curve-peg-imbalance-observation-v1'
export const FLOW_STUDY = 'scrvusd-vault-flow-composite-feature-issues-v2'
const HEX = /^[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unsigned = ({ sha256: _seal, ...rest }) => rest

function clock(value) {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null
}

function sameBlock(a, b) {
  return a?.number === b?.number && a?.hash === b?.hash && a?.timestamp === b?.timestamp
}

function sealed(value) {
  return (
    value &&
    typeof value === 'object' &&
    HEX.test(value.sha256) &&
    value.sha256 === sha(unsigned(value))
  )
}

/** Schema for a future independently collected, pinned no-argument get_p/price_oracle reading.
 * The pool code hashes and quote physical hash bind a reading to the exact validated quote.
 * This only validates receipt structure and logical seal, not RPC honesty/canonical finality.
 */
export function pegReceiptStatus(receipt, quoteRow, decisionAtUtc) {
  if (!receipt) return 'missing'
  const q = quoteRow.checkpoint
  if (q.study !== STUDY_V2) return 'legacy_quote_unavailable'
  if (!sealed(receipt) || receipt.study !== STUDY || receipt.chainId !== q.source.chainId)
    return 'invalid_receipt'
  if (
    !sameBlock(receipt.block, q.block) ||
    receipt.quote?.filename !== quoteRow.filename ||
    receipt.quote?.logicalSha256 !== q.sha256 ||
    receipt.quote?.physicalSha256 !== quoteRow.physicalSha256 ||
    receipt.quote?.identitySha256 !== q.source.identitySha256
  )
    return 'mismatched_source'
  if (
    receipt.pinMode !== 'hash' ||
    !Array.isArray(receipt.pools) ||
    receipt.pools.length !== q.source.pools.length ||
    receipt.pools.some((p, i) => {
      const expected = q.source.pools[i]
      const code = q.raw.codeIdentities.find((entry) => entry.address === expected.address)
      return (
        p?.address !== expected.address ||
        p?.codeSha256 !== code?.codeSha256 ||
        p?.selectorVariant !== 'no-arg' ||
        typeof p.getPRaw !== 'string' ||
        !DECIMAL.test(p.getPRaw) ||
        BigInt(p.getPRaw) <= 0n ||
        typeof p.priceOracleRaw !== 'string' ||
        !DECIMAL.test(p.priceOracleRaw) ||
        BigInt(p.priceOracleRaw) <= 0n
      )
    })
  )
    return 'invalid_receipt'
  if (
    q.raw.poolStates.some(
      (pool) => BigInt(pool.balancesRaw[0]) * 10n ** 12n + BigInt(pool.balancesRaw[1]) === 0n,
    )
  )
    return 'zero_reserves'
  const start = clock(receipt.captureStartUtc)
  const end = clock(receipt.captureEndUtc)
  const sealedAt = clock(receipt.sealedAtUtc)
  const decision = clock(decisionAtUtc)
  const quoteEnd = clock(q.captureEndUtc)
  if (
    start === null ||
    end === null ||
    sealedAt === null ||
    decision === null ||
    quoteEnd === null ||
    start < q.block.timestamp * 1000 ||
    end < start ||
    sealedAt < end ||
    sealedAt < quoteEnd
  )
    return 'invalid_clock'
  if (sealedAt > decision || quoteEnd > decision) return 'late'
  return 'reported_available_asof'
}

function flowStatus(issue, quoteRow, decisionAtUtc) {
  if (!issue) return 'missing'
  const q = quoteRow.checkpoint
  if (
    !sealed(issue) ||
    issue.study !== FLOW_STUDY ||
    !sameBlock(issue.block, q.block) ||
    issue.source?.quoteFilename !== quoteRow.filename ||
    issue.source?.quoteCheckpointSha256 !== q.sha256 ||
    issue.source?.quotePhysicalSha256 !== quoteRow.physicalSha256
  )
    return 'mismatched_or_invalid'
  const issued = clock(issue.issuedAtUtc)
  const decision = clock(decisionAtUtc)
  if (issued === null || decision === null) return 'invalid_clock'
  if (issued < clock(q.captureEndUtc) || issued > decision) return 'late_or_future'
  // The logical seal is not full replay of source flow receipts. Caller must
  // run the flow issue verifier before treating this as measured flow evidence.
  return 'known_asof_logical_only'
}

function poolFeature(observation, quotePool) {
  // Stable coin0 has six decimals, crvUSD coin1 has eighteen. This is a
  // token-parity reserve comparison, not a dollar value or executable quote.
  const stableAt18 = BigInt(quotePool.balancesRaw[0]) * 10n ** 12n
  const crvUsdAt18 = BigInt(quotePool.balancesRaw[1])
  return {
    address: observation.address,
    getPRaw: observation.getPRaw,
    priceOracleRaw: observation.priceOracleRaw,
    stableReserveRaw: quotePool.balancesRaw[0],
    crvUsdReserveRaw: quotePool.balancesRaw[1],
    atParityImbalanceBps: String(((stableAt18 - crvUsdAt18) * 10_000n) / (stableAt18 + crvUsdAt18)),
  }
}

/** A candidate research view from the independently validated quote directory.
 * A missing/late/invalid peg reading never inherits historical peg values.
 */
export function joinAsOf({
  quoteOut,
  checkpointFilename,
  pegReceipt = null,
  flowIssue = null,
  decisionAtUtc,
  identity = sourceIdentity(),
}) {
  if (clock(decisionAtUtc) === null) throw new Error('Invalid decision clock')
  const rows = readValidatedCheckpoints({ out: quoteOut, identity })
  const quoteRow = rows.find((row) => row.filename === checkpointFilename)
  if (!quoteRow)
    return { status: 'missing_quote', pegStatus: 'unavailable', flowStatus: 'unavailable' }
  const quote = quoteRow.checkpoint
  if (quote.study !== STUDY_V2)
    return {
      status: 'legacy_quote_unavailable',
      pegStatus: 'unavailable',
      flowStatus: 'unavailable',
      block: quote.block,
    }
  const pegStatus = pegReceiptStatus(pegReceipt, quoteRow, decisionAtUtc)
  const flow = flowStatus(flowIssue, quoteRow, decisionAtUtc)
  return {
    status:
      pegStatus === 'reported_available_asof' ? 'research_candidate_unverified' : 'unavailable',
    pegStatus,
    flowStatus: flow,
    block: quote.block,
    decisionAtUtc,
    source: {
      quoteFilename: quoteRow.filename,
      quoteLogicalSha256: quote.sha256,
      quotePhysicalSha256: quoteRow.physicalSha256,
      pegLogicalSha256: pegStatus === 'reported_available_asof' ? pegReceipt.sha256 : null,
      flowLogicalSha256: flow === 'known_asof_logical_only' ? flowIssue.sha256 : null,
    },
    pegAndImbalance:
      pegStatus === 'reported_available_asof'
        ? pegReceipt.pools.map((pool, i) => poolFeature(pool, quote.raw.poolStates[i]))
        : null,
    caveat:
      'A caller can backdate and reseal this in-memory peg receipt: reported as-of clocks do not prove when it was first known. RPC pin attestations are also self-reported until an independently verified collector exists. Pinned nominal quote and peg/oracle observation are research context only; no executable exit, predictive signal, RPC completeness proof, or alert. Flow issue needs independent source replay.',
  }
}
