// Prospective, read-only simulations for every sealed scrvUSD cohort member.
// Dry by default. A missing earlier eligible checkpoint stops observation.
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
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity,
} from './curve-prospective-quote.mjs'
import { OUT as PLAN_OUT, readPlan, readSources } from './scrvusd-cohort-plan.mjs'
import { classifyWithdrawFailure } from './scrvusd-fixed-holder-exit.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'scrvusd-cohort-observe-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-cohort-observe')
export const MAX_AGE_MS = 60 * 60 * 1000
const RESERVE_BYTES = 1_073_741_824
const SHA = /^[0-9a-f]{64}$/
const CODE = /^0x(?:[0-9a-f]{2})*$/
const UINT = /^(0|[1-9][0-9]*)$/
const CAVEAT =
  'One hash-pinned read-only RPC simulation per enrolled holder and size. Shared vault and overlapping holders are dependent; provider ambiguity is not a revert. Sampled blocks do not prove continuous exit ability, transaction inclusion, or a calibrated duration.'
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const sha = (v) => createHash('sha256').update(v).digest('hex')
const seal = (v) => ({ ...v, sha256: sha(JSON.stringify(v)) })
const unsigned = ({ sha256: _sha256, ...v }) => v
const ref = (r) => ({
  filename: r.filename,
  logicalSha256: r.checkpoint.sha256,
  physicalSha256: r.physicalSha256,
  block: r.checkpoint.block,
})
const entries = (plan) =>
  plan.strata.flatMap((s) => s.holders.map((holder) => ({ holder, rawCrvUsd: s.rawCrvUsd })))
const keysAre = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort())
const uint = (v) => {
  const n = BigInt(v)
  if (n < 0n) throw new Error('Negative uint')
  return n.toString()
}
const blockTag = (n) => `0x${n.toString(16)}`
const eligible = (r, plan, beforeMs) =>
  r.checkpoint.block.timestamp * 1000 > Date.parse(plan.createdUtc) &&
  Date.parse(r.checkpoint.captureEndUtc) <= beforeMs &&
  r.checkpoint.block.number > plan.checkpoint.block.number
const issueName = (r) =>
  `${String(r.checkpoint.block.number).padStart(12, '0')}-${r.checkpoint.block.hash.slice(2)}.json`

export function makeIssue({
  plan,
  checkpointRow,
  seedVaultCodeHash,
  sourceStatus,
  observedVaultCodeHash,
  observedAsset,
  results,
  captureStartUtc,
  captureEndUtc,
}) {
  return seal({
    study: STUDY,
    kind: 'complete-cohort-simulation',
    planSha256: plan.sha256,
    planPhysicalSha256: plan.physicalSha256,
    source: plan.source,
    checkpoint: ref(checkpointRow),
    captureStartUtc,
    captureEndUtc,
    pinMode: 'hash',
    canonicalStatus: 'verified',
    seedVaultCodeHash,
    sourceStatus,
    observedVaultCodeHash,
    observedAsset,
    results,
    caveat: CAVEAT,
  })
}

