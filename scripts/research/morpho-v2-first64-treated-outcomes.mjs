// Historical, outcome-blind first-64 Morpho V2 treated follow-up. Dry by default.
// This measures prevalence/plumbing, not a prospective signal or a matched 304-row ITT effect.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { FACTORY_SHA, MANIFEST_SHA, selectAnchors } from './morpho-v2-full-cohort-baseline.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'

export const STUDY = 'morpho-v2-first64-treated-outcomes-v1'
export const TREATED_SHA = '9bf2a8705910c65eae377a2f63eec73dd6a82f907d9ec1ccee7ead015dcc754e'
export const N = 64
export const MIN_FREE = 2_500_000_000n
const MAX_RPC = 400
const MAX_RPC_PER_SCOPE = 100
const MAX_OUTPUT = 8 * 1024 * 1024
const GAS = 30_000_000n
const HORIZONS = { plus24h: 86400, plus7d: 604800 }
const HASH = /^0x[\da-f]{64}$/
const ADDRESS = /^0x[\da-f]{40}$/
const UINT = /^(0|[1-9]\d*)$/
const ZERO = `0x${'0'.repeat(40)}`
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
function assert(ok, message) {
  if (!ok) throw new Error(message)
}
function pinned(path, expected) {
  const bytes = readFileSync(path)
  assert(sha(bytes) === expected, `Pinned source physical SHA mismatch: ${path}`)
  return JSON.parse(bytes)
}
function seal(value) {
  const copy = { ...value }
  delete copy.checkpointSha256
  return { ...copy, checkpointSha256: sha(stable(copy)) }
}
function atomic(out, value, guard = diskGuard) {
  const bytes = stable(seal(value))
  assert(Buffer.byteLength(bytes) <= MAX_OUTPUT, 'Outcome checkpoint exceeds output cap')
  mkdirSync(dirname(out), { recursive: true })
  guard(out, Buffer.byteLength(bytes))
  const tmp = `${out}.${process.pid}.tmp`
  writeFileSync(tmp, bytes, { mode: 0o600 })
  renameSync(tmp, out)
  return JSON.parse(bytes)
}
function diskGuard(out, proposed = 0) {
  let root = dirname(out)
  while (!existsSync(root)) root = dirname(root)
  const fs = statfsSync(root, { bigint: true })
  assert(fs.bavail * fs.bsize - BigInt(proposed) >= MIN_FREE, 'Morpho disk reserve reached')
}
function safeNumber(value) {
  const n = Number(BigInt(value))
  assert(Number.isSafeInteger(n), 'Unsafe chain integer')
  return n
}
function header(raw) {
  assert(raw, 'Missing block header')
  const h = {
    block: safeNumber(raw.number),
    hash: raw.hash?.toLowerCase(),
    parentHash: raw.parentHash?.toLowerCase(),
    timestamp: safeNumber(raw.timestamp),
    gasLimit: BigInt(raw.gasLimit).toString(),
  }
  assert(HASH.test(h.hash), 'Invalid block hash')
  assert(HASH.test(h.parentHash), 'Invalid parent hash')
  return h
}
function classify(error) {
  const message = [error, error?.cause, error?.cause?.cause]
    .map((e) => String(e?.message || ''))
    .join(' ')
    .toLowerCase()
  if (/out of gas|gas limit|intrinsic gas|exceeds block gas/.test(message)) return 'gas-error'
  if (/execution reverted|vm execution error.*revert|reverted with/.test(message))
    return 'evm-revert'
  return 'rpc-or-archive-error'
}
const codeHash = (code) => (code && code !== '0x' ? keccak256(code).toLowerCase() : null)
function proxyAddress(storage) {
  assert(/^0x[\da-f]{64}$/i.test(storage), 'Invalid implementation slot')
  const address = `0x${storage.slice(-40)}`.toLowerCase()
  return address === ZERO ? null : address
}

