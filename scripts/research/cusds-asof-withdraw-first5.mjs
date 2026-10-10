// Executable A/B replay for the SHA-pinned, frozen A=B-1,800 holder cohort.
// node scripts/research/cusds-asof-withdraw-first5.mjs --plan
// node scripts/research/cusds-asof-withdraw-first5.mjs --run --max-events 1
// node scripts/research/cusds-asof-withdraw-first5.mjs --verify offline
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeAbiParameters } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  BASE,
  COMET,
  DISK_FLOOR_BYTES,
  ONSETS,
  Q,
  digest,
} from './cusds-holder-feasibility-first5.mjs'
import { classify, isExplicitCashRevert, probeStage } from './cusds-holder-withdraw-first5.mjs'
import {
  DEFAULT_SOURCE as RAW_SOURCE,
  freezeSource as freezeRawSource,
  rowSummary,
  validateAsOfCheckpoint,
} from './cusds-asof-holder-first5.mjs'

export const STUDY = 'cusds-asof-withdraw-first5-v1'
export const INPUT_SHA256 = 'b55600f7b45d4267d58caea2bbbc09121175aa29617e2c26d3676ed77e06a30b'
export const DEFAULT_INPUT = resolve('data/research/venue-signals/cusds-asof-holder-first5-v1.json')
export const DEFAULT_OUT = resolve('data/research/venue-signals/cusds-asof-withdraw-first5-v1.json')
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^\d+$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const shaBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function freezeInput(input = DEFAULT_INPUT, rawSource = RAW_SOURCE) {
  const bytes = readFileSync(input)
  if (shaBytes(bytes) !== INPUT_SHA256) throw new Error('Frozen as-of input file SHA mismatch')
  const raw = freezeRawSource(rawSource)
  const payload = validateAsOfCheckpoint(JSON.parse(bytes.toString('utf8')), raw)
  if (payload.phase !== 'frozen') throw new Error('As-of holder selection is not frozen')
  const rows = payload.rows.map((row) => {
    const summary = rowSummary(row)
    if (summary.status !== 'holder' || !summary.holder || !HASH.test(row.blockHash))
      throw new Error('Frozen as-of holder cohort has unresolved row')
    return {
      onset: row.onset,
      asofBlock: row.asofBlock,
      asofHash: row.blockHash,
      holder: summary.holder.address,
      frozenBalanceRaw: summary.holder.balanceRaw,
      candidateCount: summary.candidateCount,
      qualifiedCount: summary.qualifiedCount,
    }
  })
  return {
    inputFileSha256: INPUT_SHA256,
    inputPayloadSha256: digest(payload),
    frozenSelectionSha256: payload.frozenSha256,
    rows,
  }
}
function identity(frozen) {
  return {
    study: STUDY,
    chainId: 1,
    comet: COMET,
    base: BASE,
    qRaw: Q.toString(),
    onsets: [...ONSETS],
    inputFileSha256: frozen.inputFileSha256,
    inputPayloadSha256: frozen.inputPayloadSha256,
    frozenSelectionSha256: frozen.frozenSelectionSha256,
    frozenRows: frozen.rows,
    implementationIdentity: 'comet-eip1967-pinned-base-eip1967-if-present',
  }
}
function initial(frozen) {
  return {
    ...identity(frozen),
    status: 'partial',
    results: frozen.rows.map((row) => ({ onset: row.onset, pre: null, post: null })),
  }
}
function envelope(payload) {
  return { payload, sha256: digest(payload) }
}
function atomic(path, payload) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(envelope(payload)), { mode: 0o600 })
  renameSync(tmp, path)
}
export function diskOk(path) {
  let dir = dirname(path)
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('Output filesystem unavailable')
    dir = parent
  }
  const stat = statfsSync(dir)
  if (stat.bavail * stat.bsize < DISK_FLOOR_BYTES) throw new Error('Disk floor below 2.5 GiB')
}
function save(path, payload, checkDisk) {
  checkDisk(path)
  atomic(path, payload)
}
function safeNumber(value) {
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe RPC integer')
  return n
}

