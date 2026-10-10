// Prospective holder-specific ERC-4626 exit observations. No notification or product claim.
// Dry by default. A plan must be sealed before its first eligible quote checkpoint.
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
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
import {
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity,
} from './curve-prospective-quote.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'scrvusd-fixed-holder-exit-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-fixed-holder-exit')
export const RESERVE_BYTES = 1_073_741_824
export const MAX_AGE_SECONDS = 3600
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^[1-9][0-9]*$/
const CAVEAT =
  'Read-only eth_call is holder-specific simulation at one block, not a transaction guarantee or a continuous exit state. Empty holder code does not prove private-key control.'
const PLAN_TIME_CAVEAT =
  'Plan creation time is a local operator attestation, not an independently witnessed timestamp.'
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const unsigned = ({ sha256: _sha256, ...rest }) => rest
const time = (value) => Date.parse(value)

export function validatePlan(plan, identity = sourceIdentity()) {
  if (
    !plan ||
    plan.sha256 !== sha(JSON.stringify(unsigned(plan))) ||
    plan.study !== STUDY ||
    plan.kind !== 'predeclared-holder-exit-plan' ||
    JSON.stringify(plan.source) !== JSON.stringify(identity) ||
    plan.timingCaveat !== PLAN_TIME_CAVEAT ||
    !ADDRESS.test(plan.holder) ||
    !RAW.test(plan.rawCrvUsd) ||
    !Number.isFinite(time(plan.createdUtc))
  )
    throw new Error('Invalid holder exit plan')
  return plan
}

export function makePlan({ holder, rawCrvUsd, identity = sourceIdentity(), now = new Date() }) {
  const plan = seal({
    study: STUDY,
    kind: 'predeclared-holder-exit-plan',
    source: identity,
    holder: String(holder).toLowerCase(),
    rawCrvUsd: String(rawCrvUsd),
    createdUtc: now.toISOString(),
    timingCaveat: PLAN_TIME_CAVEAT,
  })
  return validatePlan(plan, identity)
}

function planPath(out) {
  return join(out, 'plan.json')
}

export function readPlan({ out = OUT, identity = sourceIdentity() } = {}) {
  if (!existsSync(planPath(out))) return null
  return validatePlan(JSON.parse(readFileSync(planPath(out), 'utf8')), identity)
}

function guard(out, stat = statfsSync, extra = 0) {
  let ancestor = out
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('No output ancestor')
    ancestor = parent
  }
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Holder exit disk reserve reached')
}

function append(path, value, stat = statfsSync) {
  const bytes = JSON.stringify(value) + '\n'
  guard(dirname(path), stat, Buffer.byteLength(bytes))
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

export function savePlan({ out = OUT, plan, stat = statfsSync }) {
  validatePlan(plan)
  if (existsSync(planPath(out))) throw new Error('Holder exit plan already exists')
  append(planPath(out), plan, stat)
  return planPath(out)
}

function checkpointRef(row) {
  return {
    filename: row.filename,
    logicalSha256: row.checkpoint.sha256,
    physicalSha256: row.physicalSha256,
    block: row.checkpoint.block,
  }
}

export function validateIssue(issue, { plan, checkpoints, nowUtc } = {}) {
  validatePlan(plan)
  if (!issue || issue.sha256 !== sha(JSON.stringify(unsigned(issue))))
    throw new Error('Holder exit issue SHA mismatch')
  const row = checkpoints.find((candidate) => candidate.filename === issue.checkpoint?.filename)
  if (
    issue.study !== STUDY ||
    issue.kind !== 'holder-withdraw-simulation' ||
    issue.planSha256 !== plan.sha256 ||
    issue.holder !== plan.holder ||
    issue.rawCrvUsd !== plan.rawCrvUsd ||
    JSON.stringify(issue.source) !== JSON.stringify(plan.source) ||
    !row ||
    JSON.stringify(issue.checkpoint) !== JSON.stringify(checkpointRef(row)) ||
    !Number.isFinite(time(issue.captureStartUtc)) ||
    !Number.isFinite(time(issue.captureEndUtc)) ||
    time(plan.createdUtc) > row.checkpoint.block.timestamp * 1000 ||
    time(row.checkpoint.captureEndUtc) > time(issue.captureStartUtc) ||
    time(issue.captureStartUtc) > time(issue.captureEndUtc) ||
    time(issue.captureStartUtc) / 1000 - row.checkpoint.block.timestamp > MAX_AGE_SECONDS ||
    time(issue.captureEndUtc) / 1000 - row.checkpoint.block.timestamp > MAX_AGE_SECONDS ||
    time(issue.captureStartUtc) / 1000 < row.checkpoint.block.timestamp - 60 ||
    (nowUtc && time(issue.captureEndUtc) > time(nowUtc)) ||
    !['success', 'revert', 'provider_error'].includes(issue.result?.status) ||
    (issue.result.status === 'success' && !RAW.test(issue.result.sharesBurnedRaw || '')) ||
    (issue.result.status !== 'success' && issue.result.sharesBurnedRaw !== null) ||
    !['hash'].includes(issue.pinMode) ||
    !['verified'].includes(issue.canonicalStatus) ||
    issue.caveat !== CAVEAT ||
    JSON.stringify(Object.keys(issue.result).sort()) !==
      JSON.stringify(
        [
          'status',
          'sharesBurnedRaw',
          'balanceSharesRaw',
          'maxWithdrawAssetsRaw',
          'previewSharesRaw',
        ].sort(),
      )
  )
    throw new Error('Invalid holder exit issue or source timing')
  for (const key of ['balanceSharesRaw', 'maxWithdrawAssetsRaw', 'previewSharesRaw']) {
    const value = issue.result[key]
    if (value !== null && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)))
      throw new Error('Invalid holder exit diagnostic')
  }
  return issue
}

