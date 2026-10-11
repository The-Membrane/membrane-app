// Retrospective exact-holder exit grid. This is neither a prospective study nor a forecast.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'

import { makeClient, readEnv, ROOT } from '../lib/venue-reads.mjs'
import {
  findFirstBlockAtOrAfter,
  loadUniverse,
  logsBeforeAnchor,
  selectCandidates,
} from './carry-morpho-exit-history-panel.mjs'

const SHA = (value) => createHash('sha256').update(value).digest('hex')
const SAME = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const NUMBER = (value) => {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw Error('unsafe_number')
  return n
}
const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const MANIFEST_SHA = '8dd54bbb3dea0842bb67e582f0725adcafb7594107933122c5fa381c083566da'
export const DESIGN = Object.freeze({
  schemaVersion: 2,
  study: 'carry-morpho-v2-holder-exit-history-grid',
  chainId: 1,
  anchors: [26_062_740, 26_072_740],
  vaults: [
    '0xb885f6d448da7e2c642ec31190b629e40e87b069',
    '0xbeef003c68896c7d2c3c60d363e8d71a49ab2bf9',
    '0xbeefff4716a49418d69c251cab8759bb107e57c8',
  ],
  horizonsHours: [1, 4, 24],
  candidateLookbackBlocks: 4_096,
  candidateLimit: 8,
  holderSelection:
    'newest pre-B receipt-verified EOA with positive shares and >=10000 asset-unit claim; otherwise newest positive-share EOA',
  qLabels: ['fixed_10k', 'fixed_100k', 'fixed_1m', 'vault_0p1pct', 'vault_1pct', 'vault_5pct'],
  decimals:
    '6 underlying asset decimals and 18 VaultV2 share decimals verified at each measured block',
  call: 'withdraw(Q,holder,holder) from same holder at canonical EIP-1898 block hash with 20m gas',
  sample:
    'three feasibility-selected USDC/USDT vaults based on an earlier one-anchor panel; repeated holder/vault/anchor/size rows are dependent',
  manifestSha256: MANIFEST_SHA,
  forecast: false,
  prospectiveValidated: false,
})
export const WIDE_DESIGN = Object.freeze({
  ...DESIGN,
  schemaVersion: 3,
  study: 'carry-morpho-v2-holder-exit-history-grid-exploratory-wide',
  anchors: [26_053_740, 26_057_740, 26_061_740, 26_065_740, 26_069_740, 26_073_740],
  vaults: [
    '0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11',
    '0x36cfe1568461e499391ef0a555300f1ae2da2439',
    '0x8c106eedad96553e64287a5a6839c3cc78afa3d0',
    '0xb885f6d448da7e2c642ec31190b629e40e87b069',
    '0xbeef003c68896c7d2c3c60d363e8d71a49ab2bf9',
    '0xe05fadf242331808f504661bea65972594869826',
  ],
  sample:
    'exploratory stage selected after sparse two-anchor pilot; six fixed later anchors and six prior-panel-feasible USDC/USDT vaults; repeated holder/vault/anchor/size rows are dependent',
})
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const TOKEN_ABI = parseAbi(['function decimals() view returns (uint8)'])
const pinned = (hash) => ({ blockHash: hash, requireCanonical: true })
const errClass = (error) => {
  const message = Array.from({ length: 5 }, (_, i) => {
    let e = error
    for (let j = 0; j < i; j++) e = e?.cause
    return `${e?.name || ''} ${e?.shortMessage || ''} ${e?.details || ''} ${e?.message || ''}`
  })
    .join(' ')
    .toLowerCase()
  if (/out of gas|gas limit|exceeds block gas|intrinsic gas/.test(message)) return 'gas_error'
  if (/execution reverted|reverted with|contractfunctionrevertederror/.test(message))
    return 'evm_revert'
  return 'rpc_unavailable'
}
async function block(client, number) {
  const b = await client.getBlock({ blockNumber: BigInt(number) })
  if (b.number !== BigInt(number) || !HASH.test(b.hash || '') || typeof b.timestamp !== 'bigint')
    throw Error('archive_header_invalid')
  return { number: NUMBER(b.number), hash: b.hash.toLowerCase(), timestamp: NUMBER(b.timestamp) }
}