export function loadPlan({ treatedPath, manifestPath, factoryPath, stage1Path }) {
  const treated = pinned(treatedPath, TREATED_SHA)
  const manifest = pinned(manifestPath, MANIFEST_SHA)
  const factory = pinned(factoryPath, FACTORY_SHA)
  const stage1 = pinned(stage1Path, STAGE1_SHA)
  const anchors = selectAnchors(manifest, factory)
  assert(treated.study === 'morpho-v2-full-cohort-signer-baseline-v2', 'Wrong treated study')
  assert(treated.status === 'complete-first64-preoutcome', 'Treated first64 incomplete')
  assert(treated.manifestSha256 === MANIFEST_SHA, 'Treated manifest ancestry mismatch')
  assert(treated.factorySha256 === FACTORY_SHA, 'Treated factory ancestry mismatch')
  assert(treated.rows?.length === N && anchors.length === 304, 'Frozen denominator mismatch')
  assert(
    stage1.study === 'morpho-v2-cap-submit-stage1-v1' && stage1.status === 'complete',
    'Stage1 mismatch',
  )
  assert(
    stage1.chainId === 1 && stage1.factoryArtifactSha256 === FACTORY_SHA,
    'Stage1 factory ancestry mismatch',
  )
  const rows = treated.rows.map((source, i) => {
    const anchor = anchors[i]
    const proposal = stage1.proposals[source.proposalIndex]
    assert(
      source.index === i && source.proposalIndex === anchor.proposalIndex,
      'Frozen order changed',
    )
    assert(
      source.vault === anchor.vault && source.anchorBlock === anchor.anchorBlock,
      'Vault/anchor changed',
    )
    assert(
      source.preBlock === anchor.preBlock && HASH.test(source.preBlockHash),
      'Prestate changed',
    )
    assert(
      proposal?.vault?.toLowerCase() === anchor.vault && proposal.block === anchor.anchorBlock,
      'Stage1 proposal mismatch',
    )
    assert(
      proposal.txHash?.toLowerCase() === manifest.rows[i].anchorTxHash.toLowerCase(),
      'Stage1/manifest transaction mismatch',
    )
    const executable = proposal.executableAts
      .filter((_, j) => proposal.classes[j] === 'eligible')
      .map(safeNumber)
      .sort((a, b) => a - b)
    assert(executable.length > 0 && executable[0] > proposal.timestamp, 'Missing eligible schedule')
    const eligible = source.status === 'baseline-success'
    assert(
      ['baseline-success', 'baseline-revert', 'no-non-sentinel-code-empty-holder'].includes(
        source.status,
      ),
      'Unknown frozen baseline stratum',
    )
    if (eligible) {
      assert(ADDRESS.test(source.holder) && !/^0x0{36}dead$/.test(source.holder), 'Invalid holder')
      assert(UINT.test(source.qAssets) && BigInt(source.qAssets) > 0n, 'Invalid frozen q')
      assert(
        UINT.test(source.totalAssets) && BigInt(source.totalAssets) > 0n,
        'Invalid frozen vault assets',
      )
      assert(
        BigInt(source.qAssets) * 1000n <= BigInt(source.totalAssets),
        'Frozen q exceeds 0.1% sizing rule',
      )
      assert(HASH.test(source.runtimeCodeHash), 'Missing frozen runtime code hash')
      assert(UINT.test(source.previewRedeemable), 'Missing frozen holder claim')
      assert(BigInt(source.previewRedeemable) >= BigInt(source.qAssets), 'Claim below q')
    }
    return {
      index: i,
      proposalIndex: source.proposalIndex,
      vault: source.vault,
      anchorBlock: source.anchorBlock,
      anchorTimestamp: safeNumber(proposal.timestamp),
      executableAt: executable[0],
      coInterventionTimes: executable.slice(1),
      preBlock: source.preBlock,
      preBlockHash: source.preBlockHash,
      baselineStatus: source.status,
      holder: source.holder ?? null,
      qAssets: source.qAssets ?? null,
      qOverVaultAssets:
        source.status === 'baseline-success'
          ? { numerator: source.qAssets, denominator: source.totalAssets }
          : null,
      baselineRuntimeCodeHash: source.runtimeCodeHash ?? null,
      baselineClaimAssets: source.previewRedeemable ?? null,
    }
  })
  assert(
    rows.filter((r) => r.baselineStatus === 'baseline-success').length === 58,
    'Frozen eligible count changed',
  )
  return rows
}

