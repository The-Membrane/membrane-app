// Frozen first-five cUSDS holder withdrawal replay. `--plan` and `--verify offline`
// never query outcome blocks. `--run` is deliberately separate and resumable.
// Runtime hashes cover Comet/Base. Comet's EIP-1967 implementation address and
// implementation code are also pinned at both blocks; a stable proxy runtime
// alone is not evidence of stable withdrawal logic. An unrecognized delegatecall
// path or non-EIP-1967 Base upgrade remains outside this narrow identity check.
// node scripts/research/cusds-holder-withdraw-first5.mjs --plan
// node scripts/research/cusds-holder-withdraw-first5.mjs --run --max-events 1
// node scripts/research/cusds-holder-withdraw-first5.mjs --verify offline
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  BASE,
  COMET,
  DISK_FLOOR_BYTES,
  ONSETS,
  Q,
  digest,
  summarize,
  validateCheckpoint as validateHolderCheckpoint,
} from './cusds-holder-feasibility-first5.mjs'

export const STUDY = 'cusds-holder-withdraw-first5-v1'
export const INPUT_SHA256 = 'adb34fc7d9f63bf68a1e06151d77ba2e4678378041a6678f9f327eeca18585f1'
export const DEFAULT_INPUT = resolve(
  'data/research/venue-signals/cusds-holder-feasibility-first5-v2.json',
)
export const DEFAULT_OUT = resolve(
  'data/research/venue-signals/cusds-holder-withdraw-first5-v1.json',
)
export const CALL_GAS = 5_000_000n
export const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function isWithdrawPaused() view returns (bool)',
  'function withdraw(address asset, uint256 amount)',
])
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^\d+$/
const lower = (value) => value?.toLowerCase()
const shaBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
const safeNumber = (value) => {
  const number = Number(BigInt(value))
  if (!Number.isSafeInteger(number)) throw new Error('Unsafe RPC integer')
  return number
}

export function freezeInput(path = DEFAULT_INPUT) {
  const bytes = readFileSync(path)
  const sha256 = shaBytes(bytes)
  if (sha256 !== INPUT_SHA256) throw new Error(`Frozen holder input SHA mismatch: ${sha256}`)
  const payload = validateHolderCheckpoint(JSON.parse(bytes.toString('utf8')))
  if (payload.status !== 'complete') throw new Error('Frozen holder input is incomplete')
  const rows = summarize(payload)
  if (!rows.every((row) => row.status === 'holder' && row.holder))
    throw new Error('Frozen first-five holder cohort has unresolved row')
  return {
    inputSha256: sha256,
    inputPayloadSha256: digest(payload),
    rows: rows.map((row) => ({
      onset: row.onset,
      preBlock: row.preBlock,
      preHash: payload.probes[row.onset].blockHash,
      holder: row.holder.address,
      frozenBalanceRaw: row.holder.balanceRaw,
      candidateCount: row.candidateCount,
      qualifiedCount: row.qualifiedCount,
    })),
  }
}