/** Every anchor and physical horizon is fixed before holder discovery or outcome reads. */
export async function freezePlan(client, anchorCount = 2, design = DESIGN) {
  if (!Number.isInteger(anchorCount) || anchorCount < 1 || anchorCount > design.anchors.length)
    throw Error('anchor_count_invalid')
  if ((await client.getChainId()) !== 1) throw Error('chain_mismatch')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  const head = {
    number: NUMBER(finalized.number),
    hash: finalized.hash.toLowerCase(),
    timestamp: NUMBER(finalized.timestamp),
  }
  const plans = []
  for (const number of design.anchors.slice(0, anchorCount)) {
    const anchor = await block(client, number)
    const horizons = []
    for (const hours of design.horizonsHours) {
      const target = anchor.timestamp + hours * 3600
      const h = await findFirstBlockAtOrAfter(client, anchor, target, head)
      if (h.realizedLagSeconds > 30 || h.realizedLagSeconds < 0) throw Error('horizon_header_gap')
      horizons.push({ hours, ...h })
    }
    plans.push({ anchor, horizons })
  }
  const schedule = { design, anchors: plans }
  return { schedule, planSha256: SHA(JSON.stringify(schedule)) }
}

export function receiptProvesTransfer(log, receipt, vault) {
  if (
    !log ||
    !receipt ||
    receipt.status !== 'success' ||
    !SAME(receipt.transactionHash, log.transactionHash) ||
    receipt.blockNumber !== log.blockNumber ||
    !SAME(receipt.blockHash, log.blockHash) ||
    !Number.isInteger(log.logIndex) ||
    !ADDRESS.test(log.address || '') ||
    !SAME(log.address, vault)
  )
    return false
  const exact = receipt.logs?.find((r) => r.logIndex === log.logIndex)
  return Boolean(
    exact &&
    SAME(exact.address, vault) &&
    SAME(exact.transactionHash, log.transactionHash) &&
    SAME(exact.blockHash, log.blockHash) &&
    exact.blockNumber === log.blockNumber &&
    SAME(exact.data, log.data) &&
    isDeepStrictEqual(
      exact.topics?.map((x) => x.toLowerCase()),
      log.topics?.map((x) => x.toLowerCase()),
    ),
  )
}

export function qLadder(totalAssets, claim, decimals, design = DESIGN) {
  if (decimals !== 6 || totalAssets <= 0n || claim < 0n) throw Error('q_ladder_identity_invalid')
  const unit = 10n ** BigInt(decimals)
  const q = [
    10_000n * unit,
    100_000n * unit,
    1_000_000n * unit,
    totalAssets / 1_000n,
    totalAssets / 100n,
    totalAssets / 20n,
  ]
  return design.qLabels.map((label, index) => ({
    label,
    assetsRaw: q[index].toString(),
    eligible: q[index] > 0n && q[index] <= claim,
    reason: q[index] <= 0n ? 'zero_sized' : q[index] > claim ? 'exceeds_anchor_holder_claim' : null,
  }))
}

