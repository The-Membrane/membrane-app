// Offline, as-of join of a verified retrospective suffix and the prospective
// live ledger. The join is only a calculation view; neither source is rewritten.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity as quoteIdentity,
} from './curve-prospective-quote.mjs'
import {
  OUT as LIVE_OUT,
  FIRST_LIVE_BLOCK,
  FIRST_LIVE_BLOCK_HASH,
  FIRST_LIVE_RECEIPT_SHA256,
  readValidatedReceipts,
  sourceIdentity as flowIdentity,
} from './curve-vault-flow-ledger.mjs'
import { computeFlowFeatures } from './curve-vault-flow-features.mjs'
import {
  OUT as NEAR_LIVE_OUT,
  availableReceiptsAt,
  readPlan,
  verify as verifyNearLive,
} from './curve-vault-flow-near-live.mjs'

export const STUDY = 'scrvusd-vault-flow-composite-features-v1'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const issueTime = (value) => {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error('Invalid composite feature as-of time')
  return ms
}
const filename = (receipt) =>
  `${String(receipt.range.from.number).padStart(12, '0')}-${String(receipt.range.to.number).padStart(12, '0')}-${receipt.range.to.hash.slice(2)}.json`
const witnessFilename = (receipt) =>
  `${String(receipt.range.from.number).padStart(12, '0')}-${receipt.range.from.hash.slice(2)}.json`
const physical = (path) => sha(readFileSync(path))
const sameBlock = (a, b) =>
  a?.number === b?.number && a?.hash === b?.hash && a?.timestamp === b?.timestamp
const boundary = (receipt, side) => ({
  blockNumber: receipt.range[side].number,
  blockHash: receipt.range[side].hash,
  receiptSha256: receipt.sha256,
})
const prefixCommitment = (receipts, tuples) => ({
  count: receipts.length,
  first: boundary(receipts[0], 'from'),
  last: boundary(receipts.at(-1), 'to'),
  orderedTuplesSha256: sha(JSON.stringify(tuples)),
})

