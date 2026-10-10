// Read-only, first-two-treated Morpho V2 outcome pilot. No alert inference.
// node scripts/research/morpho-v2-exit-outcome-pilot.mjs
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  collectHolderLogs,
  replayTransfers,
  STAGE1_SHA,
  FACTORY_SHA,
} from './morpho-v2-exit-baseline-pilot.mjs'

export const STUDY = 'morpho-v2-exit-outcome-pilot-v1'
export const BASELINE_SHA = '9b6755e9687c9303881bcbc71cafead0ae0904a42a27d1b89abb4a148b77dc66'
const HEAD = 26_052_740
const DAY = 86_400
const MAX_RPC_CALLS = 4_000
const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function liquidityAdapter() view returns (address)',
  'function withdraw(uint256,address,address) returns (uint256)',
])

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
function pinned(path, hash) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== hash) throw new Error('Pinned input SHA mismatch')
  return JSON.parse(bytes)
}
function strictInteger(value) {
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe integer')
  return n
}
function headerOf(block) {
  const result = {
    block: strictInteger(block.number),
    hash: block.hash,
    timestamp: strictInteger(block.timestamp),
  }
  if (!HASH.test(result.hash)) throw new Error('Invalid header hash')
  return result
}
async function retry(fn, count = 2) {
  for (let n = 0; ; n++) {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof BudgetError) throw error
      if (n >= count) throw error
      await new Promise((done) => setTimeout(done, 350 * 2 ** n))
    }
  }
}
class BudgetError extends Error {}
function budgetedClient(client, limit = MAX_RPC_CALLS) {
  let count = 0
  return new Proxy(client, {
    get(target, prop) {
      const value = target[prop]
      if (!['request', 'getChainId', 'getBlock', 'getCode', 'readContract'].includes(prop))
        return typeof value === 'function' ? value.bind(target) : value
      return (...args) => {
        if (++count > limit) throw new BudgetError(`RPC budget exhausted at ${limit} calls`)
        return value.apply(target, args)
      }
    },
  })
}
function sanitizedError(error) {
  let current = error
  const chain = []
  for (let i = 0; current && i < 5; i++, current = current.cause) {
    chain.push({
      name: typeof current.name === 'string' ? current.name.slice(0, 80) : null,
      code: Number.isInteger(current.code) ? current.code : null,
      data:
        typeof current.data === 'string' && /^0x[0-9a-f]*$/i.test(current.data)
          ? current.data.slice(0, 514)
          : null,
    })
  }
  const messages = []
  for (let c = error, i = 0; c && i < 5; c = c.cause, i++)
    if (typeof c.message === 'string') messages.push(c.message)
  const joined = messages.join(' ').toLowerCase()
  let category = 'rpc-or-archive-error'
  if (/out of gas|gas limit|intrinsic gas|exceeds block gas/.test(joined)) category = 'gas-error'
  else if (/execution reverted|vm execution error.*revert|reverted with/.test(joined))
    category = 'evm-revert'
  return { category, chain }
}

export function selectTreated(stage1, baseline) {
  if (
    stage1.study !== 'morpho-v2-cap-submit-stage1-v1' ||
    stage1.status !== 'complete' ||
    stage1.summary?.independentEligibleCount !== 304 ||
    !stage1.coverage?.complete ||
    baseline.study !== 'morpho-v2-exit-baseline-pilot-v1' ||
    baseline.maxVaults !== 20 ||
    baseline.status !== 'complete'
  )
    throw new Error('Frozen input cohort mismatch')
  const first = baseline.results.slice(0, 2)
  if (first.length !== 2 || first.some((x) => x.status !== 'baseline-success'))
    throw new Error('First two treated baselines must be successful')
  return first.map((x) => {
    const proposal = stage1.proposals[x.proposalIndex]
    if (
      proposal.vault.toLowerCase() !== x.vault ||
      proposal.block !== x.block ||
      stage1.summary.independentEligibleProposalIndexes.indexOf(x.proposalIndex) < 0
    )
      throw new Error('Baseline / Stage1 anchor mismatch')
    const eligibleTimes = proposal.executableAts
      .filter((_, i) => proposal.classes[i] === 'eligible')
      .map((v) => strictInteger(v))
      .sort((a, b) => a - b)
    if (
      !eligibleTimes.length ||
      !HASH.test(x.preBlockHash) ||
      !ADDRESS.test(x.holder) ||
      !/^\d+$/.test(x.qAssets) ||
      BigInt(x.qAssets) <= 0n
    )
      throw new Error('Invalid treated baseline')
    return {
      proposalIndex: x.proposalIndex,
      vault: x.vault,
      anchorBlock: x.block,
      anchorTimestamp: x.timestamp,
      preBlock: x.preBlock,
      preBlockHash: x.preBlockHash,
      asset: null,
      holder: x.holder,
      qAssets: x.qAssets,
      baselineRuntimeHash: x.runtimeCodeHash,
      executableAt: eligibleTimes[0],
      coInterventionTimes: eligibleTimes.slice(1),
    }
  })
}

