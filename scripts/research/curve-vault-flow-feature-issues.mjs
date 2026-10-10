// Immutable, offline as-of features at a verified nominal Curve quote block.
// Vault events are observed flow context, never proof of a holder withdrawal/fill.
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
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity as quoteIdentity,
} from './curve-prospective-quote.mjs'
import {
  OUT as FLOW_OUT,
  readValidatedReceipts,
  sourceIdentity as flowIdentity,
} from './curve-vault-flow-ledger.mjs'
import { computeFlowFeatures } from './curve-vault-flow-features.mjs'

export const STUDY = 'scrvusd-vault-flow-feature-issues-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-vault-flow-feature-issues')
const SHA = /^[0-9a-f]{64}$/
const HOUR = 3600
const RESERVE_BYTES = 1_073_741_824
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ sha256: _seal, ...payload }) => payload
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })

function nameFor(block) {
  return `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
}

function flowName(receipt) {
  const { from, to } = receipt.range
  return `${String(from.number).padStart(12, '0')}-${String(to.number).padStart(12, '0')}-${to.hash.slice(2)}.json`
}

function exactPrefix(receipts, block) {
  const prefix = receipts.filter((receipt) => receipt.range.to.number <= block.number)
  const end = prefix.at(-1)?.range.to
  if (end?.number !== block.number || end.hash !== block.hash || end.timestamp !== block.timestamp)
    throw new Error('Vault flow ledger does not end exactly at quote checkpoint')
  return prefix
}

function receiptRefs(prefix, flowOut) {
  return prefix.map((receipt) => {
    const filename = flowName(receipt)
    const physicalSha256 = sha(readFileSync(join(flowOut, filename)))
    if (!SHA.test(receipt.sha256)) throw new Error('Missing logical vault flow seal')
    return { filename, sha256: receipt.sha256, physicalSha256 }
  })
}

export function buildIssue({ checkpointRow, receipts, source, issuedAtUtc, flowOut = FLOW_OUT }) {
  const p = checkpointRow?.checkpoint
  const block = p?.block
  const issueMs = Date.parse(issuedAtUtc)
  const captureMs = Date.parse(p?.captureEndUtc)
  if (
    !block ||
    !SHA.test(p.sha256 || '') ||
    !SHA.test(checkpointRow.physicalSha256 || '') ||
    !SHA.test(source?.identitySha256 || '') ||
    !Number.isFinite(issueMs) ||
    !Number.isFinite(captureMs) ||
    issueMs < captureMs ||
    issueMs - captureMs > 2 * HOUR * 1000 ||
    issueMs >= (block.timestamp + 24 * HOUR) * 1000
  )
    throw new Error('Flow feature issue clock or checkpoint provenance invalid')
  const prefix = exactPrefix(receipts, block)
  const features = computeFlowFeatures({
    checkpointRow,
    receipts: prefix,
    source,
    asOfUtc: issuedAtUtc,
  })
  if (features.status !== 'observed')
    throw new Error(`Aligned flow features unavailable: ${features.reason}`)
  const refs = receiptRefs(prefix, flowOut)
  return seal({
    study: STUDY,
    issuedAtUtc,
    source: {
      quoteStudy: p.study,
      quoteSourceIdentitySha256: p.source.identitySha256,
      quoteCheckpointSha256: p.sha256,
      quotePhysicalSha256: checkpointRow.physicalSha256,
      quoteFilename: checkpointRow.filename,
      flowStudy: prefix.at(-1).study,
      flowSourceIdentitySha256: source.identitySha256,
      flowEndpointReceiptSha256: prefix.at(-1).sha256,
      flowEndpointPhysicalSha256: refs.at(-1).physicalSha256,
      flowReceipts: refs,
    },
    block,
    features,
    caveats: [
      'One RPC provider supplied and cross-checked the complete Deposit/Withdraw ranges; independent-provider completeness is unverified.',
      'Vault events are observed flow context only, not holder withdrawal eligibility, executable exit size, or fill.',
      'Maximum observed complete-window flow is not future runway or a protocol maximum.',
    ],
  })
}

export function verifyIssues({ out = OUT, checkpoints, receipts, source, flowOut = FLOW_OUT }) {
  if (!existsSync(out)) return { issues: 0 }
  const byName = new Map(checkpoints.map((row) => [row.filename, row]))
  const files = readdirSync(out).filter((name) => name.endsWith('.json'))
  for (const filename of files) {
    const saved = JSON.parse(readFileSync(join(out, filename), 'utf8'))
    if (!saved || saved.sha256 !== sha(JSON.stringify(unsigned(saved))))
      throw new Error('Flow feature issue SHA mismatch')
    const checkpointRow = byName.get(saved.source?.quoteFilename)
    if (!checkpointRow || filename !== nameFor(saved.block) || saved.study !== STUDY)
      throw new Error('Flow feature issue checkpoint or filename mismatch')
    const expected = buildIssue({
      checkpointRow,
      receipts,
      source,
      issuedAtUtc: saved.issuedAtUtc,
      flowOut,
    })
    if (JSON.stringify(expected) !== JSON.stringify(saved))
      throw new Error('Flow feature issue as-of replay or source mismatch')
  }
  return { issues: files.length }
}

function diskGuard(out, stat = statfsSync, extra = 0) {
  let path = out
  while (!existsSync(path)) {
    const parent = dirname(path)
    if (parent === path) throw new Error('No output filesystem ancestor')
    path = parent
  }
  const fs = stat(path)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Flow feature issue disk reserve reached')
}

function append(out, issue, stat = statfsSync) {
  const bytes = JSON.stringify(issue) + '\n'
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
  checkpoints,
  receipts,
  source,
  flowOut = FLOW_OUT,
  now = () => new Date(),
  stat = statfsSync,
}) {
  verifyIssues({ out, checkpoints, receipts, source, flowOut })
  const checkpointRow = checkpoints.at(-1)
  if (!checkpointRow) throw new Error('No validated quote checkpoint')
  const tip = receipts.at(-1)?.range.to
  const block = checkpointRow.checkpoint.block
  if (tip?.number !== block.number || tip.hash !== block.hash || tip.timestamp !== block.timestamp)
    throw new Error('Current vault flow tip is not the latest quote checkpoint')
  const path = join(out, nameFor(checkpointRow.checkpoint.block))
  if (existsSync(path)) return { path, status: 'existing' }
  const issue = buildIssue({
    checkpointRow,
    receipts,
    source,
    issuedAtUtc: now().toISOString(),
    flowOut,
  })
  append(out, issue, stat)
  return { path, status: 'issued', featureStatus: issue.features.status }
}

function inputs() {
  const source = flowIdentity()
  return {
    checkpoints: readValidatedCheckpoints({ out: QUOTE_OUT, identity: quoteIdentity() }),
    receipts: readValidatedReceipts({ out: FLOW_OUT, source }),
    source,
    flowOut: FLOW_OUT,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args[0] && !['--run', '--verify'].includes(args[0])))
      throw new Error('Usage: node curve-vault-flow-feature-issues.mjs [--verify|--run]')
    const data = inputs()
    const verified = verifyIssues({ out: OUT, ...data })
    if (args[0] === '--run')
      console.log(JSON.stringify({ ...verified, ...issueLatest({ out: OUT, ...data }) }))
    else console.log(JSON.stringify({ ...verified, mode: 'dry-verify' }))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