export function readCompositeFeatures({
  asOfUtc = new Date().toISOString(),
  checkpointFilename,
  quoteOut = QUOTE_OUT,
  liveOut = LIVE_OUT,
  nearLiveOut = NEAR_LIVE_OUT,
  source = flowIdentity(),
  quoteSource = quoteIdentity(),
} = {}) {
  const asOfMs = issueTime(asOfUtc)
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity: quoteSource })
  const eligible = checkpoints.filter((row) => Date.parse(row.checkpoint.captureEndUtc) <= asOfMs)
  // Explicit selection is for immutable issue replay after newer quote files
  // arrive. Default selection uses the greatest eligible B, then filename as
  // a deterministic tie break (the validated reader already rejects two
  // files for one B).
  const checkpointRow =
    checkpointFilename !== undefined
      ? checkpoints.find((row) => row.filename === checkpointFilename)
      : eligible
          .sort(
            (a, b) =>
              a.checkpoint.block.number - b.checkpoint.block.number ||
              a.filename.localeCompare(b.filename),
          )
          .at(-1)
  const B = checkpointRow?.checkpoint?.block
  if (!B) throw new Error('Composite features require an eligible sealed quote checkpoint')
  if (Date.parse(checkpointRow.checkpoint.captureEndUtc) > asOfMs)
    throw new Error('Quote checkpoint was captured after the issue time')

  const live = readValidatedReceipts({ out: liveOut, source })
  const first = live[0]
  if (
    first?.sha256 !== FIRST_LIVE_RECEIPT_SHA256 ||
    first?.range.from.number !== FIRST_LIVE_BLOCK ||
    first.range.from.hash !== FIRST_LIVE_BLOCK_HASH
  )
    throw new Error('Frozen first live receipt anchor unavailable')
  const livePrefix = live.filter((receipt) => receipt.range.to.number <= B.number)
  if (livePrefix.length === 0 || !sameBlock(livePrefix.at(-1).range.to, B))
    throw new Error('Live flow prefix does not end at the exact quote checkpoint')
  if (livePrefix.some((receipt) => Date.parse(receipt.captureEndUtc) > asOfMs))
    throw new Error('Live receipt was captured after the issue time')

  // verifyNearLive checks the sealed plan, contiguous source receipts, every
  // physical boundary witness, and the exact end boundary. The as-of reader
  // independently checks plan, receipt and witness capture clocks.
  const status = verifyNearLive({ out: nearLiveOut, source, liveOut })
  if (!status.completeToFirstLive)
    throw new Error('Near-live suffix is incomplete at the first live boundary')
  const plan = readPlan({ out: nearLiveOut, source, liveOut })
  if (Date.parse(plan.capturedAtUtc) > asOfMs)
    throw new Error('Near-live plan was captured after the issue time')
  const suffix = availableReceiptsAt({ issuedAtUtc: asOfUtc, out: nearLiveOut, source, liveOut })
  if (
    !suffix.length ||
    !sameBlock(suffix[0].range.from, plan.start) ||
    !sameBlock(suffix.at(-1).range.to, plan.end) ||
    plan.end.number + 1 !== first.range.from.number ||
    plan.end.hash !== plan.firstLiveParentHash ||
    plan.firstLive.number !== first.range.from.number ||
    plan.firstLive.hash !== first.range.from.hash ||
    plan.firstLive.timestamp !== first.range.from.timestamp ||
    plan.firstLive.receiptSha256 !== first.sha256 ||
    plan.firstLive.receiptPhysicalSha256 !== physical(join(liveOut, filename(first)))
  )
    throw new Error('Near-live as-of suffix or canonical first-live bridge unavailable')

  // readValidatedReceipts rightly keeps the first live receipt's original
  // previousReceiptSha256=null. This virtual link exists solely to let the
  // pure feature calculator traverse one explicitly verified block bridge.
  // It must never be sealed or published as an actual receipt.
  const view = [
    ...suffix,
    { ...livePrefix[0], previousReceiptSha256: suffix.at(-1).sha256 },
    ...livePrefix.slice(1),
  ]
  const features = computeFlowFeatures({ checkpointRow, receipts: view, source, asOfUtc })
  if (features.status !== 'observed')
    throw new Error(`Composite flow features unavailable: ${features.reason}`)

  const suffixReceiptTuples = []
  const suffixWitnessTuples = []
  for (const receipt of suffix) {
    const name = filename(receipt)
    const witnessName = witnessFilename(receipt)
    const witness = JSON.parse(readFileSync(join(nearLiveOut, 'boundaries', witnessName), 'utf8'))
    suffixReceiptTuples.push({
      filename: name,
      logicalSha256: receipt.sha256,
      physicalSha256: physical(join(nearLiveOut, 'receipts', name)),
    })
    suffixWitnessTuples.push({
      filename: witnessName,
      logicalSha256: witness.sha256,
      physicalSha256: physical(join(nearLiveOut, 'boundaries', witnessName)),
    })
  }
  const liveTuples = livePrefix.map((receipt) => ({
    filename: filename(receipt),
    logicalSha256: receipt.sha256,
    physicalSha256: physical(join(liveOut, filename(receipt))),
  }))
  return {
    study: STUDY,
    asOfUtc: new Date(asOfMs).toISOString(),
    block: B,
    source: {
      quoteFilename: checkpointRow.filename,
      quoteCheckpointSha256: checkpointRow.checkpoint.sha256,
      quotePhysicalSha256: checkpointRow.physicalSha256,
      flowSourceIdentitySha256: source.identitySha256,
      nearLivePlanSha256: plan.sha256,
      nearLivePlanPhysicalSha256: physical(join(nearLiveOut, 'plan.json')),
      nearLiveEndHash: plan.end.hash,
      frozenFirstLiveParentHash: plan.firstLiveParentHash,
      tupleEncoding: 'json-array-filename-logicalSha256-physicalSha256-v1',
      nearLiveReceiptPrefix: prefixCommitment(suffix, suffixReceiptTuples),
      nearLiveWitnessPrefix: prefixCommitment(suffix, suffixWitnessTuples),
      liveReceiptPrefix: prefixCommitment(livePrefix, liveTuples),
    },
    features,
    caveat:
      'One RPC host supplied the near-live suffix; observed vault flow is context, not holder-executable exit capacity or a forecast.',
  }
}