export function eligibleControlCandidates({ factory, stage1, treated, asset }) {
  if (!ADDRESS.test(asset)) throw new Error('Invalid asset')
  const treatedCreation = factory.events.find((x) => x.vault.toLowerCase() === treated.vault)
  if (!treatedCreation || treatedCreation.timestamp >= treated.anchorTimestamp)
    throw new Error('Missing treated creation timestamp')
  const treatedAge = treated.anchorTimestamp - treatedCreation.timestamp
  const priorByVault = new Map()
  for (const log of stage1.rawEvents) {
    if (log.block >= treated.anchorBlock) continue
    const key = log.vault.toLowerCase()
    if (!priorByVault.has(key)) priorByVault.set(key, [])
    priorByVault.get(key).push(log)
  }
  const excluded = [],
    candidates = []
  for (const item of factory.events) {
    if (
      item.vault.toLowerCase() === treated.vault ||
      item.block >= treated.anchorBlock ||
      item.asset.toLowerCase() !== asset.toLowerCase()
    )
      continue
    const vault = item.vault.toLowerCase()
    const prior = priorByVault.get(vault) || []
    let reason = null
    if (prior.some((x) => x.timestamp >= treated.anchorTimestamp - 7 * DAY))
      reason = 'prior-seven-day-cap-submit'
    // TODO: resolve Accept/Revoke as-of B−1 before calling a prior proposal pending.
    // A future executableAt alone is only conservative uncertainty, not active state.
    else if (prior.some((x) => strictInteger(x.executableAt) > treated.anchorTimestamp))
      reason = 'prior-scheduled-state-unresolved'
    const candidate = {
      vault,
      asset: asset.toLowerCase(),
      creationBlock: item.block,
      creationTimestamp: item.timestamp,
      ageSeconds: treated.anchorTimestamp - item.timestamp,
    }
    if (reason) excluded.push({ ...candidate, reason })
    else candidates.push(candidate)
  }
  candidates.sort(
    (a, b) =>
      Math.abs(Math.log((a.ageSeconds + DAY) / (treatedAge + DAY))) -
        Math.abs(Math.log((b.ageSeconds + DAY) / (treatedAge + DAY))) ||
      a.vault.localeCompare(b.vault),
  )
  return { candidates, excluded }
}

async function contractRead(client, vault, functionName, args, block) {
  return retry(() =>
    client.readContract({
      address: vault,
      abi: ABI,
      functionName,
      args,
      blockNumber: BigInt(block),
    }),
  )
}
async function rawCall(client, vault, holder, q, block) {
  const data = encodeFunctionData({
    abi: ABI,
    functionName: 'withdraw',
    args: [BigInt(q), holder, holder],
  })
  try {
    // A fixed explicit gas ceiling makes future probes comparable and separates gas failures.
    const output = await retry(() =>
      client.request({
        method: 'eth_call',
        params: [{ from: holder, to: vault, data, gas: toHex(20_000_000) }, toHex(block)],
      }),
    )
    const shares = decodeFunctionResult({ abi: ABI, functionName: 'withdraw', data: output })
    return { status: 'success', output, shares: shares.toString() }
  } catch (error) {
    if (error instanceof BudgetError) throw error
    const { category, chain } = sanitizedError(error)
    return { status: category, errorChain: chain }
  }
}

