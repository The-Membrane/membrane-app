// Research-only companion to a prospective holder-duration issue. It is not an alert or runway.
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
  STUDY as DURATION_STUDY_V1,
  STUDY_V2 as DURATION_STUDY_V2,
  readSources as readDurationSources,
  verify as verifyDuration,
} from './scrvusd-holder-duration.mjs'
import {
  OUT as FEATURE_OUT,
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

export const STUDY = 'scrvusd-holder-duration-flow-context-v2'
export const OUT = resolve('data/research/venue-signals/scrvusd-holder-flow-context')
const SHA = /^[0-9a-f]{64}$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ sha256: _seal, ...payload }) => payload
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const nameFor = (block) => `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
const flowName = (receipt) =>
  `${String(receipt.range.from.number).padStart(12, '0')}-${String(receipt.range.to.number).padStart(12, '0')}-${receipt.range.to.hash.slice(2)}.json`
const witnessName = (receipt) =>
  `${String(receipt.range.from.number).padStart(12, '0')}-${receipt.range.from.hash.slice(2)}.json`
const physicalRef = (path, filename, logicalSha256) => ({
  filename,
  logicalSha256,
  physicalSha256: sha(readFileSync(join(path, filename))),
})

export function historicalPrefixAt(rows, evidenceCutoffUtc) {
  const cutoff = Date.parse(evidenceCutoffUtc)
  if (!Number.isFinite(cutoff)) throw new Error('Invalid historical evidence cutoff')
  const prefix = []
  for (const row of rows) {
    const receiptMs = Date.parse(row.receipt.captureEndUtc)
    const witnessMs = Date.parse(row.witnessRef.capturedAtUtc)
    if (![receiptMs, witnessMs].every(Number.isFinite))
      throw new Error('Invalid historical receipt capture time')
    if (receiptMs > cutoff || witnessMs > cutoff) break
    prefix.push(row)
  }
  return prefix
}

export function buildIssue({ duration, durationRef, feature, featureRef, near }) {
  const issuedMs = Date.parse(near.issuedAtUtc)
  const durationMs = Date.parse(duration?.issuedAtUtc)
  const featureMs = Date.parse(feature?.issuedAtUtc)
  const planMs = Date.parse(near.plan?.capturedAtUtc)
  if (
    ![DURATION_STUDY_V1, DURATION_STUDY_V2].includes(duration?.study) ||
    feature?.study !== 'scrvusd-vault-flow-feature-issues-v1' ||
    ![issuedMs, durationMs, featureMs, planMs].every(Number.isFinite) ||
    featureMs > durationMs ||
    durationMs > issuedMs ||
    planMs > durationMs ||
    JSON.stringify(duration.block) !== JSON.stringify(feature.block) ||
    feature.source?.quoteCheckpointSha256 !== duration.quote?.logicalSha256 ||
    feature.source?.quotePhysicalSha256 !== duration.quote?.physicalSha256 ||
    ![
      duration.sha256,
      feature.sha256,
      durationRef?.physicalSha256,
      featureRef?.physicalSha256,
      near.plan?.sha256,
      near.planRef?.physicalSha256,
      near.source?.identitySha256,
    ].every((value) => SHA.test(value || '')) ||
    near.planRef.filename !== 'plan.json' ||
    near.planRef.logicalSha256 !== near.plan.sha256 ||
    durationRef.logicalSha256 !== duration.sha256 ||
    featureRef.logicalSha256 !== feature.sha256 ||
    durationRef.filename !== nameFor(duration.block) ||
    featureRef.filename !== nameFor(feature.block)
  )
    throw new Error('Companion requires eligible same-B flow before holder duration issuance')

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
        !SHA.test(refs[i].physicalSha256 || '') ||
        !SHA.test(witnesses[i].logicalSha256 || '') ||
        !SHA.test(witnesses[i].physicalSha256 || '') ||
        Date.parse(receipt.captureEndUtc) > durationMs ||
        Date.parse(witnesses[i].capturedAtUtc) > durationMs,
    )
  )
    throw new Error('Near-live suffix receipt or witness was unavailable at duration issue time')
  if (
    receipts.length &&
    (receipts[0].range.from.number !== near.plan.start.number ||
      receipts.at(-1).range.to.number > near.plan.end.number)
  )
    throw new Error('Near-live suffix exceeds frozen plan')

  const summary = summarizeReceipts({ receipts, source: near.source })
  return seal({
    study: STUDY,
    kind: 'prospective-holder-duration-flow-context',
    issuedAtUtc: near.issuedAtUtc,
    block: duration.block,
    durationIssue: durationRef,
    sameBlockFlowFeatureIssue: featureRef,
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
      'Historical successful vault Deposit/Withdraw events are descriptive stress context, not holder-executable exit or a protocol maximum.',
      'Only historical suffix evidence captured by the holder-duration issue time enters this context, even if this companion is issued later.',
      'The historical suffix remains separate from the live ledger until its frozen parent-hash bridge is complete.',
      'Separate gross-withdrawal and signed net-depletion maxima may occur in different complete windows; neither is future cash runway.',
      'No duration probability, persistence forecast, or user-facing alert is issued.',
    ],
  })
}

function sourceAt({
  evidenceCutoffUtc,
  companionIssuedAtUtc,
  featureOut,
  nearOut,
  flowOut,
  quoteOut,
}) {
  const source = flowIdentity()
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity: quoteIdentity() })
  const receipts = readValidatedReceipts({ out: flowOut, source })
  verifyFeatures({ out: featureOut, checkpoints, receipts, source, flowOut })
  const plan = readNearPlan({ out: nearOut, source, liveOut: flowOut })
  const available = availableReceiptsAt({
    issuedAtUtc: evidenceCutoffUtc,
    out: nearOut,
    source,
    liveOut: flowOut,
  })
  const availableRows = available.map((receipt) => {
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
  const nearReceipts = historicalPrefixAt(availableRows, evidenceCutoffUtc)
  return {
    near: {
      issuedAtUtc: companionIssuedAtUtc,
      plan,
      planRef: physicalRef(nearOut, 'plan.json', plan.sha256),
      source,
      receipts: nearReceipts.map((row) => row.receipt),
      receiptRefs: nearReceipts.map((row) => row.receiptRef),
      witnessRefs: nearReceipts.map((row) => row.witnessRef),
    },
  }
}

function inputs({
  durationOut = DURATION_OUT,
  featureOut = FEATURE_OUT,
  nearOut = NEAR_OUT,
  flowOut = FLOW_OUT,
  quoteOut = QUOTE_OUT,
} = {}) {
  const durationSources = readDurationSources({ holderOut: undefined, quoteOut })
  verifyDuration({ out: durationOut, sources: durationSources })
  const durationFiles = existsSync(join(durationOut, 'issues'))
    ? readdirSync(join(durationOut, 'issues'))
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  return { durationOut, featureOut, nearOut, flowOut, quoteOut, durationFiles }
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
  const durationPath = join(durationOut, 'issues', filename)
  const featurePath = join(featureOut, filename)
  if (!existsSync(featurePath)) throw new Error('Same-B flow feature issue unavailable')
  const duration = JSON.parse(readFileSync(durationPath))
  const feature = JSON.parse(readFileSync(featurePath))
  const { near } = sourceAt({
    evidenceCutoffUtc: duration.issuedAtUtc,
    companionIssuedAtUtc: issuedAtUtc,
    featureOut,
    nearOut,
    flowOut,
    quoteOut,
  })
  return buildIssue({
    duration,
    durationRef: physicalRef(join(durationOut, 'issues'), filename, duration.sha256),
    feature,
    featureRef: physicalRef(featureOut, filename, feature.sha256),
    near,
  })
}

export function readSealed(path) {
  const bytes = readFileSync(path)
  const saved = JSON.parse(bytes)
  if (
    bytes.toString() !== `${JSON.stringify(saved)}\n` ||
    saved.sha256 !== sha(JSON.stringify(unsigned(saved)))
  )
    throw new Error('Companion physical or logical seal mismatch')
  return saved
}

export function verify({ out = OUT, roots = {} } = {}) {
  const files = existsSync(out)
    ? readdirSync(out)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  const seen = new Set()
  for (const filename of files) {
    const saved = readSealed(join(out, filename))
    if (filename !== nameFor(saved.block) || seen.has(saved.block.number))
      throw new Error('Companion filename or duplicate block')
    seen.add(saved.block.number)
    const source = inputs(roots)
    if (!source.durationFiles.includes(filename)) throw new Error('Missing duration issue')
    const expected = buildForFile({ filename, issuedAtUtc: saved.issuedAtUtc, ...source })
    if (
      JSON.stringify(saved) !== JSON.stringify(expected) ||
      Date.parse(saved.issuedAtUtc) > Date.now()
    )
      throw new Error('Companion as-of replay mismatch')
  }
  return { issues: files.length }
}

function guard(path, stat, extra) {
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Companion disk reserve reached')
}

export function issueLatest({
  out = OUT,
  roots = {},
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  verify({ out, roots })
  const issuedAtUtc = now().toISOString()
  const source = inputs(roots)
  const filename = source.durationFiles.at(-1)
  if (!filename) return { status: 'unavailable', reason: 'no_holder_duration_issue' }
  const path = join(out, filename)
  if (existsSync(path)) return { status: 'unchanged', path }
  let issue
  try {
    issue = buildForFile({ filename, issuedAtUtc, ...source })
  } catch (error) {
    if (/Same-B flow feature issue unavailable|Companion requires eligible/.test(error.message))
      return { status: 'unavailable', reason: 'same_B_flow_not_available_before_duration_issue' }
    throw error
  }
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
  return { status: 'issued', path, historicalCoverage: issue.historicalSuffix.coverage }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? '--verify'
    if (!['--verify', '--run'].includes(mode) || process.argv.length > 3)
      throw new Error('Invalid companion mode')
    console.log(JSON.stringify(mode === '--run' ? issueLatest() : verify()))
  } catch {
    console.error('Holder flow context failed')
    process.exitCode = 1
  }
}