export async function identity(client, subject, hash) {
  try {
    const [code, asset, vaultDecimals, assetDecimals] = await Promise.all([
      client.getCode({ address: subject.vault, ...pinned(hash) }),
      client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'asset',
        ...pinned(hash),
      }),
      client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'decimals',
        ...pinned(hash),
      }),
      client.readContract({
        address: subject.asset,
        abi: TOKEN_ABI,
        functionName: 'decimals',
        ...pinned(hash),
      }),
    ])
    if (
      !code ||
      code === '0x' ||
      !SAME(asset, subject.asset) ||
      NUMBER(vaultDecimals) !== 18 ||
      NUMBER(assetDecimals) !== 6
    )
      return {
        status: 'identity_changed',
        observedAsset: String(asset).toLowerCase(),
        shareDecimals: NUMBER(vaultDecimals),
        assetDecimals: NUMBER(assetDecimals),
      }
    return { status: 'confirmed', shareDecimals: 18, assetDecimals: 6 }
  } catch {
    return { status: 'rpc_unavailable' }
  }
}
export async function holderState(client, subject, owner, q, hash) {
  try {
    const [code, shares, previewShares] = await Promise.all([
      client.getCode({ address: owner, ...pinned(hash) }),
      client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'balanceOf',
        args: [owner],
        ...pinned(hash),
      }),
      client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'previewWithdraw',
        args: [q],
        ...pinned(hash),
      }),
    ])
    if (
      typeof shares !== 'bigint' ||
      shares < 0n ||
      typeof previewShares !== 'bigint' ||
      previewShares <= 0n
    )
      return { status: 'rpc_unavailable' }
    return {
      status: 'measured',
      eoa: !code || code === '0x',
      sharesRaw: shares.toString(),
      previewSharesRaw: previewShares.toString(),
    }
  } catch {
    return { status: 'rpc_unavailable' }
  }
}
export async function simulate(client, vault, owner, q, hash) {
  try {
    const data = encodeFunctionData({ abi: ABI, functionName: 'withdraw', args: [q, owner, owner] })
    const result = await client.call({
      account: owner,
      to: vault,
      data,
      gas: 20_000_000n,
      ...pinned(hash),
    })
    if (!result.data) return { status: 'rpc_unavailable' }
    const shares = decodeFunctionResult({ abi: ABI, functionName: 'withdraw', data: result.data })
    if (typeof shares !== 'bigint' || shares <= 0n) return { status: 'rpc_unavailable' }
    return { status: 'success', sharesBurnedRaw: shares.toString() }
  } catch (error) {
    return { status: errClass(error) }
  }
}
export function classifyProbe(identityResult, state, call) {
  if (identityResult.status !== 'confirmed') return identityResult.status
  if (state.status !== 'measured') return state.status
  if (!state.eoa) return 'holder_type_changed'
  if (call.status === 'success') {
    const burned = BigInt(call.sharesBurnedRaw)
    return burned <= 0n || burned > BigInt(state.sharesRaw) ? 'result_inconsistent' : 'success'
  }
  if (call.status === 'rpc_unavailable' || call.status === 'gas_error') return call.status
  if (BigInt(state.sharesRaw) < BigInt(state.previewSharesRaw)) return 'holder_attrition'
  return 'evm_revert'
}

async function selectHolder(client, subject, anchor, design) {
  const discovery = await logsBeforeAnchor(client, subject.vault, BigInt(anchor.number))
  const candidates = selectCandidates(
    discovery.logs,
    subject.vault,
    discovery.fromBlock,
    BigInt(anchor.number),
  )
  const bounded = candidates.slice(0, design.candidateLimit)
  const screened = []
  let selected = null,
    fallback = null
  for (const candidate of bounded) {
    const log = discovery.logs.find(
      (r) =>
        SAME(r.transactionHash, candidate.discoveryTransactionHash) &&
        r.logIndex === candidate.discoveryLogIndex,
    )
    const row = { ...candidate, receiptVerified: false, status: 'unavailable' }
    screened.push(row)
    if (!log) continue
    try {
      const [receipt, discoveryHeader, code] = await Promise.all([
        client.getTransactionReceipt({ hash: candidate.discoveryTransactionHash }),
        block(client, candidate.discoveryBlock),
        client.getCode({ address: candidate.owner, ...pinned(anchor.hash) }),
      ])
      if (
        !receiptProvesTransfer(log, receipt, subject.vault) ||
        !SAME(discoveryHeader.hash, candidate.discoveryBlockHash) ||
        discoveryHeader.timestamp > anchor.timestamp
      ) {
        row.status = 'receipt_or_header_mismatch'
        continue
      }
      row.receiptVerified = true
      if (code && code !== '0x') {
        row.status = 'contract_holder'
        continue
      }
      const shares = await client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'balanceOf',
        args: [candidate.owner],
        ...pinned(anchor.hash),
      })
      const claim =
        shares > 0n
          ? await client.readContract({
              address: subject.vault,
              abi: ABI,
              functionName: 'previewRedeem',
              args: [shares],
              ...pinned(anchor.hash),
            })
          : 0n
      if (typeof shares !== 'bigint' || typeof claim !== 'bigint' || shares <= 0n || claim <= 0n) {
        row.status = 'no_anchor_claim'
        continue
      }
      row.status = 'eligible_holder'
      row.sharesRaw = shares.toString()
      row.claimRaw = claim.toString()
      const choice = {
        owner: candidate.owner,
        sharesRaw: shares.toString(),
        claimRaw: claim.toString(),
        discovery: row,
      }
      if (!fallback) fallback = choice
      if (claim >= 10_000n * 1_000_000n) {
        selected = choice
        break
      }
    } catch {
      row.status = 'rpc_unavailable'
    }
  }
  return {
    candidateWindow: {
      fromBlock: NUMBER(discovery.fromBlock),
      throughBlock: NUMBER(discovery.throughBlock),
      transferLogs: discovery.logs.length,
      distinctRecipients: candidates.length,
      screened: screened.length,
    },
    screened,
    holder: selected || fallback,
  }
}