async function screenCandidate({ client, candidate, treated, rawDir }) {
  const preBlock = treated.preBlock
  const result = { ...candidate, preBlock, reason: null }
  try {
    const header = headerOf(await retry(() => client.getBlock({ blockNumber: BigInt(preBlock) })))
    if (header.hash.toLowerCase() !== treated.preBlockHash.toLowerCase())
      throw new Error('Pre-anchor block hash mismatch')
    result.preBlockHash = header.hash
    const supply = await contractRead(client, candidate.vault, 'totalSupply', [], preBlock)
    const assets = await contractRead(client, candidate.vault, 'totalAssets', [], preBlock)
    result.totalSupply = supply.toString()
    result.totalAssets = assets.toString()
    if (supply <= 0n || assets <= 0n) return { ...result, reason: 'unfunded' }
    const asset = await contractRead(client, candidate.vault, 'asset', [], preBlock)
    if (asset.toLowerCase() !== treated.asset)
      return { ...result, reason: 'asset-mismatch-at-b-minus-1' }
    const adapter = await contractRead(client, candidate.vault, 'liquidityAdapter', [], preBlock)
    const idle = await retry(() =>
      client.readContract({
        address: asset,
        abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [candidate.vault],
        blockNumber: BigInt(preBlock),
      }),
    )
    result.adapterPresent = adapter.toLowerCase() !== '0x0000000000000000000000000000000000000000'
    result.idleAssets = idle.toString()
    result.idleFraction = Math.min(1, Number((idle * 1_000_000n) / assets) / 1_000_000)
    const anchor = {
      vault: candidate.vault,
      block: treated.anchorBlock,
      creationBlock: candidate.creationBlock,
      proposalIndex: treated.proposalIndex,
    }
    const rawPath = resolve(
      rawDir,
      `${candidate.vault}-${treated.anchorBlock}-control-transfers.json`,
    )
    const raw = await collectHolderLogs({ client, anchor, rawPath })
    result.rawLogPath = rawPath
    result.rawLogSha256 = sha(readFileSync(rawPath))
    result.rawLogCount = raw.logs.length
    const holders = replayTransfers(raw.logs)
    if (holders.reduce((sum, [, value]) => sum + value, 0n) !== supply)
      return { ...result, reason: 'share-ledger-supply-mismatch' }
    for (const [holder, shares] of holders) {
      const code = await retry(() =>
        client.getCode({ address: holder, blockNumber: BigInt(preBlock) }),
      )
      if (code && code !== '0x') continue
      if ((await contractRead(client, candidate.vault, 'balanceOf', [holder], preBlock)) !== shares)
        return { ...result, reason: 'share-ledger-holder-mismatch' }
      result.holder = holder
      result.holderShares = shares.toString()
      const claim = await contractRead(client, candidate.vault, 'previewRedeem', [shares], preBlock)
      result.holderClaimAssets = claim.toString()
      if (claim < BigInt(treated.qAssets))
        return { ...result, reason: 'holder-claim-below-treated-q' }
      result.baselineCall = await rawCall(
        client,
        candidate.vault,
        holder,
        treated.qAssets,
        preBlock,
      )
      if (
        result.baselineCall.status === 'rpc-or-archive-error' ||
        result.baselineCall.status === 'gas-error'
      )
        throw new Error('Control baseline transport/gas unresolved')
      return {
        ...result,
        reason:
          result.baselineCall.status === 'success'
            ? 'baseline-success'
            : `baseline-${result.baselineCall.status}`,
      }
    }
    return { ...result, reason: 'no-positive-eoa-holder' }
  } catch (error) {
    if (error instanceof BudgetError) throw error
    // Missing archive/transport state cannot make a control silently ineligible.
    throw new Error('Control screening inconclusive', { cause: error })
  }
}

export function matchDistance(candidate, treatedState, treatedAgeSeconds) {
  return (
    Math.abs(
      Math.log((Number(candidate.totalAssets) + 1) / (Number(treatedState.totalAssets) + 1)),
    ) +
    Math.abs(Math.log((candidate.ageSeconds + DAY) / (treatedAgeSeconds + DAY))) +
    2 * Math.abs(candidate.idleFraction - treatedState.idleFraction) +
    Number(candidate.adapterPresent !== treatedState.adapterPresent)
  )
}