export function makeIssue({ plan, checkpointRow, result, captureStartUtc, captureEndUtc }) {
  const issue = seal({
    study: STUDY,
    kind: 'holder-withdraw-simulation',
    planSha256: plan.sha256,
    source: plan.source,
    holder: plan.holder,
    rawCrvUsd: plan.rawCrvUsd,
    checkpoint: checkpointRef(checkpointRow),
    captureStartUtc,
    captureEndUtc,
    pinMode: 'hash',
    canonicalStatus: 'verified',
    result,
    caveat: CAVEAT,
  })
  validateIssue(issue, { plan, checkpoints: [checkpointRow], nowUtc: new Date().toISOString() })
  return issue
}

export function trajectory(issues) {
  const sorted = [...issues].sort((a, b) => a.checkpoint.block.number - b.checkpoint.block.number)
  if (!sorted.length) return { status: 'unavailable', reason: 'no_observations' }
  const planSha = sorted[0].planSha256
  if (sorted.some((row) => row.planSha256 !== planSha)) throw new Error('Mixed holder or size')
  const firstFailure = sorted.find((row) => row.result.status === 'revert')
  const successes = sorted.filter((row) => row.result.status === 'success')
  if (!firstFailure)
    return successes.length
      ? {
          status: 'right_censored',
          lastSuccessBlock: successes.at(-1).checkpoint.block.number,
          lastSuccessUtc: new Date(
            successes.at(-1).checkpoint.block.timestamp * 1000,
          ).toISOString(),
          laterUnknownCount: sorted.filter(
            (row) => row.checkpoint.block.number > successes.at(-1).checkpoint.block.number,
          ).length,
        }
      : { status: 'unavailable', reason: 'no_success_or_revert' }
  const previousSuccess = successes
    .filter((row) => row.checkpoint.block.number < firstFailure.checkpoint.block.number)
    .at(-1)
  return {
    status: 'first_observed_revert',
    intervalStartUtc: previousSuccess
      ? new Date(previousSuccess.checkpoint.block.timestamp * 1000).toISOString()
      : null,
    intervalEndUtc: new Date(firstFailure.checkpoint.block.timestamp * 1000).toISOString(),
    intervalStartBlock: previousSuccess?.checkpoint.block.number ?? null,
    intervalEndBlock: firstFailure.checkpoint.block.number,
    unknownWithinInterval: sorted.filter(
      (row) =>
        row.result.status === 'provider_error' &&
        row.checkpoint.block.number < firstFailure.checkpoint.block.number &&
        (!previousSuccess || row.checkpoint.block.number > previousSuccess.checkpoint.block.number),
    ).length,
    laterSuccessObserved: successes.some(
      (row) => row.checkpoint.block.number > firstFailure.checkpoint.block.number,
    ),
  }
}