export function empty(plan) {
  return {
    study: STUDY,
    version: 1,
    status: 'partial',
    sourcePhysicalSha256: {
      treated: TREATED_SHA,
      manifest: MANIFEST_SHA,
      factory: FACTORY_SHA,
      stage1: STAGE1_SHA,
    },
    denominator: 64,
    fullManifestDenominator: 304,
    prospective: false,
    estimand:
      'Historical first64 treated fixed-holder/fixed-q withdrawal prevalence and plumbing only; not the 304 intention-to-treat cohort or matched predictive validation.',
    rows: plan.map((r) => ({
      ...r,
      baseline: null,
      outcomes: {},
      status: r.baselineStatus === 'baseline-success' ? 'pending' : 'baseline-ineligible',
    })),
  }
}

export function verifyProbe(probe, row, name) {
  const target = row.executableAt + HORIZONS[name]
  assert(probe.targetTimestamp === target, 'Target timestamp changed')
  if (probe.status === 'not-finalized') {
    assert(probe.finalizedHead?.timestamp < target, 'Not-finalized evidence invalid')
    return
  }
  assert(HASH.test(probe.hash) && Number.isSafeInteger(probe.block), 'Outcome header missing')
  assert(probe.timestamp >= target, 'Outcome before target')
  assert(probe.previousHeader?.block === probe.block - 1, 'Predecessor block mismatch')
  assert(
    HASH.test(probe.previousHeader.hash) && probe.parentHash === probe.previousHeader.hash,
    'Predecessor linkage mismatch',
  )
  assert(probe.previousHeader.timestamp < target, 'Target is not first block')
  assert(
    probe.finalizedHead?.block >= probe.block && HASH.test(probe.finalizedHead.hash),
    'Finality evidence missing',
  )
  assert(
    probe.canonicalRecheck?.targetHash === probe.hash &&
      probe.canonicalRecheck?.finalizedHash === probe.finalizedHead.hash,
    'Canonical recheck missing',
  )
  if (probe.finalizedHead.block === probe.block)
    assert(probe.finalizedHead.hash === probe.hash, 'Target/finalized hash mismatch')
  assert(probe.scheduledLeadSeconds === target - row.anchorTimestamp, 'Lead mismatch')
  assert(
    Array.isArray(probe.censoring) && new Set(probe.censoring).size === probe.censoring.length,
    'Censors malformed',
  )
  assert(
    ['success', 'evm-revert', 'gas-error', 'rpc-or-archive-error'].includes(probe.call),
    'Call status missing',
  )
  assert(
    probe.status === (probe.censoring.length ? 'censored' : probe.call),
    'Call/censor status mismatch',
  )
  if (probe.call === 'gas-error' || probe.call === 'rpc-or-archive-error')
    assert(probe.censoring.includes('call-unresolved'), 'Unresolved call not censored')
  if (probe.call === 'success')
    assert(UINT.test(probe.shares) && /^0x[\da-f]+$/i.test(probe.output), 'Success output missing')
  if (probe.call === 'success') {
    assert(
      ['observed', 'unavailable'].includes(probe.gasStatus),
      'Missing successful-call gas status',
    )
    if (probe.gasStatus === 'unavailable')
      assert(
        probe.censoring.includes('gas-estimate-unavailable'),
        'Unavailable gas estimate not censored',
      )
    else {
      assert(UINT.test(probe.gasEstimate), 'Invalid gas estimate')
      if (BigInt(probe.gasEstimate) > BigInt(probe.gasLimit) || BigInt(probe.gasEstimate) > GAS)
        assert(probe.censoring.includes('gas-estimate-above-limit'), 'Over-limit gas not censored')
    }
  }
  if (probe.runtimeCodeHash !== row.baselineRuntimeCodeHash)
    assert(
      probe.censoring.includes('vault-code-changed') ||
        probe.censoring.some((x) => x.startsWith('vault-code-')),
      'Code drift not censored',
    )
  if (probe.holderCodeHash !== null)
    assert(
      probe.censoring.includes('holder-code-changed') ||
        probe.censoring.some((x) => x.startsWith('holder-code-')),
      'Holder code not censored',
    )
  for (const field of [
    'asset',
    'adapter',
    'adapterCodeHash',
    'adapterImplementation',
    'adapterImplementationCodeHash',
    'proxyImplementation',
    'proxyImplementationCodeHash',
  ]) {
    if (probe[field] !== row.baseline?.[field])
      assert(
        probe.censoring.includes(`${field}-changed`) ||
          probe.censoring.some((x) => x.startsWith(`${field}-`)),
        `${field} drift not censored`,
      )
  }
  if (
    probe.holderClaimAssets !== undefined &&
    BigInt(probe.holderClaimAssets) < BigInt(row.qAssets)
  )
    assert(probe.censoring.includes('holder-claim-below-frozen-q'), 'Holder attrition not censored')
  if (probe.holderShares === undefined)
    assert(
      probe.censoring.some((x) => x.startsWith('balance-')),
      'Missing balance RPC censor',
    )
  else if (probe.holderClaimAssets === undefined)
    assert(
      probe.censoring.some((x) => x.startsWith('claim-')),
      'Missing claim RPC censor',
    )
  if (BigInt(probe.gasLimit) < GAS)
    assert(probe.censoring.includes('block-gas-limit-below-fixed-call'), 'Gas limit not censored')
}

