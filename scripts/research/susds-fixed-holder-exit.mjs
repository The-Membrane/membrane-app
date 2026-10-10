// Prospective sUSDS direct-vault exit simulation. Research-only, never a notification.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem'
import {
  IMPLEMENTATION_SLOT,
  OUT as CHECKPOINT_OUT,
  RESERVE_BYTES,
  readValidatedCheckpoints,
  sourceIdentity,
} from './susds-finalized-checkpoint.mjs'
import { OUT as PLAN_OUT, readPlan } from './susds-holder-plan.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'susds-fixed-holder-exit-v1'
export const OUT = resolve('data/research/venue-signals/susds-fixed-holder-exit')
export const MAX_AGE_SECONDS = 3600
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const CODE = /^0x(?:[0-9a-f]{2})+$/
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const CAVEAT =
  'One pinned read-only direct USDS withdrawal simulation for a preselected holder; success is not a transaction guarantee, continuous exit ability, or USDS-to-USDC exit. sUSDS maxWithdraw reflects share accounting, not peer-flow liquidity headroom.'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const seal = (value) => ({ ...value, sha256: sha(JSON.stringify(value)) })
const unsigned = ({ sha256: _sha256, ...rest }) => rest
const issueName = (block) => `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
const checkpointRef = (row) => ({
  filename: row.filename,
  logicalSha256: row.checkpoint.sha256,
  physicalSha256: row.physicalSha256,
  block: row.checkpoint.block,
  vaultCodeHash: row.checkpoint.contract.vaultCodeHash,
  implementation: row.checkpoint.contract.implementation,
  implementationCodeHash: row.checkpoint.contract.implementationCodeHash,
})
const planRef = (plan, bytes) => ({
  logicalSha256: plan.sha256,
  physicalSha256: sha(bytes),
  seed: plan.seed,
  anchor: plan.checkpoint,
  createdUtc: plan.createdUtc,
})
const codeRelation = (plan, row) =>
  plan.checkpoint.vaultCodeHash === row.checkpoint.contract.vaultCodeHash &&
  plan.checkpoint.implementation === row.checkpoint.contract.implementation &&
  plan.checkpoint.implementationCodeHash === row.checkpoint.contract.implementationCodeHash
    ? 'same_as_plan_anchor'
    : 'changed_since_plan_anchor'

export function readSources({
  out = OUT,
  planOut = PLAN_OUT,
  checkpointOut = CHECKPOINT_OUT,
  identity = sourceIdentity(),
  seedOut,
  nowMs = Date.now(),
} = {}) {
  const sourceOptions = { checkpointOut, identity, ...(seedOut ? { seedOut } : {}) }
  const plan = readPlan({ out: planOut, sourceOptions, nowMs })
  if (!plan) return null
  const planBytes = readFileSync(join(planOut, 'plan.json'))
  if (!planBytes.equals(Buffer.from(`${JSON.stringify(plan)}\n`)))
    throw new Error('Plan physical bytes mismatch')
  const checkpoints = readValidatedCheckpoints({ out: checkpointOut, identity })
  return { out, plan, planBytes, checkpoints, identity }
}

export function validateIssue(issue, { sources, nowMs = Date.now() } = {}) {
  if (!sources?.plan || !issue || issue.sha256 !== sha(JSON.stringify(unsigned(issue))))
    throw new Error('Missing or unsealed exit issue')
  const { plan, planBytes, checkpoints, identity } = sources
  const row = checkpoints.find((value) => value.filename === issue.checkpoint?.filename)
  const createdMs = Date.parse(plan.createdUtc)
  const startMs = Date.parse(issue.captureStartUtc)
  const endMs = Date.parse(issue.captureEndUtc)
  const result = issue.result
  if (
    plan.status !== 'selected' ||
    !plan.holder ||
    issue.study !== STUDY ||
    issue.kind !== 'direct-withdraw-simulation' ||
    JSON.stringify(issue.source) !== JSON.stringify(identity) ||
    JSON.stringify(issue.plan) !== JSON.stringify(planRef(plan, planBytes)) ||
    !row ||
    issue.codeRelation !== codeRelation(plan, row) ||
    issue.holder !== plan.holder ||
    issue.rawUsds !== plan.rawUsds ||
    JSON.stringify(issue.checkpoint) !== JSON.stringify(checkpointRef(row)) ||
    issue.checkpoint.block.number <= plan.checkpoint.block.number ||
    issue.checkpoint.block.timestamp * 1000 <= createdMs ||
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    Date.parse(row.checkpoint.captureEndUtc) > startMs ||
    startMs > endMs ||
    endMs > nowMs ||
    startMs < row.checkpoint.block.timestamp * 1000 - 60_000 ||
    endMs - row.checkpoint.block.timestamp * 1000 > MAX_AGE_SECONDS * 1000 ||
    issue.pinMode !== 'hash' ||
    issue.canonicalStatus !== 'verified' ||
    issue.caveat !== CAVEAT ||
    !result ||
    !['success', 'revert', 'provider_ambiguous'].includes(result.status) ||
    JSON.stringify(Object.keys(result).sort()) !==
      JSON.stringify(
        [
          'status',
          'sharesBurnedRaw',
          'balanceSharesRaw',
          'maxWithdrawAssetsRaw',
          'previewSharesRaw',
        ].sort(),
      ) ||
    (result.status === 'success'
      ? !RAW.test(result.sharesBurnedRaw || '')
      : result.sharesBurnedRaw !== null)
  )
    throw new Error('Exit issue source, timing, or outcome mismatch')
  for (const key of ['balanceSharesRaw', 'maxWithdrawAssetsRaw', 'previewSharesRaw'])
    if (result[key] !== null && !RAW.test(result[key] || ''))
      throw new Error('Invalid optional diagnostic')
  return issue
}

export function makeIssue({ sources, checkpointRow, result, captureStartUtc, captureEndUtc }) {
  const issue = seal({
    study: STUDY,
    kind: 'direct-withdraw-simulation',
    source: sources.identity,
    plan: planRef(sources.plan, sources.planBytes),
    codeRelation: codeRelation(sources.plan, checkpointRow),
    holder: sources.plan.holder,
    rawUsds: sources.plan.rawUsds,
    checkpoint: checkpointRef(checkpointRow),
    captureStartUtc,
    captureEndUtc,
    pinMode: 'hash',
    canonicalStatus: 'verified',
    result,
    caveat: CAVEAT,
  })
  return validateIssue(issue, { sources })
}

function guard(out, stat, extra) {
  let ancestor = out
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('No output ancestor')
    ancestor = parent
  }
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('sUSDS holder observation disk reserve reached')
}

async function lock(out) {
  mkdirSync(out, { recursive: true })
  const path = join(out, '.collection.lock')
  const end = Date.now() + 30_000
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 })
      return () => rmdirSync(path)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (Date.now() >= end) throw new Error('sUSDS holder observation lock busy or stale')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

export function verify(options = {}) {
  const sources = readSources(options)
  const dir = join(options.out ?? OUT, 'issues')
  const names = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  if (!sources) {
    if (names.length) throw new Error('Exit issues exist without a plan')
    return { status: 'unavailable', reason: 'no_plan', count: 0 }
  }
  if (sources.plan.status !== 'selected') {
    if (names.length) throw new Error('Exit issues exist without an eligible holder')
    return { status: 'unavailable', reason: 'no_eligible_holder', count: 0 }
  }
  const seen = new Set()
  for (const name of names) {
    const bytes = readFileSync(join(dir, name))
    const issue = validateIssue(JSON.parse(bytes), { sources, nowMs: options.nowMs })
    if (
      !bytes.equals(Buffer.from(`${JSON.stringify(issue)}\n`)) ||
      name !== issueName(issue.checkpoint.block)
    )
      throw new Error('Exit issue physical bytes or filename mismatch')
    if (seen.has(issue.checkpoint.block.number)) throw new Error('Duplicate exit issue height')
    const skipped = sources.checkpoints.find(
      (row) =>
        row.checkpoint.block.number > sources.plan.checkpoint.block.number &&
        row.checkpoint.block.timestamp * 1000 > Date.parse(sources.plan.createdUtc) &&
        row.checkpoint.block.number < issue.checkpoint.block.number &&
        Date.parse(row.checkpoint.captureEndUtc) <= Date.parse(issue.captureStartUtc) &&
        !seen.has(row.checkpoint.block.number),
    )
    if (skipped) throw new Error('Exit issue skips an earlier eligible checkpoint')
    seen.add(issue.checkpoint.block.number)
  }
  return {
    status: 'verified',
    count: names.length,
    latestBlock: names.length ? Math.max(...seen) : null,
  }
}

function safeGet(value, key) {
  try {
    return value?.[key]
  } catch {
    return undefined
  }
}

export function classifyWithdrawFailure(error) {
  const seen = new Set()
  for (let current = error, i = 0; current && i < 8; current = safeGet(current, 'cause'), i++) {
    if (seen.has(current)) break
    seen.add(current)
    const code = safeGet(current, 'code')
    const data = safeGet(current, 'data')
    if (code === 3 && typeof data === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(data))
      return 'revert'
  }
  return 'provider_ambiguous'
}

export async function observe({
  client,
  out = OUT,
  planOut = PLAN_OUT,
  checkpointOut = CHECKPOINT_OUT,
  seedOut,
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  if (!client?.request) throw new Error('One RPC client required')
  guard(out, stat, 0)
  const release = await lock(out)
  try {
    const options = { out, planOut, checkpointOut, seedOut, nowMs: now().getTime() }
    const sources = readSources(options)
    if (!sources) return { status: 'unavailable', reason: 'no_plan' }
    if (sources.plan.status !== 'selected')
      return { status: 'unavailable', reason: 'no_eligible_holder' }
    verify(options)
    const start = now().toISOString()
    const observed = new Set(
      existsSync(join(out, 'issues'))
        ? readdirSync(join(out, 'issues'))
            .filter((name) => name.endsWith('.json'))
            .map((name) => Number(name.slice(0, 12)))
        : [],
    )
    const row = sources.checkpoints.find(
      (value) =>
        value.checkpoint.block.number > sources.plan.checkpoint.block.number &&
        value.checkpoint.block.timestamp * 1000 > Date.parse(sources.plan.createdUtc) &&
        Date.parse(value.checkpoint.captureEndUtc) <= Date.parse(start) &&
        !observed.has(value.checkpoint.block.number),
    )
    if (!row) return { status: 'unavailable', reason: 'no_eligible_unobserved_checkpoint' }
    if (Date.parse(start) - row.checkpoint.block.timestamp * 1000 > MAX_AGE_SECONDS * 1000)
      return {
        status: 'unavailable',
        reason: 'oldest_unobserved_checkpoint_stale',
        block: row.checkpoint.block.number,
      }
    const at = row.checkpoint.block
    const request = (method, params) => client.request({ method, params })
    if (Number(BigInt(await request('eth_chainId', []))) !== 1) throw new Error('Wrong chain')
    const parseBlock = (value) => ({
      number: Number(BigInt(value?.number ?? -1)),
      hash: String(value?.hash || '').toLowerCase(),
      timestamp: Number(BigInt(value?.timestamp ?? -1)),
    })
    const finalized = parseBlock(await request('eth_getBlockByNumber', ['finalized', false]))
    const canonical = async () =>
      parseBlock(await request('eth_getBlockByNumber', [`0x${at.number.toString(16)}`, false]))
    const first = await canonical()
    if (
      finalized.number < at.number ||
      first.number !== at.number ||
      first.hash !== at.hash ||
      first.timestamp !== at.timestamp
    )
      throw new Error('Finalized block identity drift')
    const pin = { blockHash: at.hash, requireCanonical: true }
    const code = String(await request('eth_getCode', [sources.identity.vault, pin])).toLowerCase()
    if (!CODE.test(code) || keccak256(code) !== row.checkpoint.contract.vaultCodeHash)
      throw new Error('Pinned vault code changed')
    const slot = String(
      await request('eth_getStorageAt', [sources.identity.vault, IMPLEMENTATION_SLOT, pin]),
    ).toLowerCase()
    if (slot !== row.checkpoint.contract.implementationSlotWord)
      throw new Error('Pinned implementation slot changed')
    if (row.checkpoint.contract.implementation) {
      const implCode = String(
        await request('eth_getCode', [row.checkpoint.contract.implementation, pin]),
      ).toLowerCase()
      if (
        !CODE.test(implCode) ||
        keccak256(implCode) !== row.checkpoint.contract.implementationCodeHash
      )
        throw new Error('Pinned implementation code changed')
    } else throw new Error('No attested proxy implementation')
    const holderCode = String(
      await request('eth_getCode', [sources.plan.holder, pin]),
    ).toLowerCase()
    if (holderCode !== '0x') throw new Error('Pinned holder no longer EOA')
    const call = async (name, args = [], from) => {
      const data = encodeFunctionData({ abi: ABI, functionName: name, args })
      const value = await request('eth_call', [
        { to: sources.identity.vault, data, ...(from ? { from } : {}) },
        pin,
      ])
      return decodeFunctionResult({ abi: ABI, functionName: name, data: value })
    }
    if (String(await call('asset')).toLowerCase() !== sources.identity.asset)
      throw new Error('Pinned asset changed')
    const optional = async (name, args) => {
      try {
        return String(await call(name, args))
      } catch {
        return null
      }
    }
    const balanceSharesRaw = await optional('balanceOf', [sources.plan.holder])
    const maxWithdrawAssetsRaw = await optional('maxWithdraw', [sources.plan.holder])
    const previewSharesRaw = await optional('previewWithdraw', [BigInt(sources.plan.rawUsds)])
    let status = 'success'
    let sharesBurnedRaw = null
    try {
      sharesBurnedRaw = String(
        await call(
          'withdraw',
          [BigInt(sources.plan.rawUsds), sources.plan.holder, sources.plan.holder],
          sources.plan.holder,
        ),
      )
    } catch (error) {
      status = classifyWithdrawFailure(error)
    }
    const last = await canonical()
    if (last.number !== at.number || last.hash !== at.hash || last.timestamp !== at.timestamp)
      throw new Error('Finalized block drift during observation')
    const issue = makeIssue({
      sources,
      checkpointRow: row,
      result: { status, sharesBurnedRaw, balanceSharesRaw, maxWithdrawAssetsRaw, previewSharesRaw },
      captureStartUtc: start,
      captureEndUtc: now().toISOString(),
    })
    const dir = join(out, 'issues')
    const path = join(dir, issueName(at))
    const bytes = `${JSON.stringify(issue)}\n`
    guard(dir, stat, Buffer.byteLength(bytes))
    mkdirSync(dir, { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
      linkSync(temp, path)
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
    return { status, block: at.number, path }
  } finally {
    release()
  }
}

export function selectRpc(configured, index = '0') {
  if (!/^(0|[1-9][0-9]*)$/.test(index)) throw new Error('Invalid RPC index')
  const hosts = typeof configured === 'string' ? configured.split(',').map((s) => s.trim()) : []
  const position = Number(index)
  if (!Number.isSafeInteger(position) || !hosts[position])
    throw new Error('Configured RPC host missing')
  return hosts[position]
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) return console.log(JSON.stringify({ mode: 'dry', study: STUDY, out: OUT }))
  if (args.length === 1 && args[0] === '--verify') return console.log(JSON.stringify(verify()))
  if (
    args[0] !== '--run' ||
    (args.length !== 1 && (args.length !== 3 || args[1] !== '--rpc-index'))
  )
    throw new Error('Invalid options')
  const configured = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  console.log(
    JSON.stringify(await observe({ client: makeClient(selectRpc(configured, args[2] ?? '0')) })),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error('[susds-fixed-holder-exit] unavailable')
    process.exitCode = 1
  })