export function validateCompleteCheckpoint(
  saved,
  treated,
  { allowMissingNormalizedBaseline = false } = {},
) {
  if (saved.status !== 'complete') return
  if (!Array.isArray(saved.treated) || saved.treated.length !== 2 || treated.length !== 2)
    throw new Error('Complete checkpoint must contain exactly two treated rows')
  for (let i = 0; i < 2; i++) {
    const row = saved.treated[i],
      anchor = treated[i]
    if (
      !row ||
      row.phase !== 'complete' ||
      JSON.stringify({ ...row.anchor, asset: null }) !== JSON.stringify(anchor) ||
      !ADDRESS.test(row.anchor.asset || '') ||
      !Array.isArray(row.screened) ||
      !Array.isArray(row.controls) ||
      !Array.isArray(row.candidateOrder) ||
      row.controls.length > 2 ||
      !row.probes ||
      Object.keys(row.probes).length !== 3
    )
      throw new Error('Complete treated row frontier mismatch')
    const normalized = row.normalizedBaseline
    if (!normalized && !allowMissingNormalizedBaseline)
      throw new Error('Missing normalized treated baseline')
    if (
      normalized &&
      (normalized.block !== anchor.preBlock ||
        normalized.hash !== anchor.preBlockHash ||
        normalized.holder !== anchor.holder ||
        normalized.qAssets !== anchor.qAssets ||
        normalized.gasLimit !== 20_000_000 ||
        !Number.isSafeInteger(normalized.timestamp) ||
        !['success', 'evm-revert', 'gas-error', 'rpc-or-archive-error'].includes(
          normalized.status,
        ) ||
        row.evaluability !==
          (normalized.status === 'success'
            ? 'evaluable'
            : 'censored-normalized-baseline-not-success') ||
        (normalized.status === 'success' &&
          (!/^0x[0-9a-f]{64}$/i.test(normalized.output || '') ||
            !/^\d+$/.test(normalized.shares || ''))))
    )
      throw new Error('Normalized treated baseline mismatch')
    const screenedByVault = new Map(row.screened.map((x) => [x.vault, x]))
    for (const control of row.controls) {
      const screened = screenedByVault.get(control.vault)
      if (
        !screened ||
        screened.reason !== 'baseline-success' ||
        screened.baselineCall?.status !== 'success' ||
        screened.holder !== control.holder ||
        screened.totalAssets !== control.totalAssets ||
        !Number.isFinite(control.distance)
      )
        throw new Error('Selected control not supported by screened baseline')
    }
    const horizons = {
      preExecutable: row.anchor.executableAt,
      plus24h: row.anchor.executableAt + DAY,
      plus7d: row.anchor.executableAt + 7 * DAY,
    }
    for (const [label, target] of Object.entries(horizons)) {
      const probe = row.probes[label]
      if (!probe || probe.targetTimestamp !== target || !probe.controls)
        throw new Error('Missing complete horizon probe')
      if (probe.header === null) {
        const expectedStatus =
          label === 'preExecutable'
            ? ['head-truncated', 'no-pre-executable-block']
            : ['head-truncated']
        if (
          !expectedStatus.includes(probe.status) ||
          probe.treated !== null ||
          Object.keys(probe.controls).length !== 0
        )
          throw new Error('Invalid censored horizon probe')
        if (probe.status === 'head-truncated') {
          const head = saved.headerCache[String(saved.pinnedHeadBlock)]
          if (!head || !Number.isSafeInteger(head.timestamp) || head.timestamp >= target)
            throw new Error('Head-truncated horizon lacks pinned head evidence')
        }
        continue
      }
      if (
        !probe.header ||
        !probe.treated ||
        Object.keys(probe.controls).length !== row.controls.length
      )
        throw new Error('Missing complete horizon probe')
      const header = probe.header
      const cached = saved.headerCache[String(header.block)]
      if (
        !cached ||
        cached.block !== header.block ||
        cached.hash !== header.hash ||
        cached.timestamp !== header.timestamp ||
        !HASH.test(header.hash) ||
        (label === 'preExecutable' ? header.timestamp >= target : header.timestamp < target)
      )
        throw new Error('Horizon header/cache mismatch')
      const records = [probe.treated, ...row.controls.map((c) => probe.controls[c.vault])]
      for (const result of records) {
        if (
          !result ||
          result.block !== header.block ||
          result.hash !== header.hash ||
          result.timestamp !== header.timestamp ||
          (result.status !== 'preflight-error' && result.holderCodeHash === undefined) ||
          ![
            'success',
            'evm-revert',
            'gas-error',
            'rpc-or-archive-error',
            'holder-attrition',
            'holder-code-changed',
            'missing-code',
            'preflight-error',
          ].includes(result.status)
        )
          throw new Error('Saved probe result/header mismatch')
        if (
          result.status === 'success' &&
          (!/^0x[0-9a-f]{64}$/i.test(result.output || '') || !/^\d+$/.test(result.shares || ''))
        )
          throw new Error('Saved success lacks decoded output')
        if (
          result.status === 'preflight-error' &&
          (!['vault-code', 'holder-code', 'balanceOf', 'previewRedeem'].includes(
            result.failedRead,
          ) ||
            !['evm-revert', 'gas-error', 'rpc-or-archive-error'].includes(result.errorCategory))
        )
          throw new Error('Saved preflight error lacks stage/category')
      }
    }
  }
}