export function verifySnapshot(snapshot, plan) {
  assert(
    snapshot.checkpointSha256 === seal(snapshot).checkpointSha256,
    'Checkpoint checksum mismatch',
  )
  const expected = empty(plan)
  for (const key of [
    'study',
    'version',
    'sourcePhysicalSha256',
    'denominator',
    'fullManifestDenominator',
    'prospective',
    'estimand',
  ])
    assert(stable(snapshot[key]) === stable(expected[key]), `Checkpoint ${key} mismatch`)
  assert(snapshot.rows?.length === N, 'Frozen 64-row denominator lost')
  for (let i = 0; i < N; i++) {
    const row = snapshot.rows[i]
    for (const [key, value] of Object.entries(plan[i]))
      assert(stable(row[key]) === stable(value), `Frozen row ${i} ${key} changed`)
    if (row.baselineStatus !== 'baseline-success') {
      assert(
        row.status === 'baseline-ineligible' &&
          row.baseline === null &&
          Object.keys(row.outcomes || {}).length === 0,
        'Ineligible row reselected',
      )
      continue
    }
    assert(['pending', 'partial', 'complete'].includes(row.status), 'Invalid row progress')
    if (row.baseline) {
      assert(
        row.baseline.block === row.preBlock && row.baseline.hash === row.preBlockHash,
        'Baseline header mismatch',
      )
      assert(
        row.baseline.runtimeCodeHash === row.baselineRuntimeCodeHash,
        'Baseline runtime mismatch',
      )
      assert(row.baseline.holderClaimAssets === row.baselineClaimAssets, 'Baseline claim mismatch')
      assert(
        row.baseline.holderCodeHash === null && row.baseline.censoring?.length === 0,
        'Baseline identity/censor mismatch',
      )
      assert(
        UINT.test(row.baseline.gasLimit) && BigInt(row.baseline.gasLimit) >= GAS,
        'Baseline gas-limit mismatch',
      )
      assert(
        ADDRESS.test(row.baseline.asset) && ADDRESS.test(row.baseline.adapter),
        'Baseline asset/adapter missing',
      )
      if (row.baseline.adapter !== ZERO)
        assert(HASH.test(row.baseline.adapterCodeHash), 'Baseline adapter code missing')
      if (row.baseline.adapterImplementation)
        assert(
          HASH.test(row.baseline.adapterImplementationCodeHash),
          'Baseline adapter implementation code missing',
        )
      assert(
        row.baseline.proxyImplementation === null || ADDRESS.test(row.baseline.proxyImplementation),
        'Baseline proxy identity missing',
      )
      if (row.baseline.proxyImplementation)
        assert(HASH.test(row.baseline.proxyImplementationCodeHash), 'Baseline proxy code missing')
    } else assert(Object.keys(row.outcomes || {}).length === 0, 'Outcome without baseline')
    for (const [name, probe] of Object.entries(row.outcomes || {})) {
      assert(name in HORIZONS, 'Unknown horizon')
      verifyProbe(probe, row, name)
    }
    if (row.status === 'complete')
      assert(
        Object.keys(HORIZONS).every(
          (name) => row.outcomes[name] && row.outcomes[name].status !== 'not-finalized',
        ),
        'Incomplete row marked complete',
      )
  }
  assert(['partial', 'complete'].includes(snapshot.status), 'Invalid checkpoint status')
  if (snapshot.status === 'complete')
    assert(
      snapshot.rows.every((r) => r.status === 'complete' || r.status === 'baseline-ineligible'),
      'Incomplete cohort marked complete',
    )
  return snapshot
}