// Provider messages may include credentials. Keep only controlled labels that
// still support a narrow, explicit cash-revert classification.
export function explicitCashEvidence(error) {
  if (isExplicitCashRevert(error) || /\bUsds\/insufficient-balance\b/i.test(error?.message || ''))
    return true
  const data = error?.data
  if (typeof data !== 'string' || !/^0x08c379a0[0-9a-f]+$/i.test(data) || data.length > 4096)
    return false
  try {
    const [reason] = decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}`)
    return (
      isExplicitCashRevert({ message: reason }) || /\bUsds\/insufficient-balance\b/i.test(reason)
    )
  } catch {
    return false
  }
}
export function scrubStage(stage) {
  if (!stage) return stage
  if (!stage.error) return stage
  const cash = stage.status === 'revert' && explicitCashEvidence(stage.error)
  return {
    ...stage,
    error: {
      message:
        stage.status === 'revert'
          ? cash
            ? 'ERC20InsufficientBalance'
            : 'execution reverted'
          : 'provider failure',
    },
  }
}
export function verdict(row) {
  if (row.readError) return 'provider-error'
  // A was already unexecutable. B holder attrition remains a secondary fact,
  // while runtime/implementation changes still take precedence.
  if (row.pre?.status === 'revert' && row.post?.status === 'attrition')
    return classify(row.pre, { ...row.post, status: 'success', balanceRaw: Q.toString() })
  return classify(row.pre, row.post)
}
export const secondaryHolderAttrition = (row) => row.post?.status === 'attrition'
function validCode(code) {
  const validPart = (part) =>
    part && HASH.test(part.hash) && Number.isSafeInteger(part.bytes) && part.bytes > 0
  const validImpl = (part) => part === null || (validPart(part) && ADDRESS.test(part.address))
  return (
    validPart(code?.comet) &&
    validPart(code?.base) &&
    validPart(code?.cometImplementation) &&
    ADDRESS.test(code.cometImplementation.address) &&
    validImpl(code.baseImplementation)
  )
}
function validStage(stage, block, hash = null) {
  if (stage === null) return true
  if (
    !stage ||
    stage.block !== block ||
    !HASH.test(stage.blockHash) ||
    (hash && stage.blockHash !== hash) ||
    !['success', 'revert', 'attrition', 'provider-error'].includes(stage.status) ||
    !RAW.test(stage.balanceRaw) ||
    !RAW.test(stage.cashRaw) ||
    typeof stage.paused !== 'boolean' ||
    !validCode(stage.code)
  )
    return false
  if (stage.status === 'attrition' && BigInt(stage.balanceRaw) >= Q) return false
  if (stage.status !== 'attrition' && BigInt(stage.balanceRaw) < Q) return false
  if (
    stage.status === 'revert' &&
    !['ERC20InsufficientBalance', 'execution reverted'].includes(stage.error?.message)
  )
    return false
  if (stage.status === 'provider-error' && stage.error?.message !== 'provider failure') return false
  if (['success', 'attrition'].includes(stage.status) && stage.error !== undefined) return false
  return true
}
export function validateOutcomeCheckpoint(value, frozen) {
  if (!value || digest(value.payload) !== value.sha256)
    throw new Error('Outcome checkpoint SHA mismatch')
  const saved = value.payload
  for (const [key, expected] of Object.entries(identity(frozen)))
    if (JSON.stringify(saved[key]) !== JSON.stringify(expected))
      throw new Error('Outcome checkpoint identity mismatch')
  if (
    !Array.isArray(saved.results) ||
    saved.results.length !== ONSETS.length ||
    !['partial', 'complete'].includes(saved.status)
  )
    throw new Error('Outcome checkpoint shape invalid')
  for (let i = 0; i < ONSETS.length; i++) {
    const row = saved.results[i],
      source = frozen.rows[i]
    if (
      row?.onset !== source.onset ||
      !validStage(row.pre, source.asofBlock, source.asofHash) ||
      !validStage(row.post, source.onset) ||
      (row.post && !row.pre) ||
      (row.pre && row.pre.balanceRaw !== source.frozenBalanceRaw) ||
      (row.readError &&
        row.readError !== 'pre-read-failed' &&
        row.readError !== 'post-read-failed') ||
      (row.post && row.readError) ||
      (row.verdict !== undefined && row.verdict !== verdict(row))
    )
      throw new Error('Outcome row invalid')
  }
  if (
    saved.status === 'complete' &&
    saved.results.some((row) => ['pending', 'provider-error'].includes(verdict(row)))
  )
    throw new Error('Outcome checkpoint claims complete with unresolved row')
  return saved
}
export function loadOutcomeCheckpoint(out, frozen) {
  return existsSync(out)
    ? validateOutcomeCheckpoint(JSON.parse(readFileSync(out, 'utf8')), frozen)
    : initial(frozen)
}
class HeaderProviderError extends Error {}
async function canonicalHeader(client, block, expectedHash = null) {
  let header
  try {
    header = await client.getBlock({ blockNumber: BigInt(block) })
  } catch {
    throw new HeaderProviderError('Pinned block header read failed')
  }
  const hash = header.hash?.toLowerCase()
  if (
    safeNumber(header.number) !== block ||
    !HASH.test(hash) ||
    (expectedHash && hash !== expectedHash)
  )
    throw new Error('Pinned block header mismatch')
  return hash
}
export async function assertCanonicalSavedBlocks(client, saved, frozen) {
  for (let i = 0; i < saved.results.length; i++) {
    const row = saved.results[i],
      source = frozen.rows[i]
    if (row.pre || row.post) await canonicalHeader(client, source.asofBlock, source.asofHash)
    if (row.post) await canonicalHeader(client, source.onset, row.post.blockHash)
  }
}
export async function run({
  input = DEFAULT_INPUT,
  rawSource = RAW_SOURCE,
  out = DEFAULT_OUT,
  client,
  maxEvents = 0,
  checkDisk = diskOk,
} = {}) {
  if (!input.startsWith('/') || !rawSource.startsWith('/') || !out.startsWith('/'))
    throw new Error('Input/output paths must be absolute')
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 0 || maxEvents > ONSETS.length)
    throw new Error('max-events must be 0..5')
  const frozen = freezeInput(input, rawSource)
  const saved = loadOutcomeCheckpoint(out, frozen)
  if (maxEvents && !client) throw new Error('RPC client required')
  if (maxEvents) {
    if (safeNumber(await client.request({ method: 'eth_chainId', params: [] })) !== 1)
      throw new Error('RPC chainId is not Ethereum mainnet')
    await assertCanonicalSavedBlocks(client, saved, frozen)
  }
  let processed = 0
  for (let i = 0; i < saved.results.length && processed < maxEvents; i++) {
    const row = saved.results[i],
      source = frozen.rows[i]
    if (!['pending', 'provider-error'].includes(verdict(row))) continue
    checkDisk(out)
    if (row.readError === 'pre-read-failed' || row.pre?.status === 'provider-error') {
      row.pre = null
      row.post = null
      delete row.readError
      delete row.verdict
    } else if (row.readError === 'post-read-failed' || row.post?.status === 'provider-error') {
      row.post = null
      delete row.readError
      delete row.verdict
    }
    try {
      await canonicalHeader(client, source.asofBlock, source.asofHash)
    } catch (error) {
      if (!(error instanceof HeaderProviderError)) throw error
      row.readError = 'pre-read-failed'
      save(out, saved, checkDisk)
      processed++
      continue
    }
    if (!row.pre) {
      try {
        const pre = scrubStage(
          await probeStage(client, {
            block: source.asofBlock,
            blockHash: source.asofHash,
            holder: source.holder,
          }),
        )
        if (pre.balanceRaw !== source.frozenBalanceRaw || BigInt(pre.balanceRaw) < Q)
          throw new Error('Frozen A balance mismatch')
        row.pre = pre
      } catch {
        row.readError = 'pre-read-failed'
        save(out, saved, checkDisk)
        processed++
        continue
      }
      save(out, saved, checkDisk)
    }
    if (row.pre.status === 'provider-error') {
      processed++
      continue
    }
    let postHash
    try {
      postHash = await canonicalHeader(client, source.onset, row.post?.blockHash)
    } catch (error) {
      if (!(error instanceof HeaderProviderError)) throw error
      row.readError = 'post-read-failed'
      save(out, saved, checkDisk)
      processed++
      continue
    }
    if (!row.post) {
      try {
        row.post = scrubStage(
          await probeStage(client, {
            block: source.onset,
            blockHash: postHash,
            holder: source.holder,
          }),
        )
      } catch {
        row.readError = 'post-read-failed'
        save(out, saved, checkDisk)
        processed++
        continue
      }
      row.verdict = verdict(row)
      save(out, saved, checkDisk)
    }
    processed++
  }
  saved.status = saved.results.every((row) => !['pending', 'provider-error'].includes(verdict(row)))
    ? 'complete'
    : 'partial'
  if (existsSync(out) || maxEvents) save(out, saved, checkDisk)
  return {
    status: saved.status,
    processed,
    rows: saved.results.map((row) => ({
      onset: row.onset,
      verdict: verdict(row),
      pre: row.pre?.status || null,
      post: row.post?.status || null,
      secondaryHolderAttrition: secondaryHolderAttrition(row),
      readError: row.readError || null,
    })),
  }
}
function options(argv) {
  const mode = argv[0]
  if (
    !['--plan', '--run', '--verify'].includes(mode) ||
    (mode === '--verify' && argv[1] !== 'offline')
  )
    throw new Error('Expected --plan, --run, or --verify offline')
  const opts = {}
  for (let i = mode === '--verify' ? 2 : 1; i < argv.length; i += 2) {
    if (
      !['--input', '--source', '--out', '--max-events'].includes(argv[i]) ||
      argv[i + 1] === undefined
    )
      throw new Error('Invalid CLI option')
    if (opts[argv[i]] !== undefined) throw new Error('Duplicate CLI option')
    opts[argv[i]] = argv[i + 1]
  }
  if (mode !== '--run' && opts['--max-events'] !== undefined)
    throw new Error('max-events is run-only')
  return { mode, opts }
}
async function main() {
  const { mode, opts } = options(process.argv.slice(2))
  const input = opts['--input'] ? resolve(opts['--input']) : DEFAULT_INPUT
  const rawSource = opts['--source'] ? resolve(opts['--source']) : RAW_SOURCE
  const out = opts['--out'] ? resolve(opts['--out']) : DEFAULT_OUT
  const frozen = freezeInput(input, rawSource)
  if (mode === '--verify' && !existsSync(out)) throw new Error('No outcome checkpoint to verify')
  const saved = loadOutcomeCheckpoint(out, frozen)
  if (mode !== '--run') {
    console.log(
      JSON.stringify({
        valid: mode === '--verify' ? true : undefined,
        inputFileSha256: INPUT_SHA256,
        checkpointSha256: existsSync(out) ? digest(saved) : null,
        status: saved.status,
        rows: saved.results.map((row) => ({
          onset: row.onset,
          asofBlock: frozen.rows.find((x) => x.onset === row.onset).asofBlock,
          holder: frozen.rows.find((x) => x.onset === row.onset).holder,
          verdict: verdict(row),
          secondaryHolderAttrition: secondaryHolderAttrition(row),
        })),
      }),
    )
    return
  }
  const maxEvents = Number(opts['--max-events'] ?? 0)
  const client = maxEvents
    ? makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
    : null
  console.log(JSON.stringify(await run({ input, rawSource, out, client, maxEvents })))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('As-of outcome stage failed (details withheld to protect RPC credentials)')
    process.exitCode = 1
  })