async function blockAtOrAfter(client, target, first, last, headerCache, save) {
  async function get(number) {
    const key = String(number)
    if (!headerCache[key]) {
      headerCache[key] = headerOf(
        await retry(() => client.getBlock({ blockNumber: BigInt(number) })),
      )
      save()
    }
    return headerCache[key]
  }
  if ((await get(last)).timestamp < target) return null
  let lo = first,
    hi = last
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((await get(mid)).timestamp >= target) hi = mid
    else lo = mid + 1
  }
  const block = await get(lo)
  const previous = lo > first ? await get(lo - 1) : null
  if (previous && previous.timestamp >= target) throw new Error('Timestamp search invariant failed')
  return block
}

async function cachedHeader(client, number, headerCache, save) {
  const key = String(number)
  if (!headerCache[key]) {
    headerCache[key] = headerOf(await retry(() => client.getBlock({ blockNumber: BigInt(number) })))
    save()
  }
  return headerCache[key]
}

export function crossoverAt(stage1, vault, anchorBlock, outcomeBlock) {
  const found = stage1.rawEvents.filter(
    (x) => x.vault.toLowerCase() === vault && x.block >= anchorBlock && x.block <= outcomeBlock,
  )
  return found.length
    ? { count: found.length, firstBlock: found[0].block, firstTxHash: found[0].txHash }
    : null
}

export async function probeExit({
  client,
  vault,
  holder,
  q,
  header,
  executableAt,
  stage1,
  anchorBlock,
  control,
}) {
  const result = {
    ...header,
    secondsFromExecutable: header.timestamp - executableAt,
    crossover: control ? crossoverAt(stage1, vault, anchorBlock, header.block) : null,
  }
  async function preflightRead(name, operation) {
    try {
      return await retry(operation)
    } catch (error) {
      if (error instanceof BudgetError) throw error
      const { category, chain } = sanitizedError(error)
      return {
        preflightError: true,
        status: 'preflight-error',
        failedRead: name,
        errorCategory: category,
        errorChain: chain,
      }
    }
  }
  const code = await preflightRead('vault-code', () =>
    client.getCode({ address: vault, blockNumber: BigInt(header.block) }),
  )
  if (code?.preflightError) return { ...result, ...code }
  result.runtimeCodeHash = code && code !== '0x' ? keccak256(code) : null
  if (!result.runtimeCodeHash) return { ...result, status: 'missing-code' }
  const holderCode = await preflightRead('holder-code', () =>
    client.getCode({ address: holder, blockNumber: BigInt(header.block) }),
  )
  if (holderCode?.preflightError) return { ...result, ...holderCode }
  result.holderCodeHash = holderCode && holderCode !== '0x' ? keccak256(holderCode) : null
  if (result.holderCodeHash) return { ...result, status: 'holder-code-changed' }
  const balance = await preflightRead('balanceOf', () =>
    client.readContract({
      address: vault,
      abi: ABI,
      functionName: 'balanceOf',
      args: [holder],
      blockNumber: BigInt(header.block),
    }),
  )
  if (balance?.preflightError) return { ...result, ...balance }
  const claim = await preflightRead('previewRedeem', () =>
    client.readContract({
      address: vault,
      abi: ABI,
      functionName: 'previewRedeem',
      args: [balance],
      blockNumber: BigInt(header.block),
    }),
  )
  if (claim?.preflightError) return { ...result, ...claim }
  result.holderShares = balance.toString()
  result.holderClaimAssets = claim.toString()
  if (claim < BigInt(q)) return { ...result, status: 'holder-attrition' }
  const call = await rawCall(client, vault, holder, q, header.block)
  return { ...result, ...call }
}