export function requestBudget(client, out, guard = diskGuard) {
  let used = 0
  let scopeUsed = 0
  const request = async (method, params) => {
    try {
      guard(out)
    } catch (error) {
      throw new FatalReadError('Disk reserve reached', { cause: error })
    }
    if (++used > MAX_RPC) throw new FatalReadError('RPC cap reached')
    if (++scopeUsed > MAX_RPC_PER_SCOPE) throw new FatalReadError('Per-row/horizon RPC cap reached')
    return client.request({ method, params })
  }
  request.scope = () => {
    scopeUsed = 0
  }
  return request
}
async function block(request, number) {
  const h = header(await request('eth_getBlockByNumber', [toHex(number), false]))
  assert(h.block === number, 'Historical block-number mismatch')
  return h
}
export async function firstAtOrAfter(request, target, low, finalized) {
  if (finalized.timestamp < target) return null
  let lo = low,
    hi = finalized.block
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((await block(request, mid)).timestamp >= target) hi = mid
    else lo = mid + 1
  }
  const found = await block(request, lo)
  const previous = await block(request, lo - 1)
  assert(found.timestamp >= target && previous.timestamp < target, 'First target block not proven')
  assert(found.parentHash === previous.hash, 'First target/predecessor hash linkage failed')
  return { found, previous }
}
const tag = (h) => ({ blockHash: h.hash, requireCanonical: true })
async function call(request, row, name, args, h, from = ZERO) {
  const data = encodeFunctionData({ abi: ABI, functionName: name, args })
  const output = await request('eth_call', [{ from, to: row.vault, data, gas: toHex(GAS) }, tag(h)])
  return decodeFunctionResult({ abi: ABI, functionName: name, data: output })
}
export async function observe(request, row, h, baseline) {
  const result = { ...h, censoring: [] }
  const step = async (name, task) => {
    try {
      return await task()
    } catch (error) {
      if (error instanceof FatalReadError) throw error
      result.censoring.push(`${name}-${classify(error)}`)
      return undefined
    }
  }
  if (BigInt(h.gasLimit) < GAS) result.censoring.push('block-gas-limit-below-fixed-call')
  const code = await step('vault-code', () => request('eth_getCode', [row.vault, tag(h)]))
  if (code !== undefined) {
    result.runtimeCodeHash = codeHash(code)
    if (!result.runtimeCodeHash) result.censoring.push('missing-vault-code')
    else if (result.runtimeCodeHash !== row.baselineRuntimeCodeHash)
      result.censoring.push('vault-code-changed')
  }
  const holderCode = await step('holder-code', () => request('eth_getCode', [row.holder, tag(h)]))
  if (holderCode !== undefined) {
    result.holderCodeHash = codeHash(holderCode)
    if (result.holderCodeHash) result.censoring.push('holder-code-changed')
  }
  const proxy = await step('proxyImplementation', async () =>
    proxyAddress(await request('eth_getStorageAt', [row.vault, IMPLEMENTATION_SLOT, tag(h)])),
  )
  if (proxy !== undefined) {
    result.proxyImplementation = proxy
    if (!baseline && proxy !== row.baseline.proxyImplementation)
      result.censoring.push('proxyImplementation-changed')
    if (proxy) {
      const implCode = await step('proxyImplementationCodeHash', () =>
        request('eth_getCode', [proxy, tag(h)]),
      )
      if (implCode !== undefined) {
        result.proxyImplementationCodeHash = codeHash(implCode)
        if (!result.proxyImplementationCodeHash)
          result.censoring.push('missing-proxy-implementation-code')
        else if (
          !baseline &&
          result.proxyImplementationCodeHash !== row.baseline.proxyImplementationCodeHash
        )
          result.censoring.push('proxyImplementationCodeHash-changed')
      }
    }
  }
  for (const [field, method] of [
    ['asset', 'asset'],
    ['adapter', 'liquidityAdapter'],
  ]) {
    const value = await step(field, () => call(request, row, method, [], h))
    if (value !== undefined) {
      result[field] = value.toLowerCase()
      if (!baseline && result[field] !== row.baseline[field])
        result.censoring.push(`${field}-changed`)
    }
  }
  if (result.adapter && result.adapter !== ZERO) {
    const adapterCode = await step('adapterCodeHash', () =>
      request('eth_getCode', [result.adapter, tag(h)]),
    )
    if (adapterCode !== undefined) {
      result.adapterCodeHash = codeHash(adapterCode)
      if (!result.adapterCodeHash) result.censoring.push('missing-adapter-code')
      else if (!baseline && result.adapterCodeHash !== row.baseline.adapterCodeHash)
        result.censoring.push('adapterCodeHash-changed')
    }
    const adapterImpl = await step('adapterImplementation', async () =>
      proxyAddress(
        await request('eth_getStorageAt', [result.adapter, IMPLEMENTATION_SLOT, tag(h)]),
      ),
    )
    if (adapterImpl !== undefined) {
      result.adapterImplementation = adapterImpl
      if (!baseline && adapterImpl !== row.baseline.adapterImplementation)
        result.censoring.push('adapterImplementation-changed')
      if (adapterImpl) {
        const implCode = await step('adapterImplementationCodeHash', () =>
          request('eth_getCode', [adapterImpl, tag(h)]),
        )
        if (implCode !== undefined) {
          result.adapterImplementationCodeHash = codeHash(implCode)
          if (!result.adapterImplementationCodeHash)
            result.censoring.push('missing-adapter-implementation-code')
          else if (
            !baseline &&
            result.adapterImplementationCodeHash !== row.baseline.adapterImplementationCodeHash
          )
            result.censoring.push('adapterImplementationCodeHash-changed')
        }
      }
    }
  }
  const shares = await step('balance', () => call(request, row, 'balanceOf', [row.holder], h))
  if (shares !== undefined) {
    result.holderShares = shares.toString()
    const claim = await step('claim', () => call(request, row, 'previewRedeem', [shares], h))
    if (claim !== undefined) {
      result.holderClaimAssets = claim.toString()
      if (claim < BigInt(row.qAssets)) result.censoring.push('holder-claim-below-frozen-q')
    }
  }
  if (baseline) {
    assert(result.runtimeCodeHash === row.baselineRuntimeCodeHash, 'Frozen baseline code mismatch')
    assert(result.holderClaimAssets === row.baselineClaimAssets, 'Frozen baseline claim mismatch')
    assert(result.censoring.length === 0, 'Baseline identity preflight failed')
    result.status = 'baseline-observed'
    return result
  }
  const data = encodeFunctionData({
    abi: ABI,
    functionName: 'withdraw',
    args: [BigInt(row.qAssets), row.holder, row.holder],
  })
  const tx = { from: row.holder, to: row.vault, data, gas: toHex(GAS) }
  try {
    result.output = await request('eth_call', [tx, tag(h)])
    result.shares = decodeFunctionResult({
      abi: ABI,
      functionName: 'withdraw',
      data: result.output,
    }).toString()
    result.call = 'success'
  } catch (error) {
    if (error instanceof FatalReadError) throw error
    result.call = classify(error)
  }
  if (result.call === 'success') {
    try {
      result.gasEstimate = BigInt(await request('eth_estimateGas', [tx, tag(h)])).toString()
      result.gasStatus = 'observed'
      if (BigInt(result.gasEstimate) > BigInt(h.gasLimit) || BigInt(result.gasEstimate) > GAS)
        result.censoring.push('gas-estimate-above-limit')
    } catch (error) {
      if (error instanceof FatalReadError) throw error
      result.gasStatus = 'unavailable'
      result.censoring.push('gas-estimate-unavailable')
    }
  }
  if (result.call === 'gas-error' || result.call === 'rpc-or-archive-error')
    result.censoring.push('call-unresolved')
  result.status = result.censoring.length ? 'censored' : result.call
  return result
}