export function validateIssue(
  issue,
  { plan, checkpointRows, seedVaultCodeHash, nowMs = Date.now() },
) {
  if (
    !issue ||
    !keysAre(issue, [
      'study',
      'kind',
      'planSha256',
      'planPhysicalSha256',
      'source',
      'checkpoint',
      'captureStartUtc',
      'captureEndUtc',
      'pinMode',
      'canonicalStatus',
      'seedVaultCodeHash',
      'sourceStatus',
      'observedVaultCodeHash',
      'observedAsset',
      'results',
      'caveat',
      'sha256',
    ]) ||
    issue.sha256 !== sha(JSON.stringify(unsigned(issue)))
  )
    throw new Error('Issue seal or schema mismatch')
  const row = checkpointRows.find((r) => r.filename === issue.checkpoint?.filename)
  const start = Date.parse(issue.captureStartUtc),
    end = Date.parse(issue.captureEndUtc)
  if (
    issue.study !== STUDY ||
    issue.kind !== 'complete-cohort-simulation' ||
    issue.planSha256 !== plan.sha256 ||
    issue.planPhysicalSha256 !== plan.physicalSha256 ||
    JSON.stringify(issue.source) !== JSON.stringify(plan.source) ||
    !row ||
    JSON.stringify(issue.checkpoint) !== JSON.stringify(ref(row)) ||
    !eligible(row, plan, start) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    end > nowMs ||
    end - row.checkpoint.block.timestamp * 1000 > MAX_AGE_MS ||
    start < row.checkpoint.block.timestamp * 1000 ||
    issue.pinMode !== 'hash' ||
    issue.canonicalStatus !== 'verified' ||
    issue.seedVaultCodeHash !== seedVaultCodeHash ||
    issue.caveat !== CAVEAT
  )
    throw new Error('Issue provenance or timing mismatch')
  if (
    !['matched', 'drift', 'unavailable'].includes(issue.sourceStatus) ||
    (issue.observedVaultCodeHash !== null &&
      !/^0x[0-9a-f]{64}$/.test(issue.observedVaultCodeHash)) ||
    (issue.observedAsset !== null && !/^0x[0-9a-f]{40}$/.test(issue.observedAsset))
  )
    throw new Error('Vault source status mismatch')
  const expectedSourceStatus =
    (issue.observedVaultCodeHash && issue.observedVaultCodeHash !== seedVaultCodeHash) ||
    (issue.observedAsset && issue.observedAsset !== plan.source.crvUsd)
      ? 'drift'
      : issue.observedVaultCodeHash && issue.observedAsset
        ? 'matched'
        : 'unavailable'
  if (issue.sourceStatus !== expectedSourceStatus) throw new Error('Vault source status mismatch')
  const roster = entries(plan)
  if (!Array.isArray(issue.results) || issue.results.length !== roster.length)
    throw new Error('Partial cohort roster')
  for (let i = 0; i < roster.length; i++) {
    const got = issue.results[i],
      want = roster[i]
    if (
      !keysAre(got, [
        'holder',
        'rawCrvUsd',
        'status',
        'holderCode',
        'balanceSharesRaw',
        'maxWithdrawAssetsRaw',
        'previewSharesRaw',
        'sharesBurnedRaw',
      ]) ||
      got.holder !== want.holder ||
      got.rawCrvUsd !== want.rawCrvUsd ||
      !['success', 'revert', 'provider_error', 'source_drift', 'holder_code_change'].includes(
        got.status,
      ) ||
      (got.holderCode !== null && !CODE.test(got.holderCode)) ||
      ['balanceSharesRaw', 'maxWithdrawAssetsRaw', 'previewSharesRaw'].some(
        (k) => got[k] !== null && !UINT.test(got[k]),
      ) ||
      (got.status === 'success' ? !UINT.test(got.sharesBurnedRaw) : got.sharesBurnedRaw !== null) ||
      (['success', 'revert'].includes(got.status) && got.holderCode !== '0x') ||
      (got.status === 'holder_code_change' && (!got.holderCode || got.holderCode === '0x')) ||
      (issue.sourceStatus !== 'matched' &&
        got.status !== (issue.sourceStatus === 'drift' ? 'source_drift' : 'provider_error')) ||
      (issue.sourceStatus === 'matched' && got.status === 'source_drift')
    )
      throw new Error('Cohort member result mismatch')
  }
  return issue
}

function readContext({
  planOut = PLAN_OUT,
  quoteOut = QUOTE_OUT,
  identity = sourceIdentity(),
} = {}) {
  const plan = readPlan({ out: planOut, sourceOptions: { quoteOut, identity } })
  if (!plan) return null
  const planBytes = readFileSync(join(planOut, 'plan.json'))
  if (!planBytes.equals(Buffer.from(`${JSON.stringify(plan)}\n`)))
    throw new Error('Plan physical mismatch')
  const sources = readSources({ quoteOut, identity, seedFilename: plan.seed.filename })
  if (
    sha(sources.seedBytes) !== plan.seed.physicalSha256 ||
    sources.seed.sha256 !== plan.seed.logicalSha256
  )
    throw new Error('Seed provenance mismatch')
  const rows = readValidatedCheckpoints({ out: quoteOut, identity })
  return {
    plan: { ...plan, physicalSha256: sha(planBytes) },
    rows,
    seedVaultCodeHash: sources.seed.vaultCodeHash,
  }
}

export function validateSequence(issues, rows, plan) {
  const byBlock = new Map(issues.map((issue) => [issue.checkpoint.block.number, issue]))
  for (const issue of issues) {
    const start = Date.parse(issue.captureStartUtc)
    const missing = rows.filter(
      (r) =>
        eligible(r, plan, start) &&
        r.checkpoint.block.number < issue.checkpoint.block.number &&
        (!byBlock.has(r.checkpoint.block.number) ||
          Date.parse(byBlock.get(r.checkpoint.block.number).captureEndUtc) > start),
    )
    if (missing.length) throw new Error('Skipped earlier eligible checkpoint')
  }
  return issues
}