export function verify({
  out = OUT,
  quoteOut = QUOTE_OUT,
  identity = sourceIdentity(),
  now = () => new Date(),
} = {}) {
  const plan = readPlan({ out, identity })
  if (!plan) return { count: 0, status: 'unavailable', reason: 'no_predeclared_plan' }
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity })
  const dir = join(out, 'issues')
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  const seen = new Set()
  const issues = files.map((file) => {
    const issue = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    validateIssue(issue, { plan, checkpoints, nowUtc: now().toISOString() })
    const block = issue.checkpoint.block
    if (
      file !== `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json` ||
      seen.has(block.number)
    )
      throw new Error('Holder exit issue filename or duplicate block')
    seen.add(block.number)
    return issue
  })
  return { count: issues.length, trajectory: trajectory(issues) }
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
  const entries = []
  let current = error
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) break
    seen.add(current)
    entries.push(current)
    current = safeGet(current, 'cause')
  }
  const transport = entries.some((entry) => {
    const name = safeGet(entry, 'name')
    const code = safeGet(entry, 'code')
    const status = safeGet(entry, 'status') ?? safeGet(entry, 'statusCode')
    return (
      ['HttpRequestError', 'FetchError', 'TimeoutError', 'AbortError', 'NetworkError'].includes(
        name,
      ) ||
      ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', -32005, 429].includes(code) ||
      (Number.isInteger(status) && (status === 429 || status >= 500))
    )
  })
  if (transport) return 'provider_error'
  const revert = entries.some((entry) => {
    const code = safeGet(entry, 'code')
    const data = safeGet(entry, 'data')
    return code === 3 && typeof data === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(data)
  })
  return revert ? 'revert' : 'provider_error'
}

export async function observe({
  client,
  out = OUT,
  quoteOut = QUOTE_OUT,
  checkpointBlock = null,
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  if (!client?.request) throw new Error('One RPC client is required')
  const identity = sourceIdentity()
  const plan = readPlan({ out, identity })
  if (!plan) throw new Error('Predeclared holder exit plan missing')
  verify({ out, quoteOut, identity })
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity })
  const observed = new Set(
    existsSync(join(out, 'issues'))
      ? readdirSync(join(out, 'issues'))
          .filter((name) => name.endsWith('.json'))
          .map((name) => Number(name.slice(0, 12)))
      : [],
  )
  if (checkpointBlock !== null && (!Number.isSafeInteger(checkpointBlock) || checkpointBlock < 0))
    throw new Error('Invalid exact checkpoint block')
  const start = now().toISOString()
  const row = checkpoints.findLast(
    (candidate) =>
      (checkpointBlock === null || candidate.checkpoint.block.number === checkpointBlock) &&
      time(plan.createdUtc) <= candidate.checkpoint.block.timestamp * 1000 &&
      time(candidate.checkpoint.captureEndUtc) <= time(start) &&
      time(start) / 1000 - candidate.checkpoint.block.timestamp <= MAX_AGE_SECONDS &&
      !observed.has(candidate.checkpoint.block.number),
  )
  if (!row) return { status: 'unavailable', reason: 'no_eligible_unobserved_checkpoint' }
  const at = row.checkpoint.block
  const request = (method, params) => client.request({ method, params })
  if (Number(BigInt(await request('eth_chainId', []))) !== 1) throw new Error('Wrong chain')
  const readBlock = async (tag) => {
    const block = await request('eth_getBlockByNumber', [tag, false])
    return { number: Number(BigInt(block.number)), hash: String(block.hash).toLowerCase() }
  }
  const final = await readBlock('finalized')
  const canonical = await readBlock(`0x${at.number.toString(16)}`)
  if (final.number < at.number || canonical.number !== at.number || canonical.hash !== at.hash)
    throw new Error('Quote block identity or finality changed')
  const holderCode = await request('eth_getCode', [
    plan.holder,
    { blockHash: at.hash, requireCanonical: true },
  ])
  if (typeof holderCode !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(holderCode))
    throw new Error('Invalid pinned holder code response')
  if (holderCode !== '0x')
    return { status: 'unavailable', reason: 'contract_holder', block: at.number }
  const call = async (name, args = [], from) => {
    const data = encodeFunctionData({ abi: ABI, functionName: name, args })
    const value = await request('eth_call', [
      { to: identity.vault, data, ...(from ? { from } : {}) },
      { blockHash: at.hash, requireCanonical: true },
    ])
    return decodeFunctionResult({ abi: ABI, functionName: name, data: value })
  }
  if (String(await call('asset')).toLowerCase() !== identity.crvUsd)
    throw new Error('Vault asset identity changed')
  const optional = async (name, args) => {
    try {
      return String(await call(name, args))
    } catch {
      return null
    }
  }
  const balanceSharesRaw = await optional('balanceOf', [plan.holder])
  const maxWithdrawAssetsRaw = await optional('maxWithdraw', [plan.holder])
  const previewSharesRaw = await optional('previewWithdraw', [BigInt(plan.rawCrvUsd)])
  let status = 'success'
  let sharesBurnedRaw = null
  try {
    sharesBurnedRaw = String(
      await call('withdraw', [BigInt(plan.rawCrvUsd), plan.holder, plan.holder], plan.holder),
    )
  } catch (error) {
    status = classifyWithdrawFailure(error)
  }
  const again = await readBlock(`0x${at.number.toString(16)}`)
  if (again.hash !== at.hash || again.number !== at.number)
    throw new Error('Quote block identity changed during observation')
  const result = {
    status,
    sharesBurnedRaw,
    balanceSharesRaw,
    maxWithdrawAssetsRaw,
    previewSharesRaw,
  }
  const issue = makeIssue({
    plan,
    checkpointRow: row,
    result,
    captureStartUtc: start,
    captureEndUtc: now().toISOString(),
  })
  const path = join(
    out,
    'issues',
    `${String(at.number).padStart(12, '0')}-${at.hash.slice(2)}.json`,
  )
  append(path, issue, stat)
  return { status, block: at.number, path }
}