export async function run({
  client,
  treatedPath,
  manifestPath,
  factoryPath,
  stage1Path,
  out,
  maxRows = 4,
  onProgress = () => {},
  guard = diskGuard,
  observeFn = observe,
}) {
  assert(Number.isSafeInteger(maxRows) && maxRows >= 1 && maxRows <= 8, 'maxRows must be 1..8')
  const plan = loadPlan({ treatedPath, manifestPath, factoryPath, stage1Path })
  guard(out)
  let snapshot
  try {
    snapshot = verifySnapshot(JSON.parse(readFileSync(out)), plan)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    snapshot = atomic(out, empty(plan), guard)
  }
  const request = requestBudget(client, out, guard)
  request.scope()
  assert(BigInt(await request('eth_chainId', [])) === 1n, 'Wrong chain ID')
  const finalized = header(await request('eth_getBlockByNumber', ['finalized', false]))
  let touched = 0
  for (let i = 0; i < snapshot.rows.length; i++) {
    let row = snapshot.rows[i]
    if (row.baselineStatus !== 'baseline-success' || row.status === 'complete') continue
    if (touched >= maxRows) break
    touched++
    request.scope()
    const pre = await block(request, row.preBlock)
    assert(pre.hash === row.preBlockHash, 'B-1 canonical hash mismatch')
    if (!row.baseline) {
      row.baseline = await observeFn(request, row, pre, true)
      snapshot = atomic(out, snapshot, guard)
      row = snapshot.rows[i]
    }
    for (const [name, offset] of Object.entries(HORIZONS)) {
      if (row.outcomes[name] && row.outcomes[name].status !== 'not-finalized') continue
      request.scope()
      const target = row.executableAt + offset
      const boundary = await firstAtOrAfter(request, target, row.anchorBlock, finalized)
      if (!boundary) {
        row.outcomes[name] = {
          status: 'not-finalized',
          targetTimestamp: target,
          finalizedHead: finalized,
        }
        snapshot = atomic(out, snapshot, guard)
        row = snapshot.rows[i]
        continue
      }
      const probe = await observeFn(request, row, boundary.found, false)
      const targetAgain = await block(request, boundary.found.block)
      const finalizedAgain = await block(request, finalized.block)
      assert(targetAgain.hash === boundary.found.hash, 'Target hash changed during outcome read')
      assert(finalizedAgain.hash === finalized.hash, 'Finalized hash changed during outcome read')
      Object.assign(probe, {
        targetTimestamp: target,
        scheduledLeadSeconds: target - row.anchorTimestamp,
        previousHeader: boundary.previous,
        finalizedHead: finalized,
        canonicalRecheck: { targetHash: targetAgain.hash, finalizedHash: finalizedAgain.hash },
      })
      row.outcomes[name] = probe
      snapshot = atomic(out, snapshot, guard)
      row = snapshot.rows[i]
      onProgress({ index: row.index, horizon: name, status: probe.status })
    }
    row.status = Object.keys(HORIZONS).every(
      (name) => row.outcomes[name] && row.outcomes[name].status !== 'not-finalized',
    )
      ? 'complete'
      : 'partial'
    snapshot = atomic(out, snapshot, guard)
  }
  snapshot.status = snapshot.rows.every(
    (r) => r.status === 'complete' || r.status === 'baseline-ineligible',
  )
    ? 'complete'
    : 'partial'
  snapshot = atomic(out, snapshot, guard)
  return verifySnapshot(snapshot, plan)
}