function readIssues(out, context, nowMs = Date.now()) {
  const dir = join(out, 'issues')
  const names = existsSync(dir)
    ? readdirSync(dir)
        .filter((x) => x.endsWith('.json'))
        .sort()
    : []
  const seen = new Set(),
    issues = []
  for (const name of names) {
    const bytes = readFileSync(join(dir, name)),
      issue = JSON.parse(bytes)
    validateIssue(issue, {
      plan: context.plan,
      checkpointRows: context.rows,
      seedVaultCodeHash: context.seedVaultCodeHash,
      nowMs,
    })
    if (
      !bytes.equals(Buffer.from(`${JSON.stringify(issue)}\n`)) ||
      name !== issueName({ checkpoint: issue.checkpoint }) ||
      seen.has(issue.checkpoint.block.number)
    )
      throw new Error('Issue physical, name, or duplicate mismatch')
    seen.add(issue.checkpoint.block.number)
    issues.push(issue)
  }
  return validateSequence(issues, context.rows, context.plan)
}

export function verify({
  out = OUT,
  planOut = PLAN_OUT,
  quoteOut = QUOTE_OUT,
  identity = sourceIdentity(),
  nowMs = Date.now(),
} = {}) {
  const context = readContext({ planOut, quoteOut, identity })
  if (!context) return { status: 'unavailable', reason: 'no_plan', count: 0 }
  const issues = readIssues(out, context, nowMs)
  return {
    status: 'verified',
    count: issues.length,
    latestBlock: issues.at(-1)?.checkpoint.block.number ?? null,
    memberCount: entries(context.plan).length,
  }
}

export async function capture({ client, context, row, now = () => new Date() }) {
  const { plan, seedVaultCodeHash } = context,
    at = row.checkpoint.block,
    start = now().toISOString()
  const request = (method, params) => client.request({ method, params })
  if (Number(BigInt(await request('eth_chainId', []))) !== plan.source.chainId)
    throw new Error('Wrong chain')
  const readBlock = async (tag) => {
    const b = await request('eth_getBlockByNumber', [tag, false])
    return { number: Number(BigInt(b?.number)), hash: String(b?.hash).toLowerCase() }
  }
  const final = await readBlock('finalized'),
    canonical = await readBlock(blockTag(at.number))
  if (final.number < at.number || canonical.number !== at.number || canonical.hash !== at.hash)
    throw new Error('Checkpoint finality or canonical identity changed')
  const pin = { blockHash: at.hash, requireCanonical: true }
  const call = async (name, args = [], from) =>
    decodeFunctionResult({
      abi: ABI,
      functionName: name,
      data: await request('eth_call', [
        {
          to: plan.source.vault,
          data: encodeFunctionData({ abi: ABI, functionName: name, args }),
          ...(from ? { from } : {}),
        },
        pin,
      ]),
    })
  let sourceStatus = 'matched',
    observedVaultCodeHash = null,
    observedAsset = null
  try {
    const code = String(await request('eth_getCode', [plan.source.vault, pin])).toLowerCase()
    if (!CODE.test(code) || code === '0x') throw new Error('Vault code unavailable')
    observedVaultCodeHash = keccak256(code)
  } catch {
    /* code read unavailable */
  }
  try {
    observedAsset = String(await call('asset')).toLowerCase()
  } catch {
    /* asset read unavailable */
  }
  sourceStatus =
    (observedVaultCodeHash && observedVaultCodeHash !== seedVaultCodeHash) ||
    (observedAsset && observedAsset !== plan.source.crvUsd)
      ? 'drift'
      : observedVaultCodeHash && observedAsset
        ? 'matched'
        : 'unavailable'
  const holderCache = new Map(),
    previewCache = new Map(),
    results = []
  const optional = async (fn) => {
    try {
      return uint(await fn())
    } catch {
      return null
    }
  }
  for (const { holder, rawCrvUsd } of entries(plan)) {
    if (sourceStatus !== 'matched') {
      results.push({
        holder,
        rawCrvUsd,
        status: sourceStatus === 'drift' ? 'source_drift' : 'provider_error',
        holderCode: null,
        balanceSharesRaw: null,
        maxWithdrawAssetsRaw: null,
        previewSharesRaw: null,
        sharesBurnedRaw: null,
      })
      continue
    }
    if (!holderCache.has(holder)) {
      let holderCode = null
      try {
        const code = String(await request('eth_getCode', [holder, pin])).toLowerCase()
        if (CODE.test(code)) holderCode = code
      } catch {
        /* preserve provider ambiguity for this holder */
      }
      holderCache.set(holder, {
        holderCode,
        balanceSharesRaw: await optional(() => call('balanceOf', [holder])),
        maxWithdrawAssetsRaw: await optional(() => call('maxWithdraw', [holder])),
      })
    }
    if (!previewCache.has(rawCrvUsd))
      previewCache.set(
        rawCrvUsd,
        await optional(() => call('previewWithdraw', [BigInt(rawCrvUsd)])),
      )
    const diagnostic = holderCache.get(holder)
    let status = 'provider_error',
      sharesBurnedRaw = null
    if (diagnostic.holderCode && diagnostic.holderCode !== '0x') status = 'holder_code_change'
    if (diagnostic.holderCode === '0x') {
      try {
        sharesBurnedRaw = uint(await call('withdraw', [BigInt(rawCrvUsd), holder, holder], holder))
        status = 'success'
      } catch (error) {
        status = classifyWithdrawFailure(error)
      }
    }
    results.push({
      holder,
      rawCrvUsd,
      status,
      ...diagnostic,
      previewSharesRaw: previewCache.get(rawCrvUsd),
      sharesBurnedRaw,
    })
  }
  const again = await readBlock(blockTag(at.number))
  if (again.number !== at.number || again.hash !== at.hash)
    throw new Error('Canonical identity changed during capture')
  const issue = makeIssue({
    plan,
    checkpointRow: row,
    seedVaultCodeHash,
    sourceStatus,
    observedVaultCodeHash,
    observedAsset,
    results,
    captureStartUtc: start,
    captureEndUtc: now().toISOString(),
  })
  validateIssue(issue, { plan, checkpointRows: context.rows, seedVaultCodeHash })
  return issue
}

