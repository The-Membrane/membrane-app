// Post-result EXPLORATORY replay at the first exact $1m cash crossing in each
// of five cUSDS grid windows. Holders were chosen at a LATER grid B-1, not at
// crossing C-1: same-holder results here are post-selection diagnostics, never
// a pre-emptive alert or a representative withdrawal-failure rate.
// No network calls without explicit --run --max-events N.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { keccak256 } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { BASE, COMET, DISK_FLOOR_BYTES, ONSETS, Q } from './cusds-holder-feasibility-first5.mjs'
import {
  classify,
  freezeInput as freezeHolders,
  probeStage,
} from './cusds-holder-withdraw-first5.mjs'
import {
  evaluate,
  validateCheckpoint as validateCrossings,
} from './cusds-threshold-crossings-first5.mjs'

export const STUDY = 'cusds-crossing-withdraw-first5-exploratory-v1'
export const CROSSINGS_SHA256 = 'fc0480602c22e79f5ca4fed3e78aa5b27279f8f82c0f86da7ad0216d5145acab'
export const HOLDERS_SHA256 = 'adb34fc7d9f63bf68a1e06151d77ba2e4678378041a6678f9f327eeca18585f1'
export const EXACT_BLOCKS = [23252094, 23283840, 23328291, 23489213, 23553435]
export const DEFAULT_CROSSINGS = resolve(
  'data/research/venue-signals/cusds-threshold-crossings-first5.json',
)
export const DEFAULT_HOLDERS = resolve(
  'data/research/venue-signals/cusds-holder-feasibility-first5-v2.json',
)
export const DEFAULT_OUT = resolve(
  'data/research/venue-signals/cusds-crossing-withdraw-first5-v1.json',
)
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^\d+$/
const shaBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
const digest = (value) => shaBytes(JSON.stringify(value))
const lower = (value) => value?.toLowerCase()
const safeNumber = (value) => {
  const number = Number(BigInt(value))
  if (!Number.isSafeInteger(number)) throw new Error('Unsafe RPC integer')
  return number
}

export function freezeInputs(crossingsPath = DEFAULT_CROSSINGS, holdersPath = DEFAULT_HOLDERS) {
  const bytes = readFileSync(crossingsPath)
  const crossingsSha256 = shaBytes(bytes)
  if (crossingsSha256 !== CROSSINGS_SHA256)
    throw new Error(`Frozen crossing SHA mismatch: ${crossingsSha256}`)
  const crossingPayload = validateCrossings(JSON.parse(bytes.toString('utf8')))
  const holders = freezeHolders(holdersPath) // Independently checks HOLDERS_SHA256.
  if (holders.inputSha256 !== HOLDERS_SHA256) throw new Error('Frozen holder SHA mismatch')
  if (
    holders.rows.length !== EXACT_BLOCKS.length ||
    crossingPayload.intervals.length !== EXACT_BLOCKS.length
  )
    throw new Error('Frozen first-five count mismatch')
  const rows = crossingPayload.intervals.map((interval, index) => {
    const result = evaluate(interval)
    const crossing = EXACT_BLOCKS[index]
    const holder = holders.rows[index]
    if (
      result.status !== 'localized' ||
      result.firstCrossingBlock !== crossing ||
      interval.to !== ONSETS[index] ||
      holder.onset !== ONSETS[index]
    )
      throw new Error(`Frozen crossing ${index} is not the expected localized event`)
    const pre = interval.reads[crossing - 1 - interval.from]
    const post = interval.reads[crossing - interval.from]
    if (
      pre?.block !== crossing - 1 ||
      post?.block !== crossing ||
      !HASH.test(pre.blockHash) ||
      !HASH.test(post.blockHash) ||
      BigInt(pre.cashRaw) < Q ||
      BigInt(post.cashRaw) >= Q
    )
      throw new Error('Frozen exact crossing boundary invalid')
    return {
      onset: holder.onset,
      crossing,
      preHash: pre.blockHash,
      postHash: post.blockHash,
      holder: holder.holder,
      laterFrozenBalanceRaw: holder.frozenBalanceRaw,
      preCashRaw: pre.cashRaw,
      postCashRaw: post.cashRaw,
    }
  })
  return { crossingsSha256, holdersSha256: holders.inputSha256, rows }
}