function options(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    assert(argv[i].startsWith('--'), 'Expected --option')
    if (argv[i] === '--run' || argv[i] === '--verify') opts[argv[i].slice(2)] = true
    else {
      assert(argv[i + 1] && !argv[i + 1].startsWith('--'), 'Missing option value')
      opts[argv[i].slice(2)] = argv[++i]
    }
  }
  return opts
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = options(process.argv.slice(2))
  const baseDir = 'data/research/venue-signals/'
  const paths = {
    treatedPath: resolve(opts.treated || `${baseDir}morpho-v2-signer-baseline-v2.json`),
    manifestPath: resolve(opts.manifest || `${baseDir}morpho-v2-full-cohort-manifest.json`),
    factoryPath: resolve(opts.factory || `${baseDir}${FACTORY_SHA}.json`),
    stage1Path: resolve(opts.stage1 || `${baseDir}${STAGE1_SHA}.json`),
  }
  const out = resolve(opts.out || `${baseDir}morpho-v2-first64-treated-outcomes-v1.json`)
  try {
    const plan = loadPlan(paths)
    if (opts.verify) {
      const snapshot = verifySnapshot(JSON.parse(readFileSync(out)), plan)
      process.stdout.write(
        stable({
          study: STUDY,
          verified: true,
          status: snapshot.status,
          rows: snapshot.rows.length,
          sha256: sha(readFileSync(out)),
        }) + '\n',
      )
    } else if (!opts.run) {
      process.stdout.write(
        stable({
          study: STUDY,
          dry: true,
          denominator: N,
          eligible: plan.filter((r) => r.baselineStatus === 'baseline-success').length,
          horizons: HORIZONS,
          prospective: false,
          warning: 'prevalence/plumbing only, not 304 ITT or predictive validation',
        }) + '\n',
      )
    } else {
      const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      assert(rpc, 'RECORDER_RPC_URL required for --run')
      const result = await run({
        client: makeClient(rpc),
        ...paths,
        out,
        maxRows: opts['max-rows'] ? Number(opts['max-rows']) : 4,
        onProgress: (x) => process.stdout.write(stable(x) + '\n'),
      })
      process.stdout.write(
        stable({
          status: result.status,
          out,
          completed: result.rows.filter((r) => r.status === 'complete').length,
          sha256: sha(readFileSync(out)),
        }) + '\n',
      )
    }
  } catch {
    // Provider errors may include credential-bearing URLs.
    process.stderr.write('First64 treated outcomes stopped; sealed source/checkpoint retained.\n')
    process.exitCode = 1
  }
}