export async function measureVault(client, subject, plan, design) {
  const { anchor, horizons } = plan
  const base = {
    vault: subject.vault,
    asset: subject.asset,
    anchorBlock: anchor.number,
    status: 'unavailable',
  }
  if (subject.creationBlock >= anchor.number) return { ...base, status: 'not_created_at_anchor' }
  const baseIdentity = await identity(client, subject, anchor.hash)
  if (baseIdentity.status !== 'confirmed') return { ...base, status: baseIdentity.status }
  let totalAssets
  try {
    totalAssets = await client.readContract({
      address: subject.vault,
      abi: ABI,
      functionName: 'totalAssets',
      ...pinned(anchor.hash),
    })
  } catch {
    return { ...base, status: 'rpc_unavailable' }
  }
  if (typeof totalAssets !== 'bigint' || totalAssets <= 0n)
    return { ...base, status: 'unfunded_at_anchor' }
  let picked
  try {
    picked = await selectHolder(client, subject, anchor, design)
  } catch {
    return { ...base, status: 'discovery_unavailable' }
  }
  const row = {
    ...base,
    status: picked.holder ? 'measured' : 'no_eligible_holder',
    baselineIdentity: baseIdentity,
    totalAssetsRaw: totalAssets.toString(),
    candidateWindow: picked.candidateWindow,
    screenedCandidates: picked.screened,
  }
  if (!picked.holder) return row
  row.holder = picked.holder.owner
  row.holderDiscovery = picked.holder.discovery
  row.anchorSharesRaw = picked.holder.sharesRaw
  row.anchorClaimRaw = picked.holder.claimRaw
  row.sizes = []
  // Holder, total assets and all six Q values are now frozen. Future state is read only below.
  for (const size of qLadder(totalAssets, BigInt(row.anchorClaimRaw), 6, design)) {
    const item = { ...size, baseline: null, horizons: [] }
    if (!size.eligible) {
      row.sizes.push(item)
      continue
    }
    const q = BigInt(size.assetsRaw)
    const baselineState = await holderState(client, subject, row.holder, q, anchor.hash)
    const baselineCall = await simulate(client, subject.vault, row.holder, q, anchor.hash)
    item.baseline = {
      state: baselineState,
      call: baselineCall,
      class: classifyProbe(baseIdentity, baselineState, baselineCall),
    }
    row.sizes.push(item)
  }
  for (const horizon of horizons) {
    const horizonIdentity = await identity(client, subject, horizon.hash)
    for (const item of row.sizes) {
      if (!item.eligible) continue
      const q = BigInt(item.assetsRaw)
      const state =
        horizonIdentity.status === 'confirmed'
          ? await holderState(client, subject, row.holder, q, horizon.hash)
          : { status: 'not_read_identity' }
      const call =
        horizonIdentity.status === 'confirmed'
          ? await simulate(client, subject.vault, row.holder, q, horizon.hash)
          : { status: 'not_read_identity' }
      item.horizons.push({
        hours: horizon.hours,
        identity: horizonIdentity,
        state,
        call,
        class: classifyProbe(horizonIdentity, state, call),
      })
    }
  }
  for (const item of row.sizes) item.exitInterval = lossIntervals(item)
  return row
}