function identity(frozen) {
  return {
    study: STUDY,
    chainId: 1,
    comet: COMET,
    base: BASE,
    qRaw: Q.toString(),
    crossingsSha256: frozen.crossingsSha256,
    holdersSha256: frozen.holdersSha256,
    selectionCaveat:
      'same EOA chosen at later grid B-1; crossing replay is post-result exploratory',
    frozenRows: frozen.rows,
  }
}
function initial(frozen) {
  return {
    ...identity(frozen),
    status: 'partial',
    results: frozen.rows.map((row) => ({
      crossing: row.crossing,
      preCode: null,
      postCode: null,
      pre: null,
      post: null,
    })),
  }
}
function envelope(payload) {
  return { payload, sha256: digest(payload) }
}
function diskOk(path) {
  const dir = existsSync(dirname(path)) ? dirname(path) : resolve('.')
  const stat = statfsSync(dir)
  if (stat.bavail * stat.bsize < DISK_FLOOR_BYTES)
    throw new Error('Disk floor <2.5 GiB; stopped safely')
}
function save(path, payload, checkDisk = diskOk) {
  checkDisk(path)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(envelope(payload)), { mode: 0o600 })
  renameSync(temp, path)
}

// Never persist raw provider messages: they can include an RPC URL or API key.
// The only retained reason text is an allowlisted semantic tag used by classify.
export function sanitizeStage(stage) {
  if (!stage?.error) return stage
  const message = stage.error.message || ''
  const reason = /Usds\/insufficient-balance/i.test(message)
    ? 'insufficient balance'
    : /ERC20InsufficientBalance/i.test(message)
      ? 'ERC20InsufficientBalance'
      : /transfer amount exceeds balance/i.test(message)
        ? 'transfer amount exceeds balance'
        : /insufficient (token )?balance/i.test(message)
          ? 'insufficient balance'
          : stage.status === 'revert'
            ? 'execution reverted (unclassified)'
            : 'provider-error (unclassified)'
  return { ...stage, error: { message: reason } }
}
function validStage(stage, block, hash) {
  if (!stage) return true
  if (stage.block !== block || stage.blockHash !== hash) return false
  if (!['success', 'revert', 'attrition', 'provider-error'].includes(stage.status)) return false
  if (!RAW.test(stage.balanceRaw) || !RAW.test(stage.cashRaw) || typeof stage.paused !== 'boolean')
    return false
  if (!HASH.test(stage.code?.comet?.hash) || !HASH.test(stage.code?.base?.hash)) return false
  if (!HASH.test(stage.code?.cometImplementation?.hash)) return false
  if (stage.status === 'attrition' && BigInt(stage.balanceRaw) >= Q) return false
  if (stage.status === 'success' && BigInt(stage.balanceRaw) < Q) return false
  if (stage.error && JSON.stringify(stage.error) !== JSON.stringify(sanitizeStage(stage).error))
    return false
  if (['revert', 'provider-error'].includes(stage.status) && !stage.error) return false
  return true
}
function validHolderCode(code, block, hash) {
  return (
    !code ||
    (code.block === block &&
      code.blockHash === hash &&
      Number.isSafeInteger(code.bytes) &&
      code.bytes >= 0 &&
      HASH.test(code.codeHash) &&
      (code.bytes !== 0 || code.codeHash === keccak256('0x')))
  )
}
export function verdict(row) {
  if (!row.preCode || !row.postCode) return 'pending'
  if (row.preCode.bytes > 0) return 'ineligible-contract-at-crossing-pre'
  if (row.postCode.bytes > 0) return 'holder-identity-change'
  if (!row.pre) return 'pending'
  if (row.pre.status === 'attrition') return 'ineligible-at-crossing-pre'
  return classify(row.pre, row.post)
}
export function validateOutcome(enveloped, frozen) {
  if (!enveloped || digest(enveloped.payload) !== enveloped.sha256)
    throw new Error('Crossing outcome checkpoint SHA mismatch')
  const payload = enveloped.payload
  for (const [key, value] of Object.entries(identity(frozen)))
    if (JSON.stringify(payload[key]) !== JSON.stringify(value))
      throw new Error(`Crossing outcome identity mismatch: ${key}`)
  if (!Array.isArray(payload.results) || payload.results.length !== frozen.rows.length)
    throw new Error('Crossing outcome row count mismatch')
  payload.results.forEach((row, index) => {
    const expected = frozen.rows[index]
    if (
      row.crossing !== expected.crossing ||
      !validHolderCode(row.preCode, expected.crossing - 1, expected.preHash) ||
      !validHolderCode(row.postCode, expected.crossing, expected.postHash) ||
      !validStage(row.pre, expected.crossing - 1, expected.preHash) ||
      !validStage(row.post, expected.crossing, expected.postHash) ||
      (row.pre && row.preCode?.bytes !== 0) ||
      (row.post && row.postCode?.bytes !== 0) ||
      (row.pre && row.pre.cashRaw !== expected.preCashRaw) ||
      (row.post && row.post.cashRaw !== expected.postCashRaw) ||
      (row.post && !row.pre) ||
      (row.pre?.status === 'attrition' && row.post)
    )
      throw new Error('Crossing outcome stage invalid')
  })
  if (!['partial', 'complete'].includes(payload.status)) throw new Error('Invalid outcome status')
  if (
    payload.status === 'complete' &&
    payload.results.some((row) => ['pending', 'provider-error'].includes(verdict(row)))
  )
    throw new Error('Crossing outcome falsely complete')
  return payload
}
export function loadOutcome(out, frozen) {
  return existsSync(out)
    ? validateOutcome(JSON.parse(readFileSync(out, 'utf8')), frozen)
    : initial(frozen)
}
async function assertHeader(client, block, expectedHash) {
  const header = await client.getBlock({ blockNumber: BigInt(block) })
  if (safeNumber(header.number) !== block || lower(header.hash) !== expectedHash)
    throw new Error(`Canonical header mismatch at ${block}`)
}
export async function pinnedHolderCode(client, holder, block, blockHash) {
  const hex = await client.request({
    method: 'eth_getCode',
    params: [holder, { blockHash, requireCanonical: true }],
  })
  if (typeof hex !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(hex))
    throw new Error('Invalid pinned holder code')
  const code = lower(hex)
  return { block, blockHash, bytes: (code.length - 2) / 2, codeHash: keccak256(code) }
}
export async function run({
  crossingsPath = DEFAULT_CROSSINGS,
  holdersPath = DEFAULT_HOLDERS,
  out = DEFAULT_OUT,
  client,
  maxEvents = 0,
  checkDisk = diskOk,
} = {}) {
  if (![crossingsPath, holdersPath, out].every((path) => path.startsWith('/')))
    throw new Error('Input/output paths must be absolute')
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 0 || maxEvents > 5)
    throw new Error('max-events must be 0..5')
  const frozen = freezeInputs(crossingsPath, holdersPath)
  const saved = loadOutcome(out, frozen)
  if (maxEvents) {
    if (!client) throw new Error('RPC client required')
    if (safeNumber(await client.request({ method: 'eth_chainId', params: [] })) !== 1)
      throw new Error('RPC is not Ethereum mainnet')
    // A saved result is never trusted on resume until its two canonical hashes
    // still match. All state calls inside probeStage use EIP-1898 block hashes.
    for (let i = 0; i < saved.results.length; i++) {
      const row = saved.results[i]
      const expected = frozen.rows[i]
      if (row.preCode || row.pre)
        await assertHeader(client, expected.crossing - 1, expected.preHash)
      if (row.postCode || row.post) await assertHeader(client, expected.crossing, expected.postHash)
    }
  }
  let processed = 0
  for (let i = 0; i < saved.results.length && processed < maxEvents; i++) {
    const row = saved.results[i]
    if (!['pending', 'provider-error'].includes(verdict(row))) continue
    const expected = frozen.rows[i]
    checkDisk(out)
    if (row.pre?.status === 'provider-error') row.pre = null
    if (row.post?.status === 'provider-error') row.post = null
    for (const [key, block, blockHash] of [
      ['preCode', expected.crossing - 1, expected.preHash],
      ['postCode', expected.crossing, expected.postHash],
    ]) {
      if (row[key]) continue
      await assertHeader(client, block, blockHash)
      try {
        row[key] = await pinnedHolderCode(client, expected.holder, block, blockHash)
        delete row.readError
      } catch {
        row.readError = `${key}-read-failed`
        save(out, saved, checkDisk)
        processed++
        break
      }
      save(out, saved, checkDisk)
    }
    if (!row.preCode || !row.postCode) continue
    if (row.preCode.bytes > 0 || row.postCode.bytes > 0) {
      processed++
      continue
    }
    if (!row.pre) {
      await assertHeader(client, expected.crossing - 1, expected.preHash)
      try {
        row.pre = sanitizeStage(
          await probeStage(client, {
            block: expected.crossing - 1,
            blockHash: expected.preHash,
            holder: expected.holder,
          }),
        )
        delete row.readError
      } catch {
        row.pre = null
        row.readError = 'pre-diagnostic-read-failed'
        save(out, saved, checkDisk)
        processed++
        continue
      }
      if (row.pre.cashRaw !== expected.preCashRaw)
        throw new Error('Frozen pre-crossing cash disagrees with replay')
      save(out, saved, checkDisk)
    }
    if (row.pre.status === 'attrition' || row.pre.status === 'provider-error') {
      processed++
      continue
    }
    if (!row.post) {
      await assertHeader(client, expected.crossing, expected.postHash)
      try {
        row.post = sanitizeStage(
          await probeStage(client, {
            block: expected.crossing,
            blockHash: expected.postHash,
            holder: expected.holder,
          }),
        )
        delete row.readError
      } catch {
        row.post = null
        row.readError = 'post-diagnostic-read-failed'
        save(out, saved, checkDisk)
        processed++
        continue
      }
      if (row.post.cashRaw !== expected.postCashRaw)
        throw new Error('Frozen crossing cash disagrees with replay')
      save(out, saved, checkDisk)
    }
    processed++
  }
  saved.status = saved.results.every((row) => !['pending', 'provider-error'].includes(verdict(row)))
    ? 'complete'
    : 'partial'
  if (existsSync(out) || maxEvents) save(out, saved, checkDisk)
  return {
    path: out,
    status: saved.status,
    processed,
    rows: saved.results.map((row) => ({
      crossing: row.crossing,
      verdict: verdict(row),
      pre: row.pre?.status || null,
      post: row.post?.status || null,
      readError: row.readError || null,
    })),
  }
}