export async function run({
  client,
  stage1Path,
  factoryPath,
  baselinePath,
  out,
  rawDir,
  onProgress = () => {},
}) {
  client = budgetedClient(client)
  const stage1 = pinned(stage1Path, STAGE1_SHA)
  const factory = pinned(factoryPath, FACTORY_SHA)
  const baseline = pinned(baselinePath, BASELINE_SHA)
  const treated = selectTreated(stage1, baseline)
  const expected = {
    study: STUDY,
    chainId: 1,
    stage1Sha256: STAGE1_SHA,
    factorySha256: FACTORY_SHA,
    baselineSha256: BASELINE_SHA,
    frozenDenominator: 304,
    pilotTreatedIndexes: treated.map((x) => x.proposalIndex),
    pinnedHeadBlock: HEAD,
    pinnedHeadHash: stage1.pinnedHeadHash,
  }
  let saved = existsSync(out)
    ? JSON.parse(readFileSync(out, 'utf8'))
    : { ...expected, status: 'partial', headerCache: {}, treated: [] }
  for (const [key, value] of Object.entries(expected))
    if (JSON.stringify(saved[key]) !== JSON.stringify(value))
      throw new Error('Checkpoint metadata mismatch')
  if (
    !Array.isArray(saved.treated) ||
    saved.treated.length > 2 ||
    !saved.headerCache ||
    typeof saved.headerCache !== 'object'
  )
    throw new Error('Invalid checkpoint structure')
  for (const row of saved.treated) {
    if (
      !row ||
      !Array.isArray(row.screened) ||
      !Array.isArray(row.controls) ||
      !Array.isArray(row.excluded) ||
      !row.probes ||
      !['init', 'screening', 'probes', 'complete'].includes(row.phase)
    )
      throw new Error('Invalid treated checkpoint')
    for (const c of row.screened)
      if (c.rawLogPath) {
        if (!existsSync(c.rawLogPath) || sha(readFileSync(c.rawLogPath)) !== c.rawLogSha256)
          throw new Error('Screened holder-ledger cache SHA mismatch')
        const raw = JSON.parse(readFileSync(c.rawLogPath, 'utf8'))
        if (
          raw.status !== 'complete' ||
          raw.vault !== c.vault ||
          raw.throughBlock !== c.preBlock ||
          raw.logs.length !== c.rawLogCount
        )
          throw new Error('Screened holder-ledger cache metadata mismatch')
        replayTransfers(raw.logs)
      }
  }
  validateCompleteCheckpoint(saved, treated, { allowMissingNormalizedBaseline: true })
  const save = () => atomic(out, saved)
  const missingNormalized = saved.treated.some(
    (row) => row.phase === 'complete' && !row.normalizedBaseline,
  )
  const missingHolderChecks = saved.treated.some((row) =>
    Object.values(row.probes).some(
      (probe) =>
        probe.header &&
        [probe.treated, ...Object.values(probe.controls)].some(
          (x) => x && x.status !== 'preflight-error' && x.holderCodeHash === undefined,
        ),
    ),
  )
  if (saved.status === 'complete' && !missingHolderChecks && !missingNormalized) {
    validateCompleteCheckpoint(saved, treated)
    return saved
  }
  if ((await retry(() => client.getChainId())) !== 1) throw new Error('Wrong chain')
  const head = headerOf(await retry(() => client.getBlock({ blockNumber: BigInt(HEAD) })))
  if (head.hash.toLowerCase() !== stage1.pinnedHeadHash.toLowerCase())
    throw new Error('Pinned head hash mismatch')
  if (missingNormalized) {
    for (const row of saved.treated) {
      if (row.phase !== 'complete' || row.normalizedBaseline) continue
      const anchor = row.anchor
      const header = headerOf(
        await retry(() =>
          client.getBlock({
            blockNumber: BigInt(anchor.preBlock),
          }),
        ),
      )
      if (header.hash.toLowerCase() !== anchor.preBlockHash.toLowerCase())
        throw new Error('Normalized baseline pinned block mismatch')
      const call = await rawCall(
        client,
        anchor.vault,
        anchor.holder,
        anchor.qAssets,
        anchor.preBlock,
      )
      row.normalizedBaseline = {
        ...header,
        holder: anchor.holder,
        qAssets: anchor.qAssets,
        gasLimit: 20_000_000,
        ...call,
      }
      row.evaluability =
        call.status === 'success' ? 'evaluable' : 'censored-normalized-baseline-not-success'
      save()
      onProgress({
        normalizedBaseline: anchor.vault,
        status: call.status,
        evaluability: row.evaluability,
      })
    }
  }
  if (missingHolderChecks) {
    for (const row of saved.treated)
      for (const probe of Object.values(row.probes)) {
        if (!probe.header) continue
        const checked = headerOf(
          await retry(() =>
            client.getBlock({
              blockNumber: BigInt(probe.header.block),
            }),
          ),
        )
        if (
          checked.hash.toLowerCase() !== probe.header.hash.toLowerCase() ||
          checked.timestamp !== probe.header.timestamp
        )
          throw new Error('Saved probe block identity mismatch')
        const entries = [
          [row.anchor.vault, row.anchor.holder, probe.treated],
          ...row.controls.map((c) => [c.vault, c.holder, probe.controls[c.vault]]),
        ]
        for (const [vault, holder, existing] of entries) {
          if (!existing || existing.holderCodeHash !== undefined) continue
          const code = await retry(() =>
            client.getCode({ address: holder, blockNumber: BigInt(checked.block) }),
          )
          const hash = code && code !== '0x' ? keccak256(code) : null
          existing.holderCodeHash = hash
          if (hash) {
            existing.uncensoredPriorCall = {
              status: existing.status,
              output: existing.output || null,
            }
            existing.status = 'holder-code-changed'
          }
          save()
          onProgress({ holderCodeBackfill: vault, block: checked.block, status: existing.status })
        }
      }
    if (saved.status === 'complete') {
      validateCompleteCheckpoint(saved, treated)
      return saved
    }
  }
  for (let i = 0; i < 2; i++) {
    const t = treated[i]
    if (!saved.treated[i]) {
      saved.treated[i] = {
        anchor: t,
        phase: 'init',
        screened: [],
        excluded: [],
        controls: [],
        probes: {},
      }
      save()
    }
    const row = saved.treated[i]
    if (JSON.stringify({ ...row.anchor, asset: null }) !== JSON.stringify(t))
      throw new Error('Treated anchor mismatch')
    if (row.phase === 'init') {
      const asset = await contractRead(client, t.vault, 'asset', [], t.preBlock)
      const adapter = await contractRead(client, t.vault, 'liquidityAdapter', [], t.preBlock)
      const idle = await retry(() =>
        client.readContract({
          address: asset,
          abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
          functionName: 'balanceOf',
          args: [t.vault],
          blockNumber: BigInt(t.preBlock),
        }),
      )
      const baselineResult = baseline.results[i]
      const assets = BigInt(baselineResult.totalAssets)
      row.anchor.asset = asset.toLowerCase()
      row.treatedState = {
        totalAssets: assets.toString(),
        idleAssets: idle.toString(),
        idleFraction: Math.min(1, Number((idle * 1_000_000n) / assets) / 1_000_000),
        adapterPresent: adapter.toLowerCase() !== '0x0000000000000000000000000000000000000000',
      }
      const risk = eligibleControlCandidates({
        factory,
        stage1,
        treated: t,
        asset: row.anchor.asset,
      })
      row.candidateOrder = risk.candidates
      row.excluded = risk.excluded
      row.phase = 'screening'
      save()
    }
    if (row.phase === 'screening') {
      // Age-nearest order is frozen before any future-state reads. Screen in 32-vault batches.
      let success = row.screened.filter((x) => x.reason === 'baseline-success').length
      while (row.screened.length < row.candidateOrder.length && success < 2) {
        const batchEnd = Math.min(
          row.candidateOrder.length,
          Math.ceil((row.screened.length + 1) / 32) * 32,
        )
        while (row.screened.length < batchEnd) {
          const candidate = row.candidateOrder[row.screened.length]
          const result = await screenCandidate({ client, candidate, treated: row.anchor, rawDir })
          row.screened.push(result)
          if (result.reason === 'baseline-success') success++
          save()
          onProgress({
            treated: i,
            screened: row.screened.length,
            candidate: candidate.vault,
            reason: result.reason,
          })
        }
      }
      const creation = factory.events.find((x) => x.vault.toLowerCase() === t.vault)
      const age = t.anchorTimestamp - creation.timestamp
      const eligible = row.screened.filter((x) => x.reason === 'baseline-success')
      row.controls = eligible
        .map((x) => ({ ...x, distance: matchDistance(x, row.treatedState, age) }))
        .sort((a, b) => a.distance - b.distance || a.vault.localeCompare(b.vault))
        .slice(0, 2)
      row.phase = 'probes'
      save()
    }
    if (row.phase === 'probes' && !row.normalizedBaseline) {
      const header = headerOf(
        await retry(() =>
          client.getBlock({
            blockNumber: BigInt(t.preBlock),
          }),
        ),
      )
      if (header.hash.toLowerCase() !== t.preBlockHash.toLowerCase())
        throw new Error('Normalized baseline pinned block mismatch')
      const call = await rawCall(client, t.vault, t.holder, t.qAssets, t.preBlock)
      row.normalizedBaseline = {
        ...header,
        holder: t.holder,
        qAssets: t.qAssets,
        gasLimit: 20_000_000,
        ...call,
      }
      row.evaluability =
        call.status === 'success' ? 'evaluable' : 'censored-normalized-baseline-not-success'
      save()
    }
    if (row.phase === 'probes') {
      const pre = await blockAtOrAfter(
        client,
        t.executableAt,
        t.anchorBlock,
        HEAD,
        saved.headerCache,
        save,
      )
      const plus24 = await blockAtOrAfter(
        client,
        t.executableAt + DAY,
        t.anchorBlock,
        HEAD,
        saved.headerCache,
        save,
      )
      const plus7d = await blockAtOrAfter(
        client,
        t.executableAt + 7 * DAY,
        t.anchorBlock,
        HEAD,
        saved.headerCache,
        save,
      )
      const preHeader =
        pre?.block > t.anchorBlock
          ? await cachedHeader(client, pre.block - 1, saved.headerCache, save)
          : null
      if (preHeader && !(preHeader.timestamp < t.executableAt && pre.timestamp >= t.executableAt))
        throw new Error('Pre-executable timestamp invariant failed')
      const horizons = { preExecutable: preHeader, plus24h: plus24, plus7d }
      for (const [label, header] of Object.entries(horizons)) {
        if (!row.probes[label])
          row.probes[label] = {
            targetTimestamp:
              label === 'preExecutable'
                ? t.executableAt
                : t.executableAt + (label === 'plus24h' ? DAY : 7 * DAY),
            header: header || null,
            treated: null,
            controls: {},
          }
        const p = row.probes[label]
        if (!header) {
          p.status = label === 'preExecutable' && pre ? 'no-pre-executable-block' : 'head-truncated'
          save()
          continue
        }
        if (!p.treated) {
          p.treated = await probeExit({
            client,
            vault: t.vault,
            holder: t.holder,
            q: t.qAssets,
            header,
            executableAt: t.executableAt,
            stage1,
            anchorBlock: t.anchorBlock,
            control: false,
          })
          save()
        }
        for (const c of row.controls)
          if (!p.controls[c.vault]) {
            p.controls[c.vault] = await probeExit({
              client,
              vault: c.vault,
              holder: c.holder,
              q: t.qAssets,
              header,
              executableAt: t.executableAt,
              stage1,
              anchorBlock: t.anchorBlock,
              control: true,
            })
            save()
          }
      }
      row.phase = 'complete'
      save()
      onProgress({ treated: i, phase: row.phase, controls: row.controls.length })
    }
  }
  saved.status = 'complete'
  save()
  validateCompleteCheckpoint(saved, treated)
  return saved
}