function parseRpcIndex(index) {
  if (typeof index !== 'string' || !/^(0|[1-9][0-9]*)$/.test(index))
    throw new Error('Invalid RPC index')
  const position = Number(index)
  if (!Number.isSafeInteger(position)) throw new Error('Invalid RPC index')
  return position
}

export function selectConfiguredRpc(configured, index = '0') {
  const position = parseRpcIndex(index)
  const hosts =
    typeof configured === 'string' ? configured.split(',').map((host) => host.trim()) : []
  if (!hosts[position]) throw new Error('Configured RPC index unavailable')
  return hosts[position]
}

export function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (
      !['--plan', '--observe', '--verify', '--holder', '--raw-crvusd', '--rpc-index'].includes(
        key,
      ) ||
      parsed[key]
    )
      throw new Error('Unknown or duplicate option')
    parsed[key] = ['--holder', '--raw-crvusd', '--rpc-index'].includes(key) ? argv[++i] : true
    if (!parsed[key]) throw new Error('Missing option value')
  }
  if ([parsed['--plan'], parsed['--observe'], parsed['--verify']].filter(Boolean).length > 1)
    throw new Error('Incompatible modes')
  if (parsed['--rpc-index'] !== undefined && !parsed['--observe'])
    throw new Error('RPC index requires --observe')
  if (parsed['--rpc-index'] !== undefined) parseRpcIndex(parsed['--rpc-index'])
  return parsed
}

async function main() {
  const option = parseArgs(process.argv.slice(2))
  if (option['--verify']) return console.log(JSON.stringify(verify()))
  if (option['--plan']) {
    if (!option['--holder'] || !option['--raw-crvusd'])
      throw new Error('Holder and raw amount required')
    const plan = makePlan({ holder: option['--holder'], rawCrvUsd: option['--raw-crvusd'] })
    savePlan({ plan })
    return console.log(JSON.stringify({ status: 'planned', planSha256: plan.sha256 }))
  }
  if (option['--observe']) {
    // The link imports this module, so load it only after CLI mode selection.
    // Verify before constructing an RPC client or admitting a holder outcome.
    const { verify: verifySelection } = await import('./scrvusd-holder-selection-link.mjs')
    if (verifySelection().status !== 'verified')
      throw new Error('Prospective holder selection certificate unavailable')
    const rpc = selectConfiguredRpc(
      process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'),
      option['--rpc-index'] ?? '0',
    )
    return console.log(JSON.stringify(await observe({ client: makeClient(rpc) })))
  }
  return console.log(JSON.stringify({ mode: 'dry', study: STUDY, planned: Boolean(readPlan()) }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Holder exit planning, observation, or verification failed')
    process.exitCode = 1
  })
}
