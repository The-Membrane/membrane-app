// Immutable, offline issues for the fully bridged near-live + prospective flow view.
// These are retrospective flow features, not executable exit or forecast claims.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity as quoteIdentity,
} from './curve-prospective-quote.mjs'
import {
  OUT as LIVE_OUT,
  readValidatedReceipts,
  sourceIdentity as flowIdentity,
} from './curve-vault-flow-ledger.mjs'
import { OUT as NEAR_LIVE_OUT, verify as verifyNearLive } from './curve-vault-flow-near-live.mjs'
import { readCompositeFeatures } from './curve-vault-flow-composite-features.mjs'

export const STUDY = 'scrvusd-vault-flow-composite-feature-issues-v2'
export const OUT = resolve(
  'data/research/venue-signals/scrvusd-vault-flow-composite-feature-issues',
)
const HOUR_MS = 3_600_000
const RESERVE_BYTES = 1_073_741_824
export const MAX_ISSUE_BYTES = 64 * 1024
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ sha256: _seal, ...payload }) => payload
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })

function nameFor(block) {
  return `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
}

function sameBlock(a, b) {
  return a?.number === b?.number && a?.hash === b?.hash && a?.timestamp === b?.timestamp
}

function assertProspectiveClock(checkpoint, issuedAtUtc) {
  const issueMs = Date.parse(issuedAtUtc)
  if (!Number.isFinite(issueMs) || new Date(issueMs).toISOString() !== issuedAtUtc)
    throw new Error('Composite flow issue time invalid')
  const captureMs = Date.parse(checkpoint.captureEndUtc)
  if (
    !Number.isFinite(captureMs) ||
    issueMs < captureMs ||
    issueMs - captureMs > 2 * HOUR_MS ||
    issueMs >= (checkpoint.block.timestamp + 24 * 3600) * 1000
  )
    throw new Error('Composite flow issue outside prospective clock bounds')
}

export function buildIssue({
  checkpointFilename,
  issuedAtUtc,
  quoteOut = QUOTE_OUT,
  liveOut = LIVE_OUT,
  nearLiveOut = NEAR_LIVE_OUT,
  source = flowIdentity(),
  quoteSource = quoteIdentity(),
}) {
  const checkpoint = readValidatedCheckpoints({ out: quoteOut, identity: quoteSource }).find(
    (row) => row.filename === checkpointFilename,
  )?.checkpoint
  if (!checkpoint) throw new Error('Composite flow issue quote checkpoint unavailable')
  assertProspectiveClock(checkpoint, issuedAtUtc)

  const composite = readCompositeFeatures({
    asOfUtc: issuedAtUtc,
    checkpointFilename,
    quoteOut,
    liveOut,
    nearLiveOut,
    source,
    quoteSource,
  })
  if (!sameBlock(composite.block, checkpoint.block))
    throw new Error('Composite flow issue quote block mismatch')
  if (
    composite.features.trailingCompleteWindow?.['24h']?.status !== 'observed' ||
    composite.features.trailingCompleteWindow?.['7d']?.status !== 'observed' ||
    composite.features.maximumObservedCompleteWindow?.['24h']?.status !== 'observed' ||
    composite.features.maximumObservedCompleteWindow?.['7d']?.status !== 'observed'
  )
    throw new Error('Composite flow issue requires complete 24h and 7d windows')
  return seal({
    study: STUDY,
    issuedAtUtc,
    block: composite.block,
    source: composite.source,
    features: composite.features,
    caveats: [
      'One RPC provider supplied and cross-checked event ranges; independent-provider completeness is unverified.',
      'Vault Deposit/Withdraw events are observed flow context, not holder withdrawal eligibility, executable exit size, or fill.',
      'Maximum observed complete-window flow is historical context, not future runway or a protocol maximum.',
    ],
  })
}

export function verifyIssues({
  out = OUT,
  quoteOut = QUOTE_OUT,
  liveOut = LIVE_OUT,
  nearLiveOut = NEAR_LIVE_OUT,
  source = flowIdentity(),
  quoteSource = quoteIdentity(),
} = {}) {
  if (!existsSync(out)) return { issues: 0 }
  const files = readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
  for (const filename of files)
    verifyOne({ filename, out, quoteOut, liveOut, nearLiveOut, source, quoteSource })
  return { issues: files.length }
}

function verifyOne({ filename, out, quoteOut, liveOut, nearLiveOut, source, quoteSource }) {
  const path = join(out, filename)
  if (statSync(path).size > MAX_ISSUE_BYTES) throw new Error('Composite flow issue size cap')
  const bytes = readFileSync(path)
  if (bytes.length > MAX_ISSUE_BYTES) throw new Error('Composite flow issue size cap')
  const saved = JSON.parse(bytes.toString('utf8'))
  if (`${JSON.stringify(saved)}\n` !== bytes.toString('utf8'))
    throw new Error('Composite flow issue noncanonical serialization')
  if (!saved || saved.sha256 !== sha(JSON.stringify(unsigned(saved))))
    throw new Error('Composite flow issue SHA mismatch')
  if (saved.study !== STUDY || filename !== nameFor(saved.block))
    throw new Error('Composite flow issue study or filename mismatch')
  const expected = buildIssue({
    checkpointFilename: saved.source?.quoteFilename,
    issuedAtUtc: saved.issuedAtUtc,
    quoteOut,
    liveOut,
    nearLiveOut,
    source,
    quoteSource,
  })
  if (JSON.stringify(expected) !== JSON.stringify(saved))
    throw new Error('Composite flow issue as-of replay or physical source mismatch')
  return saved
}

function verifyLatestIssue(options) {
  const { out } = options
  if (!existsSync(out)) return { issues: 0 }
  const latest = readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .at(-1)
  if (!latest) return { issues: 0 }
  verifyOne({ ...options, filename: latest })
  return { issues: 1, latest }
}

function diskGuard(out, stat, extra) {
  let path = out
  while (!existsSync(path)) {
    const parent = dirname(path)
    if (parent === path) throw new Error('No composite issue output filesystem ancestor')
    path = parent
  }
  const fs = stat(path)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Composite flow issue disk reserve reached')
}

function append(out, issue, stat) {
  const bytes = `${JSON.stringify(issue)}\n`
  if (Buffer.byteLength(bytes) > MAX_ISSUE_BYTES) throw new Error('Composite flow issue size cap')
  diskGuard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const path = join(out, nameFor(issue.block))
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return path
}

export function issueLatest({
  out = OUT,
  quoteOut = QUOTE_OUT,
  liveOut = LIVE_OUT,
  nearLiveOut = NEAR_LIVE_OUT,
  source = flowIdentity(),
  quoteSource = quoteIdentity(),
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  verifyLatestIssue({ out, quoteOut, liveOut, nearLiveOut, source, quoteSource })
  const latest = readValidatedCheckpoints({ out: quoteOut, identity: quoteSource }).reduce(
    (best, row) =>
      !best || row.checkpoint.block.number > best.checkpoint.block.number ? row : best,
    null,
  )
  if (!latest) throw new Error('No validated quote checkpoint')
  const tip = readValidatedReceipts({ out: liveOut, source }).at(-1)?.range.to
  if (!sameBlock(tip, latest.checkpoint.block))
    throw new Error('Current live flow tip is not the latest quote checkpoint')
  const path = join(out, nameFor(latest.checkpoint.block))
  if (existsSync(path)) return { path, status: 'existing' }
  const issue = buildIssue({
    checkpointFilename: latest.filename,
    issuedAtUtc: now().toISOString(),
    quoteOut,
    liveOut,
    nearLiveOut,
    source,
    quoteSource,
  })
  append(out, issue, stat)
  return { path, status: 'issued', featureStatus: issue.features.status }
}

export function runIfReady(options = {}) {
  const {
    out = OUT,
    quoteOut = QUOTE_OUT,
    liveOut = LIVE_OUT,
    nearLiveOut = NEAR_LIVE_OUT,
    source = flowIdentity(),
    quoteSource = quoteIdentity(),
  } = options
  verifyLatestIssue({ out, quoteOut, liveOut, nearLiveOut, source, quoteSource })
  const latest = readValidatedCheckpoints({ out: quoteOut, identity: quoteSource }).reduce(
    (best, row) =>
      !best || row.checkpoint.block.number > best.checkpoint.block.number ? row : best,
    null,
  )
  if (!latest) throw new Error('No validated quote checkpoint')
  const tip = readValidatedReceipts({ out: liveOut, source }).at(-1)?.range.to
  if (!sameBlock(tip, latest.checkpoint.block))
    throw new Error('Current live flow tip is not the latest quote checkpoint')
  assertProspectiveClock(latest.checkpoint, (options.now ?? (() => new Date()))().toISOString())
  const status = verifyNearLive({ out: nearLiveOut, source, liveOut })
  if (!status.completeToFirstLive)
    return {
      status: 'waiting',
      reason: 'near_live_suffix_incomplete',
      throughBlock: status.throughBlock,
      quoteBlock: latest.checkpoint.block.number,
    }
  return issueLatest({ ...options, out, quoteOut, liveOut, nearLiveOut, source, quoteSource })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args[0] && !['--verify', '--run', '--run-if-ready'].includes(args[0])))
      throw new Error(
        'Usage: node curve-vault-flow-composite-feature-issues.mjs [--verify|--run|--run-if-ready]',
      )
    if (args[0] === '--run') console.log(JSON.stringify(issueLatest()))
    else if (args[0] === '--run-if-ready') console.log(JSON.stringify(runIfReady()))
    else console.log(JSON.stringify({ ...verifyIssues(), mode: 'dry-verify' }))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