function append(path, issue, stat = statfsSync) {
  const bytes = `${JSON.stringify(issue)}\n`
  let ancestor = dirname(path)
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('No output ancestor')
    ancestor = parent
  }
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - Buffer.byteLength(bytes) < RESERVE_BYTES)
    throw new Error('Disk reserve')
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(tmp, path)
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
}

export async function observe({
  client,
  out = OUT,
  planOut = PLAN_OUT,
  quoteOut = QUOTE_OUT,
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  if (!client?.request) throw new Error('One RPC client required')
  mkdirSync(out, { recursive: true })
  const lock = join(out, '.observe.lock')
  mkdirSync(lock)
  try {
    const context = readContext({ planOut, quoteOut })
    if (!context) return { status: 'unavailable', reason: 'no_plan' }
    const prior = readIssues(out, context)
    const observed = new Set(prior.map((x) => x.checkpoint.block.number))
    const startMs = now().getTime()
    const candidates = context.rows.filter(
      (r) => eligible(r, context.plan, startMs) && !observed.has(r.checkpoint.block.number),
    )
    if (!candidates.length)
      return { status: 'unavailable', reason: 'no_eligible_unobserved_checkpoint' }
    const row = candidates[0]
    if (startMs - row.checkpoint.block.timestamp * 1000 > MAX_AGE_MS)
      return {
        status: 'unavailable',
        reason: 'earlier_checkpoint_stale',
        block: row.checkpoint.block.number,
      }
    const issue = await capture({ client, context, row, now })
    const path = join(out, 'issues', issueName(row))
    append(path, issue, stat)
    return {
      status: 'recorded',
      block: row.checkpoint.block.number,
      memberCount: issue.results.length,
      path,
    }
  } finally {
    rmdirSync(lock)
  }
}

export function parseArgs(args) {
  const mode = args[0] ?? '--verify'
  if (
    !['--run', '--verify'].includes(mode) ||
    args.length > (mode === '--run' ? 3 : 1) ||
    (mode === '--verify' && args.length > 1) ||
    (args.length > 1 && (args[1] !== '--rpc-index' || !/^(0|[1-9][0-9]*)$/.test(args[2] ?? '')))
  )
    throw new Error('Invalid options')
  return { mode, rpcIndex: Number(args[2] ?? 0) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { mode, rpcIndex } = parseArgs(process.argv.slice(2))
    if (mode === '--verify') console.log(JSON.stringify(verify()))
    else {
      const configured = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL') || ''
      const url = configured.split(',').map((x) => x.trim())[rpcIndex]
      if (!url) throw new Error('RPC unavailable')
      console.log(JSON.stringify(await observe({ client: makeClient(url) })))
    }
  } catch {
    console.error('[scrvusd-cohort-observe] unavailable')
    process.exitCode = 1
  }
}
