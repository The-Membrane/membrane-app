// Read-only, first-anchor-only Morpho V2 exit outcome. Dry by default.
// --run performs bounded historical RPC reads; no transaction is sent.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, statfsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'

export const STUDY = 'morpho-v2-first-anchor-outcome-v2'
export const TREATED_SHA = '9bf2a8705910c65eae377a2f63eec73dd6a82f907d9ec1ccee7ead015dcc754e'
export const CONTROLS_SHA = '49cb3d86dbb6106998715a44b359575a9952a510b33f49fffa784d928b773914'
const MIN_FREE = 2_500_000_000n
const MAX_RPC = 400
const GAS = 30_000_000n
const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const DECIMAL = /^(0|[1-9][0-9]*)$/
const ZERO = '0x0000000000000000000000000000000000000000'
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function liquidityAdapter() view returns (address)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const stable = (value) => JSON.stringify(value)
class FatalReadError extends Error {}
function assert(test, message) {
  if (!test) throw new Error(message)
}
function readPinned(path, hash) {
  const bytes = readFileSync(path)
  assert(sha(bytes) === hash, `Pinned source SHA mismatch: ${path}`)
  return JSON.parse(bytes)
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, stable(value), { mode: 0o600 })
  renameSync(temp, path)
}
function seal(value) {
  const copy = { ...value }
  delete copy.checkpointSha256
  return { ...copy, checkpointSha256: sha(stable(copy)) }
}
function safeNumber(value) {
  const n = Number(BigInt(value))
  assert(Number.isSafeInteger(n), 'Unsafe integer')
  return n
}
function header(raw) {
  const result = {
    block: safeNumber(raw.number),
    hash: raw.hash,
    timestamp: safeNumber(raw.timestamp),
    gasLimit: BigInt(raw.gasLimit).toString(),
  }
  assert(HASH.test(result.hash), 'Invalid block hash')
  return result
}
function parseRevert(error) {
  const message = Array.from({ length: 4 }, (_, i) => {
    let e = error
    for (let j = 0; j < i; j++) e = e?.cause
    return String(e?.message || '')
  })
    .join(' ')
    .toLowerCase()
  if (/out of gas|gas limit|intrinsic gas|exceeds block gas/.test(message)) return 'gas-error'
  if (/execution reverted|vm execution error.*revert|reverted with/.test(message))
    return 'evm-revert'
  return 'rpc-or-archive-error'
}
function codeHash(code) {
  return code && code !== '0x' ? keccak256(code) : null
}
function implementation(storage) {
  assert(/^0x[0-9a-f]{64}$/i.test(storage), 'Invalid EIP-1967 storage')
  const address = `0x${storage.slice(-40)}`.toLowerCase()
  return address === ZERO ? null : address
}
function sourceRows(treated, controls, stage1) {
  assert(treated.study === 'morpho-v2-full-cohort-signer-baseline-v2', 'Wrong treated study')
  assert(treated.status === 'complete-first64-preoutcome', 'Incomplete treated source')
  assert(controls.study === 'morpho-v2-first-anchor-controls-sentinel-v2', 'Wrong control study')
  assert(
    controls.status === 'first-anchor-complete' && controls.anchorIndex === 0,
    'Incomplete first-anchor controls',
  )
  assert(
    controls.treatedPhysicalSha256 === treated.v1PhysicalSha256,
    'Control/treated v1 ancestry mismatch',
  )
  assert(
    controls.denominator === 304 && controls.selected.length === 2,
    'Frozen denominator/selection mismatch',
  )
  assert(stage1.study === 'morpho-v2-cap-submit-stage1-v1', 'Wrong Stage 1 source')
  const first = treated.rows[0]
  assert(
    first?.index === 0 && first?.status === 'baseline-success',
    'First treated baseline missing',
  )
  assert(
    first.proposalIndex === 360 && first.anchorBlock === 24335711,
    'First anchor identity changed',
  )
  assert(first.preBlock === first.anchorBlock - 1, 'Treated pre-block mismatch')
  assert(HASH.test(first.preBlockHash) && ADDRESS.test(first.holder), 'Invalid treated identity')
  assert(
    DECIMAL.test(first.qAssets) && BigInt(first.qAssets) === 11024n,
    'Frozen treated q changed',
  )
  const proposal = stage1.proposals[first.proposalIndex]
  assert(
    proposal?.vault?.toLowerCase() === first.vault && proposal.block === first.anchorBlock,
    'Proposal/treated mismatch',
  )
  const eligible = proposal.executableAts
    .filter((_, i) => proposal.classes[i] === 'eligible')
    .map(safeNumber)
    .sort((a, b) => a - b)
  assert(eligible.length > 0 && eligible[0] > proposal.timestamp, 'No future eligible schedule')
  const rows = [
    {
      kind: 'treated',
      vault: first.vault,
      holder: first.holder,
      qAssets: first.qAssets,
      preBlock: first.preBlock,
      preBlockHash: first.preBlockHash,
      baselineRuntimeCodeHash: first.runtimeCodeHash,
      baselineClaimAssets: first.previewRedeemable,
    },
    ...controls.selected.map((c) => ({
      kind: 'control',
      vault: c.vault,
      holder: c.holder,
      qAssets: first.qAssets,
      preBlock: c.preBlock,
      preBlockHash: c.preBlockHash,
      baselineRuntimeCodeHash: c.runtimeCodeHash,
      baselineClaimAssets: c.holderClaimAssets,
      baselineAsset: c.asset,
      baselineAdapter: c.adapter,
    })),
  ]
  for (const row of rows) {
    assert(ADDRESS.test(row.vault) && ADDRESS.test(row.holder), 'Invalid row address')
    assert(
      row.preBlock === first.preBlock && row.preBlockHash === first.preBlockHash,
      'Mixed baseline anchors',
    )
    assert(HASH.test(row.baselineRuntimeCodeHash), 'Missing baseline runtime code')
    assert(
      DECIMAL.test(row.baselineClaimAssets) && BigInt(row.baselineClaimAssets) >= 11024n,
      'Baseline claim below frozen q',
    )
  }
  assert(new Set(rows.map((r) => r.vault.toLowerCase())).size === 3, 'Duplicate vault')
  assert(
    rows[1].baselineAsset?.toLowerCase() === rows[2].baselineAsset?.toLowerCase(),
    'Control assets differ at baseline',
  )
  return {
    denominator: controls.denominator,
    anchorBlock: first.anchorBlock,
    anchorTimestamp: safeNumber(proposal.timestamp),
    executableAt: eligible[0],
    coInterventionTimes: eligible.slice(1),
    rows,
  }
}
export function loadPlan({ treatedPath, controlsPath, stage1Path }) {
  return sourceRows(
    readPinned(treatedPath, TREATED_SHA),
    readPinned(controlsPath, CONTROLS_SHA),
    readPinned(stage1Path, STAGE1_SHA),
  )
}
function base(plan) {
  return {
    study: STUDY,
    version: 2,
    status: 'partial',
    sourceSha256: { treated: TREATED_SHA, controls: CONTROLS_SHA, stage1: STAGE1_SHA },
    denominator: plan.denominator,
    anchorBlock: plan.anchorBlock,
    anchorTimestamp: plan.anchorTimestamp,
    executableAt: plan.executableAt,
    coInterventionTimes: plan.coInterventionTimes,
    estimand:
      'fixed 11024 raw asset-unit, code-empty holder eth_call; plumbing only, signer control unproven',
    prospective: false,
    selectionCaveat:
      'treated selects first largest code-empty holder before withdraw; controls may try successive holders after revert',
    rows: plan.rows.map((r) => ({ ...r, baseline: null, outcomes: {} })),
  }
}
function verifyObservedState(state, row, baseline) {
  const reasons = state.censoring
  assert(Array.isArray(reasons) && new Set(reasons).size === reasons.length, 'Invalid censor list')
  const has = (reason) => reasons.includes(reason)
  const failed = (prefix) => reasons.some((reason) => reason.startsWith(`${prefix}-`))
  assert(DECIMAL.test(state.gasLimit), 'Missing observed block gas limit')
  if (BigInt(state.gasLimit) < GAS)
    assert(has('block-gas-limit-below-fixed-call'), 'Missing gas-limit censor')
  if (state.runtimeCodeHash === undefined) assert(failed('vault-code'), 'Missing vault-code error')
  else if (state.runtimeCodeHash === null)
    assert(has('missing-vault-code'), 'Missing empty vault-code censor')
  else if (state.runtimeCodeHash !== row.baselineRuntimeCodeHash)
    assert(has('vault-code-changed'), 'Missing vault-code drift censor')
  if (state.holderCodeHash === undefined) assert(failed('holder-code'), 'Missing holder-code error')
  else if (state.holderCodeHash !== null)
    assert(has('holder-code-changed'), 'Missing holder-code drift censor')
  if (state.proxyImplementation === undefined)
    assert(failed('proxy-implementation'), 'Missing implementation error')
  else {
    if (!baseline && state.proxyImplementation !== row.baseline?.proxyImplementation)
      assert(has('proxy-implementation-changed'), 'Missing implementation drift censor')
    if (state.proxyImplementation) {
      if (state.proxyImplementationCodeHash === undefined)
        assert(failed('proxy-implementation-code'), 'Missing implementation-code error')
      else if (state.proxyImplementationCodeHash === null)
        assert(has('missing-proxy-implementation-code'), 'Missing implementation-code censor')
      else if (
        !baseline &&
        state.proxyImplementationCodeHash !== row.baseline?.proxyImplementationCodeHash
      )
        assert(has('proxy-implementation-code-changed'), 'Missing implementation-code drift censor')
    }
  }
  for (const field of ['asset', 'adapter']) {
    if (state[field] === undefined) assert(failed(field), `Missing ${field} error`)
    else {
      assert(ADDRESS.test(state[field]), `Invalid ${field} observation`)
      const prior = baseline
        ? row[`baseline${field[0].toUpperCase()}${field.slice(1)}`]
        : row.baseline?.[field]
      if (prior && state[field] !== prior.toLowerCase())
        assert(has(`${field}-changed`), `Missing ${field} drift censor`)
    }
  }
  if (state.holderShares === undefined) assert(failed('balance'), 'Missing holder balance error')
  else {
    assert(DECIMAL.test(state.holderShares), 'Invalid holder shares')
    if (state.holderClaimAssets === undefined) assert(failed('claim'), 'Missing holder claim error')
    else {
      assert(DECIMAL.test(state.holderClaimAssets), 'Invalid holder claim')
      if (BigInt(state.holderClaimAssets) < BigInt(row.qAssets))
        assert(has('holder-claim-below-frozen-q'), 'Missing holder-attrition censor')
    }
  }
  if (!baseline) {
    if (state.call === 'success') {
      assert(
        DECIMAL.test(state.shares) && /^0x[0-9a-f]+$/i.test(state.output),
        'Missing successful output',
      )
    } else if (state.call === 'gas-error' || state.call === 'rpc-or-archive-error')
      assert(has('call-unresolved'), 'Missing unresolved-call censor')
  }
}
export function verifySnapshot(snapshot, plan) {
  assert(
    snapshot?.checkpointSha256 === seal(snapshot).checkpointSha256,
    'Outcome checksum mismatch',
  )
  const expected = base(plan)
  for (const key of [
    'study',
    'version',
    'sourceSha256',
    'denominator',
    'anchorBlock',
    'anchorTimestamp',
    'executableAt',
    'coInterventionTimes',
    'estimand',
    'prospective',
    'selectionCaveat',
  ])
    assert(stable(snapshot[key]) === stable(expected[key]), `Outcome ${key} mismatch`)
  assert(snapshot.rows?.length === 3, 'Outcome row count mismatch')
  for (let i = 0; i < 3; i++) {
    const row = snapshot.rows[i]
    for (const [key, value] of Object.entries(plan.rows[i]))
      assert(stable(row[key]) === stable(value), `Outcome frozen ${key} mismatch`)
    if (row.baseline) {
      assert(row.baseline.block === plan.rows[i].preBlock, 'Baseline block mismatch')
      assert(row.baseline.hash === plan.rows[i].preBlockHash, 'Baseline hash mismatch')
      assert(row.baseline.status === 'baseline-observed', 'Baseline status mismatch')
      assert(
        row.baseline.runtimeCodeHash === plan.rows[i].baselineRuntimeCodeHash,
        'Baseline code mismatch',
      )
      assert(
        row.baseline.holderClaimAssets === plan.rows[i].baselineClaimAssets,
        'Baseline claim mismatch',
      )
      assert(
        Array.isArray(row.baseline.censoring) && row.baseline.censoring.length === 0,
        'Baseline censor mismatch',
      )
      if (plan.rows[i].baselineAsset)
        assert(
          row.baseline.asset === plan.rows[i].baselineAsset.toLowerCase(),
          'Baseline asset mismatch',
        )
      if (plan.rows[i].baselineAdapter)
        assert(
          row.baseline.adapter === plan.rows[i].baselineAdapter.toLowerCase(),
          'Baseline adapter mismatch',
        )
      verifyObservedState(row.baseline, row, true)
    }
    for (const [name, probe] of Object.entries(row.outcomes || {})) {
      const delta = { plus6h: 21600, plus24h: 86400, plus7d: 604800 }[name]
      assert(delta !== undefined, 'Unknown horizon')
      assert(probe.targetTimestamp === plan.executableAt + delta, 'Target timestamp mismatch')
      if (probe.status === 'not-finalized') {
        assert(probe.finalizedHead?.timestamp < probe.targetTimestamp, 'Invalid not-finalized head')
      } else {
        assert(row.baseline, 'Outcome without baseline')
        assert(HASH.test(probe.hash) && Number.isSafeInteger(probe.block), 'Outcome header missing')
        assert(probe.timestamp >= probe.targetTimestamp, 'Outcome before target')
        assert(Array.isArray(probe.censoring), 'Outcome censor list missing')
        assert(
          ['success', 'evm-revert', 'gas-error', 'rpc-or-archive-error'].includes(probe.call),
          'Outcome call classification missing',
        )
        assert(
          probe.status === (probe.censoring.length ? 'censored' : probe.call),
          'Outcome status/censor mismatch',
        )
        assert(
          probe.scheduledLeadSeconds === probe.targetTimestamp - plan.anchorTimestamp,
          'Scheduled block-time gap mismatch',
        )
        assert(
          probe.previousHeader?.block === probe.block - 1 &&
            probe.previousHeader.timestamp < probe.targetTimestamp &&
            probe.finalizedHead?.block >= probe.block &&
            HASH.test(probe.finalizedHead.hash) &&
            (probe.finalizedHead.block !== probe.block || probe.finalizedHead.hash === probe.hash),
          'First finalized target block evidence mismatch',
        )
        verifyObservedState(probe, row, false)
      }
    }
  }
  if (snapshot.rows.every((row) => row.baseline))
    assert(
      new Set(snapshot.rows.map((row) => row.baseline.asset)).size === 1,
      'Treated/control baseline assets differ',
    )
  assert(['partial', 'complete'].includes(snapshot.status), 'Invalid outcome status')
  assert(
    snapshot.status !== 'complete' ||
      snapshot.rows.every((r) =>
        ['plus6h', 'plus24h', 'plus7d'].every(
          (name) =>
            r.outcomes[name]?.status !== undefined && r.outcomes[name].status !== 'not-finalized',
        ),
      ),
    'Incomplete snapshot marked complete',
  )
  return snapshot
}
function diskGuard(path) {
  const free = statfsSync(dirname(path), { bigint: true })
  assert(free.bavail * free.bsize >= MIN_FREE, 'Disk free below 2.5 GB Morpho read guard')
}
function clientBudget(client, out) {
  let used = 0
  return async (method, params) => {
    try {
      diskGuard(out)
    } catch (error) {
      throw new FatalReadError('Disk reserve reached during RPC', { cause: error })
    }
    if (++used > MAX_RPC) throw new FatalReadError(`RPC call cap ${MAX_RPC} reached`)
    return client.request({ method, params })
  }
}
function blockTag(number) {
  return toHex(number)
}
async function block(request, number) {
  return header(await request('eth_getBlockByNumber', [blockTag(number), false]))
}
async function firstAtOrAfter(request, target, low, finalized) {
  if (finalized.timestamp < target) return null
  let hi = finalized.block
  let lo = low
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((await block(request, mid)).timestamp >= target) hi = mid
    else lo = mid + 1
  }
  const found = await block(request, lo)
  const previous = lo > low ? await block(request, lo - 1) : null
  assert(
    found.timestamp >= target && (!previous || previous.timestamp < target),
    'First-block search invalid',
  )
  return { found, previous }
}
function pinnedTag(h) {
  return { blockHash: h.hash, requireCanonical: true }
}
async function call(request, vault, name, args, h, from = ZERO) {
  const data = encodeFunctionData({ abi: ABI, functionName: name, args })
  const result = await request('eth_call', [
    { from, to: vault, data, gas: toHex(GAS) },
    pinnedTag(h),
  ])
  return decodeFunctionResult({ abi: ABI, functionName: name, data: result })
}
async function rawWithdraw(request, row, h) {
  const data = encodeFunctionData({
    abi: ABI,
    functionName: 'withdraw',
    args: [BigInt(row.qAssets), row.holder, row.holder],
  })
  try {
    const output = await request('eth_call', [
      { from: row.holder, to: row.vault, data, gas: toHex(GAS) },
      pinnedTag(h),
    ])
    const shares = decodeFunctionResult({ abi: ABI, functionName: 'withdraw', data: output })
    return { call: 'success', shares: shares.toString(), output }
  } catch (error) {
    if (error instanceof FatalReadError) throw error
    return { call: parseRevert(error) }
  }
}
export async function readState(request, row, h, baseline) {
  const result = { ...h, censoring: [] }
  const pinned = pinnedTag(h)
  async function step(name, operation) {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof FatalReadError) throw error
      result.censoring.push(`${name}-${parseRevert(error)}`)
      return undefined
    }
  }
  const code = await step('vault-code', () => request('eth_getCode', [row.vault, pinned]))
  if (BigInt(h.gasLimit) < GAS) result.censoring.push('block-gas-limit-below-fixed-call')
  if (code !== undefined) {
    result.runtimeCodeHash = codeHash(code)
    if (!result.runtimeCodeHash) result.censoring.push('missing-vault-code')
    else if (result.runtimeCodeHash !== row.baselineRuntimeCodeHash)
      result.censoring.push('vault-code-changed')
  }
  const holderCode = await step('holder-code', () => request('eth_getCode', [row.holder, pinned]))
  if (holderCode !== undefined) {
    result.holderCodeHash = codeHash(holderCode)
    if (result.holderCodeHash) result.censoring.push('holder-code-changed')
  }
  const proxyImplementation = await step('proxy-implementation', async () =>
    implementation(await request('eth_getStorageAt', [row.vault, IMPLEMENTATION_SLOT, pinned])),
  )
  if (proxyImplementation !== undefined) {
    result.proxyImplementation = proxyImplementation
    if (!baseline && result.proxyImplementation !== row.baseline?.proxyImplementation)
      result.censoring.push('proxy-implementation-changed')
    if (proxyImplementation) {
      const implementationCode = await step('proxy-implementation-code', () =>
        request('eth_getCode', [proxyImplementation, pinned]),
      )
      if (implementationCode !== undefined) {
        result.proxyImplementationCodeHash = codeHash(implementationCode)
        if (!result.proxyImplementationCodeHash)
          result.censoring.push('missing-proxy-implementation-code')
        else if (
          !baseline &&
          result.proxyImplementationCodeHash !== row.baseline?.proxyImplementationCodeHash
        )
          result.censoring.push('proxy-implementation-code-changed')
      }
    }
  }
  const asset = await step('asset', () => call(request, row.vault, 'asset', [], h))
  if (asset !== undefined) {
    result.asset = asset.toLowerCase()
    const prior = baseline ? row.baselineAsset : row.baseline?.asset
    if (prior && result.asset !== prior.toLowerCase()) result.censoring.push('asset-changed')
  }
  const adapter = await step('adapter', () => call(request, row.vault, 'liquidityAdapter', [], h))
  if (adapter !== undefined) {
    result.adapter = adapter.toLowerCase()
    const prior = baseline ? row.baselineAdapter : row.baseline?.adapter
    if (prior && result.adapter !== prior.toLowerCase()) result.censoring.push('adapter-changed')
  }
  const balance = await step('balance', () =>
    call(request, row.vault, 'balanceOf', [row.holder], h),
  )
  if (balance !== undefined) {
    result.holderShares = balance.toString()
    const claim = await step('claim', () => call(request, row.vault, 'previewRedeem', [balance], h))
    if (claim !== undefined) {
      result.holderClaimAssets = claim.toString()
      if (claim < BigInt(row.qAssets)) result.censoring.push('holder-claim-below-frozen-q')
    }
  }
  if (baseline) {
    assert(result.holderClaimAssets === row.baselineClaimAssets, 'Baseline claim source mismatch')
    assert(result.runtimeCodeHash === row.baselineRuntimeCodeHash, 'Baseline code source mismatch')
    assert(result.censoring.length === 0, 'Baseline preflight failed')
    result.status = 'baseline-observed'
    return result
  }
  // Keep the raw fixed-q result even when eligibility censors are present.
  const withdrawal = await rawWithdraw(request, row, h)
  Object.assign(result, withdrawal)
  if (withdrawal.call === 'gas-error' || withdrawal.call === 'rpc-or-archive-error')
    result.censoring.push('call-unresolved')
  result.status = result.censoring.length ? 'censored' : withdrawal.call
  return result
}
export async function run({
  client,
  treatedPath,
  controlsPath,
  stage1Path,
  out,
  onProgress = () => {},
}) {
  const plan = loadPlan({ treatedPath, controlsPath, stage1Path })
  diskGuard(out)
  const request = clientBudget(client, out)
  let snapshot
  try {
    snapshot = verifySnapshot(JSON.parse(readFileSync(out)), plan)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    snapshot = seal(base(plan))
  }
  const save = () => {
    diskGuard(out)
    snapshot = seal(snapshot)
    atomic(out, snapshot)
  }
  const pre = await block(request, plan.rows[0].preBlock)
  assert(pre.hash === plan.rows[0].preBlockHash, 'B-1 canonical hash mismatch')
  const finalized = header(await request('eth_getBlockByNumber', ['finalized', false]))
  assert(finalized.block >= plan.anchorBlock, 'Anchor not finalized')
  for (const row of snapshot.rows) {
    if (!row.baseline) {
      row.baseline = await readState(request, row, pre, true)
      save()
      onProgress({ vault: row.vault, baseline: row.baseline.status })
    }
  }
  assert(
    new Set(snapshot.rows.map((row) => row.baseline.asset)).size === 1,
    'Treated/control baseline assets differ; no comparable outcome read',
  )
  for (const [name, offset] of Object.entries({ plus6h: 21600, plus24h: 86400, plus7d: 604800 })) {
    const target = plan.executableAt + offset
    const targetHeaders = await firstAtOrAfter(request, target, plan.anchorBlock, finalized)
    if (!targetHeaders) {
      for (const row of snapshot.rows)
        row.outcomes[name] = {
          status: 'not-finalized',
          targetTimestamp: target,
          finalizedHead: finalized,
        }
      save()
      continue
    }
    for (const row of snapshot.rows) {
      if (row.outcomes[name] && row.outcomes[name].status !== 'not-finalized') continue
      const probe = await readState(request, row, targetHeaders.found, false)
      probe.targetTimestamp = target
      probe.scheduledLeadSeconds = target - plan.anchorTimestamp
      probe.previousHeader = targetHeaders.previous
      probe.finalizedHead = finalized
      row.outcomes[name] = probe
      save()
      onProgress({ vault: row.vault, horizon: name, status: probe.status })
    }
  }
  snapshot.status = snapshot.rows.every((r) =>
    ['plus6h', 'plus24h', 'plus7d'].every(
      (name) => r.outcomes[name] && r.outcomes[name].status !== 'not-finalized',
    ),
  )
    ? 'complete'
    : 'partial'
  save()
  return verifySnapshot(snapshot, plan)
}
function options(args) {
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error('Expected --option')
    if (args[i] === '--run') opts.run = true
    else {
      assert(args[i + 1] && !args[i + 1].startsWith('--'), 'Missing option value')
      opts[args[i].slice(2)] = args[++i]
    }
  }
  return opts
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = options(process.argv.slice(2))
  const baseDir = 'data/research/venue-signals/'
  const paths = {
    treatedPath: resolve(opts.treated || `${baseDir}morpho-v2-signer-baseline-v2.json`),
    controlsPath: resolve(opts.controls || `${baseDir}morpho-v2-first-anchor-controls-v2.json`),
    stage1Path: resolve(opts.stage1 || `${baseDir}${STAGE1_SHA}.json`),
  }
  if (!opts.run) {
    const plan = loadPlan(paths)
    process.stdout.write(
      stable({
        study: STUDY,
        dry: true,
        anchorBlock: plan.anchorBlock,
        denominator: plan.denominator,
        qAssets: plan.rows[0].qAssets,
        rows: plan.rows.map((r) => ({ kind: r.kind, vault: r.vault, holder: r.holder })),
        targets: Object.fromEntries(
          Object.entries({ plus6h: 21600, plus24h: 86400, plus7d: 604800 }).map(([k, v]) => [
            k,
            plan.executableAt + v,
          ]),
        ),
        warning: 'plumbing only; no signer proof or venue-scale exit',
      }) + '\n',
    )
  } else {
    const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
    assert(rpc, 'RECORDER_RPC_URL is required for --run')
    const out = resolve(opts.out || `${baseDir}morpho-v2-first-anchor-outcome-v2.json`)
    try {
      const result = await run({
        client: makeClient(rpc),
        ...paths,
        out,
        onProgress: (x) => process.stdout.write(stable(x) + '\n'),
      })
      process.stdout.write(
        stable({ status: result.status, out, sha256: sha(readFileSync(out)) }) + '\n',
      )
    } catch (error) {
      // Provider errors can embed credential-bearing URLs.
      process.stderr.write('First-anchor outcome stopped; checkpoint retained.\n')
      process.exitCode = 1
    }
  }
}
