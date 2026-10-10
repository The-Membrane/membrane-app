// Immutable research companion: cohort duration and vault flow known at its issue time.
// This is descriptive context, never an exit forecast, cash runway, or alert.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OUT as DURATION_OUT,
  STUDY as DURATION_STUDY,
  readSources as readDurationSources,
  verify as verifyDuration,
} from './scrvusd-cohort-duration.mjs'
import {
  OUT as FEATURE_OUT,
  STUDY as FEATURE_STUDY,
  verifyIssues as verifyFeatures,
} from './curve-vault-flow-feature-issues.mjs'
import {
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity as quoteIdentity,
} from './curve-prospective-quote.mjs'
import {
  OUT as FLOW_OUT,
  readValidatedReceipts,
  sourceIdentity as flowIdentity,
  RESERVE_BYTES,
} from './curve-vault-flow-ledger.mjs'
import {
  OUT as NEAR_OUT,
  availableReceiptsAt,
  readPlan as readNearPlan,
} from './curve-vault-flow-near-live.mjs'
import { summarizeReceipts } from './curve-vault-flow-summary.mjs'

export const STUDY = 'scrvusd-cohort-duration-flow-context-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-cohort-flow-context')
const SHA = /^[0-9a-f]{64}$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ sha256: _seal, ...payload }) => payload
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const nameFor = (block) => `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
const flowName = (receipt) =>
  `${String(receipt.range.from.number).padStart(12, '0')}-${String(receipt.range.to.number).padStart(12, '0')}-${receipt.range.to.hash.slice(2)}.json`
const witnessName = (receipt) =>
  `${String(receipt.range.from.number).padStart(12, '0')}-${receipt.range.from.hash.slice(2)}.json`
const physicalRef = (dir, filename, logicalSha256) => ({
  filename,
  logicalSha256,
  physicalSha256: sha(readFileSync(join(dir, filename))),
})
const validTime = (value) => Number.isSafeInteger(Date.parse(value))

export function historicalPrefixAt(rows, evidenceCutoffUtc) {
  if (!validTime(evidenceCutoffUtc)) throw new Error('Invalid historical evidence cutoff')
  const cutoff = Date.parse(evidenceCutoffUtc)
  const prefix = []
  for (const row of rows) {
    if (!validTime(row.receipt.captureEndUtc) || !validTime(row.witnessRef.capturedAtUtc))
      throw new Error('Invalid historical receipt capture time')
    if (
      Date.parse(row.receipt.captureEndUtc) > cutoff ||
      Date.parse(row.witnessRef.capturedAtUtc) > cutoff
    )
      break
    prefix.push(row)
  }
  return prefix
}

export function buildIssue({ duration, durationRef, feature = null, featureRef = null, near }) {
  const issuedMs = Date.parse(near?.issuedAtUtc)
  const durationMs = Date.parse(duration?.issuedAtUtc)
  const planMs = Date.parse(near?.plan?.capturedAtUtc)
  const members = duration?.riskSet?.members
  if (
    duration?.study !== DURATION_STUDY ||
    ![issuedMs, durationMs, planMs].every(Number.isSafeInteger) ||
    durationMs > issuedMs ||
    planMs > durationMs ||
    JSON.stringify(duration.block) !== JSON.stringify(duration.quote?.block) ||
    !Array.isArray(members) ||
    members.length !== 16 ||
    duration.riskSet.pairCount !== 16 ||
    duration.riskSet.distinctHolderCount !== 5 ||
    duration.riskSet.vaultCount !== 1 ||
    new Set(members.map((member) => member.holder)).size !== 5 ||
    duration.riskSet.forecast?.status !== 'unavailable' ||
    ![
      duration.sha256,
      duration.quote?.logicalSha256,
      duration.quote?.physicalSha256,
      duration.planSha256,
      duration.planPhysicalSha256,
      durationRef?.physicalSha256,
      near.plan?.sha256,
      near.planRef?.physicalSha256,
      near.source?.identitySha256,
    ].every((value) => SHA.test(value || '')) ||
    durationRef.logicalSha256 !== duration.sha256 ||
    durationRef.filename !== nameFor(duration.block) ||
    duration.quote.filename !== nameFor(duration.block) ||
    near.planRef.filename !== 'plan.json' ||
    near.planRef.logicalSha256 !== near.plan.sha256
  )
    throw new Error('Invalid cohort duration or historical source provenance')

  if (feature !== null) {
    if (
      feature.study !== FEATURE_STUDY ||
      !validTime(feature.issuedAtUtc) ||
      JSON.stringify(feature.block) !== JSON.stringify(duration.block) ||
      feature.source?.quoteFilename !== duration.quote.filename ||
      feature.source?.quoteCheckpointSha256 !== duration.quote.logicalSha256 ||
      feature.source?.quotePhysicalSha256 !== duration.quote.physicalSha256 ||
      feature.features?.asOfUtc !== feature.issuedAtUtc ||
      feature.features?.checkpoint?.blockNumber !== duration.block.number ||
      feature.features?.checkpoint?.blockHash !== duration.block.hash ||
      feature.features?.checkpoint?.timestamp !== duration.block.timestamp ||
      feature.features?.coverage?.throughBlock !== duration.block.number ||
      ![feature.sha256, featureRef?.physicalSha256].every((value) => SHA.test(value || '')) ||
      featureRef.logicalSha256 !== feature.sha256 ||
      featureRef.filename !== nameFor(feature.block)
    )
      throw new Error('Invalid same-B flow feature provenance')
  } else if (featureRef !== null) throw new Error('Feature reference without feature')

  const featureAsOf = feature !== null && Date.parse(feature.issuedAtUtc) <= durationMs
  const receipts = near.receipts
  const refs = near.receiptRefs
  const witnesses = near.witnessRefs
  if (
    !Array.isArray(receipts) ||
    !Array.isArray(refs) ||
    !Array.isArray(witnesses) ||
    receipts.length !== refs.length ||
    receipts.length !== witnesses.length ||
    receipts.some(
      (receipt, i) =>
        receipt.sha256 !== refs[i].logicalSha256 ||
        refs[i].filename !== flowName(receipt) ||
        witnesses[i].filename !== witnessName(receipt) ||
        ![refs[i].physicalSha256, witnesses[i].logicalSha256, witnesses[i].physicalSha256].every(
          (value) => SHA.test(value || ''),
        ) ||
        !validTime(receipt.captureEndUtc) ||
        !validTime(witnesses[i].capturedAtUtc) ||
        Date.parse(receipt.captureEndUtc) > durationMs ||
        Date.parse(witnesses[i].capturedAtUtc) > durationMs,
    )
  )
    throw new Error('Historical suffix unavailable at cohort duration issue time')
  if (
    receipts.length &&
    (receipts[0].range.from.number !== near.plan.start.number ||
      receipts.at(-1).range.to.number > near.plan.end.number)
  )
    throw new Error('Historical suffix exceeds frozen plan')

  const summary = summarizeReceipts({ receipts, source: near.source })
  return seal({
    study: STUDY,
    kind: 'prospective-cohort-duration-flow-context',
    issuedAtUtc: near.issuedAtUtc,
    block: duration.block,
    cohortDurationIssue: durationRef,
    cohort: {
      planLogicalSha256: duration.planSha256,
      planPhysicalSha256: duration.planPhysicalSha256,
      observation: duration.cohortObservation,
      pairCount: 16,
      distinctHolderCount: 5,
      vaultCount: 1,
      dependence: 'overlapping_holder_size_pairs_in_one_vault',
    },
    sameBlockFlowFeatureIssue: featureAsOf
      ? {
          status: 'available',
          ...featureRef,
          issuedAtUtc: feature.issuedAtUtc,
          flowFeatures: feature.features,
        }
      : { status: 'unavailable', reason: 'same_B_flow_not_available_before_duration_issue' },
    historicalSuffix: {
      evidenceCutoffUtc: duration.issuedAtUtc,
      plan: near.planRef,
      sourceIdentitySha256: near.source.identitySha256,
      receipts: refs,
      boundaryWitnesses: witnesses,
      completeToFirstLive:
        receipts.at(-1)?.range.to.number === near.plan.end.number &&
        receipts.at(-1)?.range.to.hash === near.plan.firstLiveParentHash,
      coverage: summary.coverage,
      maximumObservedCompleteWindow: summary.maximumObservedCompleteWindow,
      maximumObservedCompleteWindowNetDepletion: summary.maximumObservedCompleteWindowNetDepletion,
    },
    caveats: [
      'All 16 sampled holder-size pairs depend on five holders and one vault; no independent calibration exists.',
      'Same-B flow is attached only when its issue time is no later than cohort duration issue time.',
      'Historical suffix evidence is frozen at duration issue time, even if this companion is issued later.',
      'Observed complete-window gross withdrawals and signed net depletion are descriptive stress context, not protocol maxima or future runway.',
      'No duration probability, remaining-life forecast, or user-facing alert is issued.',
    ],
  })
}

function sourceAt({ cutoffUtc, issuedAtUtc, featureOut, nearOut, flowOut, quoteOut }) {
  const source = flowIdentity()
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity: quoteIdentity() })
  const receipts = readValidatedReceipts({ out: flowOut, source })
  verifyFeatures({ out: featureOut, checkpoints, receipts, source, flowOut })
  const plan = readNearPlan({ out: nearOut, source, liveOut: flowOut })
  const available = availableReceiptsAt({
    issuedAtUtc: cutoffUtc,
    out: nearOut,
    source,
    liveOut: flowOut,
  })
  const rows = available.map((receipt) => {
    const filename = flowName(receipt)
    const witnessFilename = witnessName(receipt)
    const witness = JSON.parse(readFileSync(join(nearOut, 'boundaries', witnessFilename)))
    return {
      receipt,
      receiptRef: physicalRef(join(nearOut, 'receipts'), filename, receipt.sha256),
      witnessRef: {
        ...physicalRef(join(nearOut, 'boundaries'), witnessFilename, witness.sha256),
        capturedAtUtc: witness.capturedAtUtc,
      },
    }
  })
  const prefix = historicalPrefixAt(rows, cutoffUtc)
  return {
    issuedAtUtc,
    plan,
    planRef: physicalRef(nearOut, 'plan.json', plan.sha256),
    source,
    receipts: prefix.map((row) => row.receipt),
    receiptRefs: prefix.map((row) => row.receiptRef),
    witnessRefs: prefix.map((row) => row.witnessRef),
  }
}

function inputs({
  durationOut = DURATION_OUT,
  featureOut = FEATURE_OUT,
  nearOut = NEAR_OUT,
  flowOut = FLOW_OUT,
  quoteOut = QUOTE_OUT,
  planOut,
  observeOut,
  seedOut,
} = {}) {
  const sources = readDurationSources({ planOut, observeOut, seedOut, quoteOut })
  if (!sources) return { durationFiles: [], durationOut, featureOut, nearOut, flowOut, quoteOut }
  verifyDuration({ out: durationOut, sources })
  const dir = join(durationOut, 'issues')
  const durationFiles = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  return { durationFiles, durationOut, featureOut, nearOut, flowOut, quoteOut }
}

function buildForFile({
  filename,
  issuedAtUtc,
  durationOut,
  featureOut,
  nearOut,
  flowOut,
  quoteOut,
}) {
  const durationDir = join(durationOut, 'issues')
  const duration = JSON.parse(readFileSync(join(durationDir, filename)))
  const featurePath = join(featureOut, filename)
  const feature = existsSync(featurePath) ? JSON.parse(readFileSync(featurePath)) : null
  const near = sourceAt({
    cutoffUtc: duration.issuedAtUtc,
    issuedAtUtc,
    featureOut,
    nearOut,
    flowOut,
    quoteOut,
  })
  return buildIssue({
    duration,
    durationRef: physicalRef(durationDir, filename, duration.sha256),
    feature,
    featureRef: feature ? physicalRef(featureOut, filename, feature.sha256) : null,
    near,
  })
}

export function readSealed(path) {
  const bytes = readFileSync(path)
  const saved = JSON.parse(bytes)
  if (
    !bytes.equals(Buffer.from(`${JSON.stringify(saved)}\n`)) ||
    saved.sha256 !== sha(JSON.stringify(unsigned(saved)))
  )
    throw new Error('Cohort flow context physical or logical seal mismatch')
  return saved
}

export function verify({ out = OUT, roots = {}, now = () => new Date() } = {}) {
  const files = existsSync(out)
    ? readdirSync(out)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  const source = inputs(roots)
  const seen = new Set()
  for (const filename of files) {
    const saved = readSealed(join(out, filename))
    if (
      filename !== nameFor(saved.block) ||
      seen.has(saved.block.number) ||
      !source.durationFiles.includes(filename)
    )
      throw new Error('Cohort flow context filename or duration issue mismatch')
    seen.add(saved.block.number)
    const expected = buildForFile({ filename, issuedAtUtc: saved.issuedAtUtc, ...source })
    if (
      JSON.stringify(saved) !== JSON.stringify(expected) ||
      Date.parse(saved.issuedAtUtc) > now().getTime()
    )
      throw new Error('Cohort flow context as-of replay mismatch')
  }
  return { issues: files.length }
}

function guard(path, stat, extra) {
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Cohort flow context disk reserve reached')
}

export function issueLatest({
  out = OUT,
  roots = {},
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  verify({ out, roots, now })
  const issuedAtUtc = now().toISOString()
  const source = inputs(roots)
  const filename = source.durationFiles.find((name) => !existsSync(join(out, name)))
  if (!filename) return { status: 'unchanged', reason: 'no_unissued_cohort_duration_issue' }
  const path = join(out, filename)
  const issue = buildForFile({ filename, issuedAtUtc, ...source })
  const bytes = `${JSON.stringify(issue)}\n`
  guard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return {
    status: 'issued',
    path,
    sameBlockFlow: issue.sameBlockFlowFeatureIssue.status,
    historicalCoverage: issue.historicalSuffix.coverage,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? '--verify'
    if (!['--verify', '--run'].includes(mode) || process.argv.length > 3)
      throw new Error('Invalid cohort flow context mode')
    console.log(JSON.stringify(mode === '--run' ? issueLatest() : verify()))
  } catch {
    console.error('[scrvusd-cohort-flow-context] unavailable')
    process.exitCode = 1
  }
}