function options(argv) {
  const mode = argv[0]
  if (!['--plan', '--run', '--verify'].includes(mode))
    throw new Error('Expected --plan, --run, or --verify offline')
  if (mode === '--verify' && argv[1] !== 'offline') throw new Error('Use --verify offline')
  const opts = {}
  for (let i = mode === '--verify' ? 2 : 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error('Bad CLI options')
    opts[argv[i].slice(2)] = argv[i + 1]
  }
  return { mode, opts }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { mode, opts } = options(process.argv.slice(2))
  const crossingsPath = opts.crossings ? resolve(opts.crossings) : DEFAULT_CROSSINGS
  const holdersPath = opts.holders ? resolve(opts.holders) : DEFAULT_HOLDERS
  const out = opts.out ? resolve(opts.out) : DEFAULT_OUT
  if (mode === '--plan') {
    console.log(
      JSON.stringify({ ...identity(freezeInputs(crossingsPath, holdersPath)), path: out }),
    )
  } else if (mode === '--verify') {
    if (!existsSync(out)) throw new Error('No crossing outcome checkpoint to verify')
    const frozen = freezeInputs(crossingsPath, holdersPath)
    const saved = loadOutcome(out, frozen)
    console.log(
      JSON.stringify({
        valid: true,
        sha256: digest(saved),
        status: saved.status,
        rows: saved.results.map((row) => ({ crossing: row.crossing, verdict: verdict(row) })),
      }),
    )
  } else {
    const maxEvents = Number(opts['max-events'] ?? 0)
    const client = maxEvents
      ? makeClient(opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
      : null
    console.log(JSON.stringify(await run({ crossingsPath, holdersPath, out, client, maxEvents })))
  }
}