function options(args) {
  const result = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error('Expected --key value')
    result[args[i].slice(2)] = args[i + 1]
  }
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = options(process.argv.slice(2))
  const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('RECORDER_RPC_URL is required')
  const out = resolve(opts.out || 'data/research/venue-signals/morpho-v2-exit-outcome-pilot.json')
  try {
    const result = await run({
      client: makeClient(rpc),
      stage1Path: resolve(opts.stage1 || `data/research/venue-signals/${STAGE1_SHA}.json`),
      factoryPath: resolve(opts.factory || `data/research/venue-signals/${FACTORY_SHA}.json`),
      baselinePath: resolve(
        opts.baseline || 'data/research/venue-signals/morpho-v2-exit-baseline-first20.json',
      ),
      out,
      rawDir: resolve(opts['raw-dir'] || 'data/research/venue-signals/morpho-v2-exit-outcome-raw'),
      onProgress: (x) => process.stdout.write(JSON.stringify(x) + '\n'),
    })
    process.stdout.write(
      JSON.stringify({
        status: result.status,
        out,
        sha256: sha(readFileSync(out)),
        treated: result.treated.map((x) => ({
          proposalIndex: x.anchor.proposalIndex,
          controls: x.controls.length,
          statuses: Object.fromEntries(
            Object.entries(x.probes).map(([k, v]) => [k, v.treated?.status || v.status]),
          ),
        })),
      }) + '\n',
    )
  } catch (error) {
    // Never print nested RPC errors; provider URLs may contain credentials.
    process.stderr.write(`Outcome pilot stopped; checkpoint remains at ${out}. ${error.message}\n`)
    process.exitCode = 1
  }
}
