// Offline historical stress reference for the separately verified scrvUSD
// near-live suffix. Never join this partial archive to the live flow ledger.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sourceIdentity } from './curve-vault-flow-ledger.mjs'
import { OUT, availableReceiptsAt, readPlan, verify } from './curve-vault-flow-near-live.mjs'
import { HORIZONS, summarizeReceipts } from './curve-vault-flow-summary.mjs'

export const STUDY = 'scrvusd-near-live-disjoint-flow-reference-v1'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const iso = (ms) => new Date(ms).toISOString()
const parseUtc = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    throw new Error('Invalid UTC timestamp')
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || iso(ms) !== value) throw new Error('Invalid UTC timestamp')
  return ms
}

function sourceInput(out, receipt) {
  const receiptPath = join(
    out,
    'receipts',
    `${String(receipt.range.from.number).padStart(12, '0')}-${String(receipt.range.to.number).padStart(12, '0')}-${receipt.range.to.hash.slice(2)}.json`,
  )
  const receiptPhysicalSha256 = sha(readFileSync(receiptPath))
  const witnessPath = join(
    out,
    'boundaries',
    `${String(receipt.range.from.number).padStart(12, '0')}-${receipt.range.from.hash.slice(2)}.json`,
  )
  const bytes = readFileSync(witnessPath)
  const witness = JSON.parse(bytes.toString())
  const { sha256: witnessLogicalSha256, ...payload } = witness
  if (
    bytes.toString() !== `${JSON.stringify(witness)}\n` ||
    witnessLogicalSha256 !== sha(JSON.stringify(payload)) ||
    witness.receiptSha256 !== receipt.sha256 ||
    witness.receiptPhysicalSha256 !== receiptPhysicalSha256 ||
    !Number.isFinite(Date.parse(witness.capturedAtUtc))
  )
    throw new Error('Near-live receipt or witness bytes changed')
  return {
    fromBlock: receipt.range.from.number,
    throughBlock: receipt.range.to.number,
    receiptLogicalSha256: receipt.sha256,
    receiptPhysicalSha256,
    witnessLogicalSha256,
    witnessPhysicalSha256: sha(bytes),
    witnessCapturedAtUtc: witness.capturedAtUtc,
  }
}

// Pure builder for already verified inputs. Use reference() for authoritative reads.
export function buildReference({
  receipts,
  plan,
  planPhysicalSha256,
  source,
  asOfUtc,
  sourceInputs,
}) {
  let asOf
  try {
    asOf = parseUtc(asOfUtc)
  } catch {
    throw new Error('Invalid as-of time')
  }
  if (sourceInputs.length !== receipts.length) throw new Error('Source input count mismatch')
  if (!/^[0-9a-f]{64}$/.test(planPhysicalSha256)) throw new Error('Invalid plan physical SHA')
  const captureTimes = [parseUtc(plan.capturedAtUtc)]
  for (let i = 0; i < receipts.length; i++) {
    const receiptCapture = parseUtc(receipts[i].captureEndUtc)
    const witnessCapture = parseUtc(sourceInputs[i].witnessCapturedAtUtc)
    captureTimes.push(receiptCapture, witnessCapture)
    if (
      sourceInputs[i].fromBlock !== receipts[i].range.from.number ||
      sourceInputs[i].throughBlock !== receipts[i].range.to.number ||
      sourceInputs[i].receiptLogicalSha256 !== receipts[i].sha256 ||
      ![
        sourceInputs[i].receiptLogicalSha256,
        sourceInputs[i].receiptPhysicalSha256,
        sourceInputs[i].witnessLogicalSha256,
        sourceInputs[i].witnessPhysicalSha256,
      ].every((value) => /^[0-9a-f]{64}$/.test(value)) ||
      receiptCapture > asOf ||
      witnessCapture > asOf ||
      !Number.isSafeInteger(receipts[i].range?.from?.timestamp) ||
      !Number.isSafeInteger(receipts[i].range?.to?.timestamp) ||
      receipts[i].range.from.timestamp > receipts[i].range.to.timestamp ||
      receipts[i].range.to.timestamp > Math.floor(asOf / 1000)
    )
      throw new Error('Future or invalid receipt block/capture in as-of reference')
  }
  const firstKnown = Math.max(...captureTimes)
  if (!Number.isFinite(firstKnown) || firstKnown > asOf)
    throw new Error('Future or invalid plan capture in as-of reference')
  const summary = summarizeReceipts({ receipts, source })
  const coverageSeconds = summary.coverage
    ? Date.parse(summary.coverage.endExclusiveUtc) / 1000 -
      Date.parse(summary.coverage.fromUtc) / 1000
    : 0
  const payload = {
    study: STUDY,
    status: summary.status,
    source: 'verified_near_live_archive_prefix_only',
    sourceIdentitySha256: source.identitySha256,
    planSha256: plan.sha256,
    planPhysicalSha256,
    sourceInputs,
    asOfUtc,
    firstKnownAtUtc: iso(firstKnown),
    sourceSpan: summary.coverage,
    bridge: {
      joinedToLiveLedger: false,
      plannedLastArchiveBlock: plan.end.number,
      capturedThroughBlock: summary.coverage?.throughBlock ?? null,
      blocksRemainingToPlannedBridge: summary.coverage
        ? plan.end.number - summary.coverage.throughBlock
        : plan.end.number - plan.start.number + 1,
    },
    completeWindowSupport: Object.fromEntries(
      HORIZONS.map((h) => [
        h.label,
        {
          horizonSeconds: h.seconds,
          possibleCompleteStartSeconds: Math.max(0, coverageSeconds - h.seconds + 1),
          nonoverlappingWindowsInSpan: Math.floor(coverageSeconds / h.seconds),
          note: 'Possible starts overlap; these are coverage support, not independent outcome samples.',
        },
      ]),
    ),
    maximumObservedCompleteWindowGrossWithdrawal: summary.maximumObservedCompleteWindow,
    maximumObservedCompleteWindowSignedNetDepletion:
      summary.maximumObservedCompleteWindowNetDepletion,
    limitations: [
      'Separate archive prefix; no splice with live receipts or retroactive use in prior issues.',
      'Successful Deposit/Withdraw events only; reverted exit attempts and latent demand are absent.',
      'One RPC host attests interior quiet ranges; boundary witnesses and sealed receipts are checked offline.',
      'Historical observed maxima are neither current holder-executable exit capacity nor a future forecast or protocol maximum.',
    ],
  }
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}

export function reference({
  asOfUtc = new Date().toISOString(),
  out = OUT,
  source = sourceIdentity(),
  liveOut,
} = {}) {
  // Verify every saved receipt and boundary witness before selecting an as-of
  // prefix. A later backfill cannot be made available at an earlier issue time.
  verify({ out, source, liveOut })
  const plan = readPlan({ out, source, liveOut })
  const receipts = availableReceiptsAt({ issuedAtUtc: asOfUtc, out, source, liveOut })
  return buildReference({
    receipts,
    plan,
    planPhysicalSha256: sha(readFileSync(join(out, 'plan.json'))),
    source,
    asOfUtc,
    sourceInputs: receipts.map((receipt) => sourceInput(out, receipt)),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length > 2 || (args.length && args[0] !== '--as-of') || args.length === 1) {
    console.error('Usage: curve-vault-flow-reference.mjs [--as-of ISO-UTC]')
    process.exitCode = 1
  } else {
    try {
      console.log(JSON.stringify(reference({ asOfUtc: args[1] })))
    } catch {
      console.error('Verified disjoint flow reference unavailable')
      process.exitCode = 1
    }
  }
}