export function lossIntervals(size) {
  if (!size.eligible || size.baseline?.class !== 'success') return { riskSet: false }
  let lastSuccess = 0,
    lastComparable = 0,
    firstLoss = null,
    lastLoss = null,
    recovery = null,
    missing = 0,
    censoring = null
  for (const h of size.horizons) {
    if (['holder_attrition', 'identity_changed', 'holder_type_changed'].includes(h.class)) {
      if (!censoring)
        censoring = {
          afterHours: lastComparable,
          atHours: h.hours,
          class: h.class,
        }
      continue
    }
    if (censoring) {
      if (h.class !== 'success' && h.class !== 'evm_revert') missing++
      continue
    }
    if (h.class === 'success') {
      if (firstLoss && !recovery) recovery = { afterHours: lastLoss, throughHours: h.hours }
      if (!firstLoss) lastSuccess = h.hours
      lastComparable = h.hours
    } else if (h.class === 'evm_revert') {
      if (!firstLoss) firstLoss = { afterHours: lastSuccess, throughHours: h.hours, class: h.class }
      lastLoss = h.hours
      lastComparable = h.hours
    } else missing++
  }
  return {
    riskSet: true,
    firstLoss: firstLoss || { rightCensoredAtHours: lastSuccess },
    recovery: firstLoss ? recovery || { rightCensoredAtHours: lastLoss } : null,
    censoring,
    missingHorizons: missing,
  }
}

export function aggregate(rows, design = DESIGN) {
  const sizes = rows.flatMap((r) =>
    (r.sizes || []).map((s) => ({
      ...s,
      vault: r.vault,
      holder: r.holder,
      anchorBlock: r.anchorBlock,
    })),
  )
  const eligible = sizes.filter((s) => s.eligible)
  const risk = eligible.filter((s) => s.baseline?.class === 'success')
  const riskIntervals = risk.map((s) => lossIntervals(s))
  const counts = (values) =>
    Object.fromEntries(
      [...new Set(values)].sort().map((x) => [x, values.filter((y) => y === x).length]),
    )
  const result = {
    rowStatus: counts(rows.map((r) => r.status)),
    sizeEligibility: {
      eligible: eligible.length,
      ineligible: sizes.length - eligible.length,
      byLabel: Object.fromEntries(
        design.qLabels.map((label) => [label, eligible.filter((s) => s.label === label).length]),
      ),
    },
    baselineClass: counts(eligible.map((s) => s.baseline?.class || 'missing')),
    riskSet: {
      sizeRows: risk.length,
      firstLoss: counts(
        riskIntervals.map((interval) => interval.firstLoss?.class || 'right_censored'),
      ),
      censoring: counts(riskIntervals.map((interval) => interval.censoring?.class || 'none')),
      missingHorizons: riskIntervals.reduce((n, interval) => n + interval.missingHorizons, 0),
      uniqueHolders: new Set(risk.map((s) => s.holder)).size,
      uniqueVaults: new Set(risk.map((s) => s.vault)).size,
      uniqueHolderVaultPairs: new Set(risk.map((s) => `${s.holder}:${s.vault}`)).size,
      uniqueHolderVaultAnchors: new Set(risk.map((s) => `${s.holder}:${s.vault}:${s.anchorBlock}`))
        .size,
      independentObservations: false,
    },
  }
  if (design.study === WIDE_DESIGN.study)
    result.sampling = {
      vaultAnchorRows: rows.length,
      transferLogs: rows.reduce((n, r) => n + (r.candidateWindow?.transferLogs || 0), 0),
      distinctRecipientSlots: rows.reduce(
        (n, r) => n + (r.candidateWindow?.distinctRecipients || 0),
        0,
      ),
      screenedCandidateSlots: rows.reduce((n, r) => n + (r.candidateWindow?.screened || 0), 0),
      receiptVerifiedCandidateSlots: rows.reduce(
        (n, r) => n + (r.screenedCandidates || []).filter((c) => c.receiptVerified).length,
        0,
      ),
      selectedHolderRows: rows.filter((r) => r.status === 'measured').length,
      selectedUniqueHolders: new Set(
        rows.filter((r) => r.status === 'measured').map((r) => r.holder),
      ).size,
    }
  return result
}