function identity(frozen) {
  return {
    study: STUDY,
    chainId: 1,
    comet: COMET,
    base: BASE,
    onsets: [...ONSETS],
    qRaw: Q.toString(),
    inputSha256: frozen.inputSha256,
    inputPayloadSha256: frozen.inputPayloadSha256,
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
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  renameSync(tmp, path)
}
function diskOk(path) {
  const dir = existsSync(dirname(path)) ? dirname(path) : resolve('.')
  const stat = statfsSync(dir)
  if (stat.bavail * stat.bsize < DISK_FLOOR_BYTES)
    throw new Error('Disk floor <2.5 GiB; stopped safely')
}
function validStage(stage, block, expectedHash = null) {
  if (!stage) return true
  if (
    stage.block !== block ||
    !HASH.test(stage.blockHash) ||
    (expectedHash && stage.blockHash !== expectedHash)
  )
    return false
  if (!['success', 'revert', 'attrition', 'provider-error'].includes(stage.status)) return false
  if (!RAW.test(stage.balanceRaw) || !RAW.test(stage.cashRaw) || typeof stage.paused !== 'boolean')
    return false
  if (
    !['comet', 'base'].every(
      (name) =>
        HASH.test(stage.code?.[name]?.hash) &&
        Number.isSafeInteger(stage.code[name].bytes) &&
        stage.code[name].bytes > 0,
    )
  )
    return false
  if (
    !HASH.test(stage.code?.cometImplementation?.hash) ||
    !/^0x[0-9a-f]{40}$/.test(stage.code.cometImplementation.address) ||
    !Number.isSafeInteger(stage.code.cometImplementation.bytes) ||
    stage.code.cometImplementation.bytes < 1 ||
    ![null, 'object'].includes(
      stage.code.baseImplementation === null ? null : typeof stage.code.baseImplementation,
    )
  )
    return false
  if (
    stage.code.baseImplementation &&
    (!HASH.test(stage.code.baseImplementation.hash) ||
      !/^0x[0-9a-f]{40}$/.test(stage.code.baseImplementation.address) ||
      !Number.isSafeInteger(stage.code.baseImplementation.bytes) ||
      stage.code.baseImplementation.bytes < 1)
  )
    return false
  if (stage.status === 'revert' && (!stage.error || typeof stage.error.message !== 'string'))
    return false
  if (
    stage.status === 'provider-error' &&
    (!stage.error || typeof stage.error.message !== 'string')
  )
    return false
  if (stage.status === 'attrition' && BigInt(stage.balanceRaw) >= Q) return false
  if (stage.status === 'success' && BigInt(stage.balanceRaw) < Q) return false
  return true
}
export function classify(pre, post) {
  if (!pre || !post) return 'pending'
  if (pre.status === 'provider-error' || post.status === 'provider-error') return 'provider-error'
  if (
    pre.code.comet.hash !== post.code.comet.hash ||
    pre.code.base.hash !== post.code.base.hash ||
    pre.code.cometImplementation.address !== post.code.cometImplementation.address ||
    pre.code.cometImplementation.hash !== post.code.cometImplementation.hash ||
    pre.code.baseImplementation?.address !== post.code.baseImplementation?.address ||
    pre.code.baseImplementation?.hash !== post.code.baseImplementation?.hash
  )
    return 'code-change'
  if (pre.status === 'attrition' || post.status === 'attrition') return 'holder-attrition'
  if (pre.status === 'revert') return 'preexisting-revert'
  if (post.status === 'success') return 'success'
  if (post.status !== 'revert') throw new Error('Unexpected post-withdraw stage')
  if (post.paused) return 'pause'
  // Low cash alone is only a necessary-condition proxy, not a revert diagnosis.
  // Reserve this label for an actual withdraw revert with an explicit balance/
  // transfer failure reason AND independently low pinned Comet token balance.
  if (BigInt(post.cashRaw) < Q && isExplicitCashRevert(post.error)) return 'insufficient-cash'
  return 'other-revert'
}
export function validateOutcomeCheckpoint(saved, frozen) {
  if (!saved || digest(saved.payload) !== saved.sha256)
    throw new Error('Outcome checkpoint SHA mismatch')
  const payload = saved.payload
  for (const [key, value] of Object.entries(identity(frozen)))
    if (JSON.stringify(payload[key]) !== JSON.stringify(value))
      throw new Error(`Outcome checkpoint identity mismatch: ${key}`)
  if (!Array.isArray(payload.results) || payload.results.length !== ONSETS.length)
    throw new Error('Outcome checkpoint row count mismatch')
  for (let i = 0; i < ONSETS.length; i++) {
    const row = payload.results[i]
    const frozenRow = frozen.rows[i]
    if (
      row.onset !== frozenRow.onset ||
      !validStage(row.pre, frozenRow.preBlock, frozenRow.preHash) ||
      !validStage(row.post, row.onset)
    )
      throw new Error('Outcome checkpoint stage invalid')
    if (row.post && !row.pre) throw new Error('Outcome post-stage precedes pre-stage')
    if (row.verdict !== undefined && row.verdict !== classify(row.pre, row.post))
      throw new Error('Outcome checkpoint verdict mismatch')
  }
  if (!['partial', 'complete'].includes(payload.status))
    throw new Error('Outcome checkpoint status invalid')
  if (
    payload.status === 'complete' &&
    payload.results.some((row) =>
      ['pending', 'provider-error'].includes(classify(row.pre, row.post)),
    )
  )
    throw new Error('Outcome checkpoint is not complete')
  return payload
}
export function loadOutcomeCheckpoint(out, frozen) {
  return existsSync(out)
    ? validateOutcomeCheckpoint(JSON.parse(readFileSync(out, 'utf8')), frozen)
    : initial(frozen)
}
function save(out, payload) {
  diskOk(out)
  atomic(out, envelope(payload))
}

function errorEvidence(error) {
  const candidates = []
  let node = error
  for (let depth = 0; node && depth < 6; depth++, node = node.cause) candidates.push(node)
  const data = candidates
    .map((candidate) => candidate.data)
    .find((value) => typeof value === 'string' && /^0x[0-9a-f]*$/i.test(value))
  const code = candidates
    .map((candidate) => candidate.code)
    .find((value) => typeof value === 'number' || typeof value === 'string')
  // Viem often puts "execution reverted" only in a nested cause/details; the
  // top-level shortMessage may merely say that the contract call failed.
  const messages = [
    ...new Set(
      candidates.flatMap((candidate) =>
        [candidate.shortMessage, candidate.details, candidate.message]
          .filter((part) => typeof part === 'string' && part)
          .map((part) =>
            part.split(/\r?\n/, 1)[0].replace(/https?:\/\/[^\s|]+/gi, '[redacted-url]'),
          ),
      ),
    ),
  ]
  const message = (messages.length ? messages.join(' | ') : String(error)).slice(0, 4096)
  return {
    message,
    ...(code === undefined ? {} : { code: String(code) }),
    ...(data ? { data } : {}),
  }
}
export function isRevertError(evidence) {
  return (
    /execution reverted|reverted with|revert:|vm exception.*revert/i.test(evidence.message) ||
    (evidence.code === '3' && !!evidence.data)
  )
}
export function isExplicitCashRevert(evidence) {
  return /ERC20InsufficientBalance|transfer amount exceeds balance|insufficient (token )?balance/i.test(
    evidence?.message || '',
  )
}
function rememberError(row, stage, error) {
  row.errorHistory ||= []
  row.errorHistory.push({ stage, error })
  if (row.errorHistory.length > 20) row.errorHistory.shift()
}
async function pinnedRead(client, address, abi, functionName, args, blockHash) {
  const hex = await client.request({
    method: 'eth_call',
    params: [
      { to: address, data: encodeFunctionData({ abi, functionName, args }) },
      { blockHash, requireCanonical: true },
    ],
  })
  return decodeFunctionResult({ abi, functionName, data: hex })
}
async function pinnedCode(client, address, blockHash) {
  const hex = await client.request({
    method: 'eth_getCode',
    params: [address, { blockHash, requireCanonical: true }],
  })
  if (typeof hex !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(hex))
    throw new Error('Missing or invalid pinned runtime code')
  const code = lower(hex)
  return { hash: keccak256(code), bytes: (code.length - 2) / 2 }
}
async function pinnedImplementation(client, address, blockHash, required) {
  const word = lower(
    await client.request({
      method: 'eth_getStorageAt',
      params: [address, EIP1967_IMPLEMENTATION_SLOT, { blockHash, requireCanonical: true }],
    }),
  )
  if (!/^0x[0-9a-f]{64}$/.test(word) || !/^0x0{24}/.test(word))
    throw new Error('Invalid pinned EIP-1967 implementation slot')
  const implAddress = `0x${word.slice(26)}`
  if (implAddress === `0x${'0'.repeat(40)}`) {
    if (required) throw new Error('Missing Comet EIP-1967 implementation')
    return null
  }
  return { address: implAddress, ...(await pinnedCode(client, implAddress, blockHash)) }
}
export async function probeStage(client, { block, blockHash, holder }) {
  const pinned = { blockHash, requireCanonical: true }
  const [balance, cash, paused, cometCode, baseCode, cometImplementation, baseImplementation] =
    await Promise.all([
      pinnedRead(client, COMET, ABI, 'balanceOf', [holder], blockHash),
      pinnedRead(client, BASE, ABI, 'balanceOf', [COMET], blockHash),
      pinnedRead(client, COMET, ABI, 'isWithdrawPaused', [], blockHash),
      pinnedCode(client, COMET, blockHash),
      pinnedCode(client, BASE, blockHash),
      pinnedImplementation(client, COMET, blockHash, true),
      pinnedImplementation(client, BASE, blockHash, false),
    ])
  const common = {
    block,
    blockHash,
    balanceRaw: balance.toString(),
    cashRaw: cash.toString(),
    paused,
    code: { comet: cometCode, base: baseCode, cometImplementation, baseImplementation },
  }
  if (balance < Q) return { ...common, status: 'attrition' }
  try {
    await client.request({
      method: 'eth_call',
      params: [
        {
          from: holder,
          to: COMET,
          data: encodeFunctionData({ abi: ABI, functionName: 'withdraw', args: [BASE, Q] }),
          gas: `0x${CALL_GAS.toString(16)}`,
        },
        pinned,
      ],
    })
    return { ...common, status: 'success' }
  } catch (error) {
    const evidence = errorEvidence(error)
    return {
      ...common,
      status: isRevertError(evidence) ? 'revert' : 'provider-error',
      error: evidence,
    }
  }
}
export async function assertCanonicalSavedPosts(client, saved) {
  for (const row of saved.results) {
    if (!row.post) continue
    const header = await client.getBlock({ blockNumber: BigInt(row.onset) })
    if (safeNumber(header.number) !== row.onset || lower(header.hash) !== row.post.blockHash)
      throw new Error(`Saved B hash differs from current canonical header at ${row.onset}`)
  }
}

export async function run({
  input = DEFAULT_INPUT,
  out = DEFAULT_OUT,
  client,
  maxEvents = 0,
  checkDisk = diskOk,
} = {}) {
  if (!input.startsWith('/') || !out.startsWith('/'))
    throw new Error('Input/output paths must be absolute')
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 0 || maxEvents > ONSETS.length)
    throw new Error('max-events must be 0..5')
  const frozen = freezeInput(input)
  const saved = loadOutcomeCheckpoint(out, frozen)
  if (maxEvents && !client) throw new Error('RPC client required')
  if (maxEvents) {
    const chainId = await client.request({ method: 'eth_chainId', params: [] })
    if (safeNumber(chainId) !== 1) throw new Error('RPC chainId is not Ethereum mainnet')
    await assertCanonicalSavedPosts(client, saved)
  }
  let processed = 0
  for (let i = 0; i < saved.results.length && processed < maxEvents; i++) {
    const row = saved.results[i]
    const previousVerdict = classify(row.pre, row.post)
    if (previousVerdict !== 'pending' && previousVerdict !== 'provider-error') continue
    const source = frozen.rows[i]
    checkDisk(out)
    if (row.pre?.status === 'provider-error') {
      rememberError(row, 'pre', row.pre.error)
      row.pre = null
      row.post = null
      delete row.verdict
    }
    if (row.post?.status === 'provider-error') {
      rememberError(row, 'post', row.post.error)
      row.post = null
      delete row.verdict
    }
    // Numbered block lookup is identity-only; every state call uses the pinned hash.
    const preHeader = await client.getBlock({ blockNumber: BigInt(source.preBlock) })
    if (
      safeNumber(preHeader.number) !== source.preBlock ||
      lower(preHeader.hash) !== source.preHash
    )
      throw new Error('Frozen B-1 block hash disagrees with provider')
    if (!row.pre) {
      try {
        const pre = await probeStage(client, {
          block: source.preBlock,
          blockHash: source.preHash,
          holder: source.holder,
        })
        if (pre.balanceRaw !== source.frozenBalanceRaw)
          throw new Error('Frozen B-1 holder balance disagrees with outcome replay')
        row.pre = pre
        delete row.readError
      } catch (error) {
        // A failed pinned diagnostic read is a provider/read error, not a venue revert.
        row.readError = { stage: 'pre', ...errorEvidence(error) }
        rememberError(row, 'pre-read', row.readError)
        save(out, saved)
        processed++
        continue
      }
      save(out, saved)
    }
    if (row.pre.status === 'provider-error') {
      processed++
      continue
    }
    const postHeader = await client.getBlock({ blockNumber: BigInt(source.onset) })
    if (safeNumber(postHeader.number) !== source.onset || !HASH.test(lower(postHeader.hash)))
      throw new Error('B block header invalid')
    if (!row.post) {
      try {
        row.post = await probeStage(client, {
          block: source.onset,
          blockHash: lower(postHeader.hash),
          holder: source.holder,
        })
      } catch (error) {
        row.readError = { stage: 'post', ...errorEvidence(error) }
        rememberError(row, 'post-read', row.readError)
        save(out, saved)
        processed++
        continue
      }
      delete row.readError
      row.verdict = classify(row.pre, row.post)
      save(out, saved)
    }
    processed++
  }
  saved.status = saved.results.every(
    (row) => !['pending', 'provider-error'].includes(classify(row.pre, row.post)),
  )
    ? 'complete'
    : 'partial'
  if (existsSync(out) || maxEvents) save(out, saved)
  return {
    path: out,
    status: saved.status,
    processed,
    rows: saved.results.map((row) => ({
      onset: row.onset,
      verdict: classify(row.pre, row.post),
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
  const input = opts.input ? resolve(opts.input) : DEFAULT_INPUT
  const out = opts.out ? resolve(opts.out) : DEFAULT_OUT
  if (mode === '--plan') {
    const frozen = freezeInput(input)
    const saved = loadOutcomeCheckpoint(out, frozen)
    console.log(
      JSON.stringify({
        ...identity(frozen),
        path: out,
        rows: saved.results.map((row) => ({
          onset: row.onset,
          verdict: classify(row.pre, row.post),
        })),
      }),
    )
  } else if (mode === '--verify') {
    if (!existsSync(out)) throw new Error('No outcome checkpoint to verify')
    const frozen = freezeInput(input)
    const saved = loadOutcomeCheckpoint(out, frozen)
    console.log(
      JSON.stringify({
        valid: true,
        sha256: digest(saved),
        status: saved.status,
        rows: saved.results.map((row) => ({
          onset: row.onset,
          verdict: classify(row.pre, row.post),
        })),
      }),
    )
  } else {
    const maxEvents = Number(opts['max-events'] ?? 0)
    const client = maxEvents
      ? makeClient(opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
      : null
    console.log(JSON.stringify(await run({ input, out, client, maxEvents })))
  }
}