export function validateGrid(grid) {
  const design =
    grid.study === DESIGN.study ? DESIGN : grid.study === WIDE_DESIGN.study ? WIDE_DESIGN : null
  if (
    !design ||
    grid.schemaVersion !== design.schemaVersion ||
    grid.chainId !== 1 ||
    grid.mode !== 'historical_read_only' ||
    grid.prospectiveValidated !== false ||
    grid.futureExitForecast !== false ||
    !isDeepStrictEqual(grid.design, design) ||
    grid.planSha256 !== SHA(JSON.stringify(grid.schedule)) ||
    !isDeepStrictEqual(grid.schedule.design, design) ||
    grid.schedule.anchors.length < 1 ||
    grid.schedule.anchors.length > design.anchors.length ||
    grid.rows.length !== grid.schedule.anchors.length * design.vaults.length ||
    !isDeepStrictEqual(grid.aggregates, aggregate(grid.rows, design))
  )
    throw Error('grid_invalid')
  const universe = loadUniverse()
  for (let ai = 0; ai < grid.schedule.anchors.length; ai++) {
    const plan = grid.schedule.anchors[ai]
    if (
      plan.anchor.number !== design.anchors[ai] ||
      !HASH.test(plan.anchor.hash || '') ||
      !isDeepStrictEqual(
        plan.horizons.map((h) => h.hours),
        design.horizonsHours,
      )
    )
      throw Error('grid_plan_invalid')
    for (const h of plan.horizons) {
      if (
        !HASH.test(h.hash || '') ||
        h.requestedTimestamp !== plan.anchor.timestamp + h.hours * 3600 ||
        h.timestamp - h.requestedTimestamp !== h.realizedLagSeconds ||
        h.realizedLagSeconds < 0 ||
        h.realizedLagSeconds > 30 ||
        h.priorTimestamp >= h.requestedTimestamp
      )
        throw Error('grid_horizon_invalid')
    }
    for (let vi = 0; vi < design.vaults.length; vi++) {
      const row = grid.rows[ai * design.vaults.length + vi]
      const subject = universe.find((e) => e.vault === design.vaults[vi])
      if (
        !subject ||
        ![USDC, USDT].includes(subject.asset) ||
        row.vault !== subject.vault ||
        row.asset !== subject.asset ||
        row.anchorBlock !== plan.anchor.number
      )
        throw Error('grid_row_identity_invalid')
      if (row.status !== 'measured') continue
      if (
        !isDeepStrictEqual(row.baselineIdentity, {
          status: 'confirmed',
          shareDecimals: 18,
          assetDecimals: 6,
        }) ||
        !ADDRESS.test(row.holder || '') ||
        row.holderDiscovery?.owner !== row.holder ||
        row.holderDiscovery.receiptVerified !== true ||
        row.holderDiscovery.discoveryBlock >= row.anchorBlock ||
        !HASH.test(row.holderDiscovery.discoveryBlockHash || '') ||
        !isDeepStrictEqual(
          row.sizes.map((s) => ({
            label: s.label,
            assetsRaw: s.assetsRaw,
            eligible: s.eligible,
            reason: s.reason,
          })),
          qLadder(BigInt(row.totalAssetsRaw), BigInt(row.anchorClaimRaw), 6, design),
        )
      )
        throw Error('grid_holder_or_sizes_invalid')
      for (const size of row.sizes) {
        if (!size.eligible) {
          if (size.baseline !== null || size.horizons.length !== 0)
            throw Error('grid_ineligible_measured')
          continue
        }
        if (
          size.baseline?.class !==
            classifyProbe({ status: 'confirmed' }, size.baseline.state, size.baseline.call) ||
          size.horizons.length !== 3 ||
          (design.study === WIDE_DESIGN.study &&
            !isDeepStrictEqual(size.exitInterval, lossIntervals(size))) ||
          (size.exitInterval && !isDeepStrictEqual(size.exitInterval, lossIntervals(size))) ||
          size.horizons.some(
            (h, i) =>
              h.hours !== design.horizonsHours[i] ||
              (h.identity.status === 'confirmed' &&
                !isDeepStrictEqual(h.identity, {
                  status: 'confirmed',
                  shareDecimals: 18,
                  assetDecimals: 6,
                })) ||
              h.class !== classifyProbe(h.identity, h.state, h.call),
          )
        )
          throw Error('grid_probe_invalid')
      }
    }
  }
  return true
}

export function saveOnce(grid) {
  validateGrid(grid)
  const bytes = Buffer.from(`${JSON.stringify(grid, null, 2)}\n`)
  const hash = SHA(bytes)
  const path = join(ROOT, `lib/carry/carry-morpho-exit-history-grid-${hash.slice(0, 16)}.json`)
  try {
    if (readFileSync(path).equals(bytes)) return { path, sha256: hash, replay: true }
    throw Error('artifact_conflict')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { flag: 'wx' })
  try {
    linkSync(temp, path)
  } finally {
    unlinkSync(temp)
  }
  return { path, sha256: hash, replay: false }
}

export async function run(client, anchorCount = 2, design = DESIGN) {
  if (
    ![DESIGN.study, WIDE_DESIGN.study].includes(design?.study) ||
    !isDeepStrictEqual(design, design.study === DESIGN.study ? DESIGN : WIDE_DESIGN)
  )
    throw Error('grid_design_invalid')
  const frozen = await freezePlan(client, anchorCount, design)
  const universe = loadUniverse()
  const subjects = design.vaults.map((v) => universe.find((e) => e.vault === v))
  if (subjects.some((e) => !e || ![USDC, USDT].includes(e.asset)))
    throw Error('stablecoin_universe_invalid')
  const rows = []
  for (const plan of frozen.schedule.anchors)
    for (const subject of subjects) rows.push(await measureVault(client, subject, plan, design))
  const grid = {
    schemaVersion: design.schemaVersion,
    study: design.study,
    chainId: 1,
    mode: 'historical_read_only',
    prospectiveValidated: false,
    futureExitForecast: false,
    design,
    schedule: frozen.schedule,
    planSha256: frozen.planSha256,
    rows,
    aggregates: aggregate(rows, design),
  }
  validateGrid(grid)
  return grid
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { get } = readEnv()
  const rpc = process.env.RECORDER_RPC_URL || get('RECORDER_RPC_URL')
  if (!rpc) throw Error('rpc_required')
  const n = Number(process.argv[2] || '1')
  const design = process.argv[3] === 'wide' ? WIDE_DESIGN : DESIGN
  run(makeClient(rpc), n, design)
    .then((grid) => {
      const saved = saveOnce(grid)
      process.stdout.write(
        JSON.stringify({
          path: saved.path,
          sha256: saved.sha256,
          anchors: grid.schedule.anchors.map((a) => a.anchor.number),
          aggregates: grid.aggregates,
        }) + '\n',
      )
    })
    .catch(() => {
      process.stderr.write('carry_morpho_exit_history_grid_failed\n')
      process.exitCode = 1
    })
}
