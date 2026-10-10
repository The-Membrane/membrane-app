// Outcome-B-blind B−1 plan. No RPC, B state, post-B outcome, or matched-control claim.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { readFactory } from './morpho-v2-route-census.mjs'
import { readSealedRouteRiskManifest } from './morpho-v2-route-risk-manifest.mjs'

const WITHDRAW_ABI = parseAbi(['function withdraw(uint256,address,address) returns (uint256)'])
const PROBE_GAS = toHex(20_000_000)

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const address = (value) => /^0x[0-9a-f]{40}$/.test(value)
const hash = (value) => /^0x[0-9a-f]{64}$/.test(value)
const uint = (value) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid raw integer')
  return BigInt(value)
}

export function buildFullBaselinePlan(manifest, factoryEvents) {
  if (
    manifest?.study !== 'morpho-v2-route-risk-manifest-v1' ||
    manifest.transitionCount !== 116 ||
    manifest.transitions?.length !== 116 ||
    !Array.isArray(factoryEvents)
  )
    throw new Error('Complete 116-transition source manifest required')
  const factory = new Map()
  for (const event of factoryEvents) {
    const vault = String(event.vault || '').toLowerCase()
    const asset = String(event.asset || '').toLowerCase()
    if (
      !address(vault) ||
      !address(asset) ||
      !Number.isSafeInteger(event.block) ||
      factory.has(vault)
    )
      throw new Error('Invalid factory creation row')
    factory.set(vault, { vault, asset, block: event.block })
  }
  const anchors = manifest.transitions.map((row, index) => {
    if (
      row.chronologicalIndex !== index ||
      !address(row.vault) ||
      !address(row.asset) ||
      !address(row.fromAdapter) ||
      !hash(row.blockHash) ||
      !hash(row.txHash) ||
      !Number.isSafeInteger(row.block) ||
      row.block < 1 ||
      !Array.isArray(row.sameAssetFactoryVaultsCreatedBeforeB) ||
      !row.sameAssetFactoryVaultsCreatedBeforeB.includes(row.vault) ||
      row.sameAssetFactoryVaultsCreatedBeforeB.some((vault) => !address(vault)) ||
      new Set(row.sameAssetFactoryVaultsCreatedBeforeB).size !==
        row.sameAssetFactoryVaultsCreatedBeforeB.length
    )
      throw new Error('Invalid route anchor or same-asset factory risk set')
    const controls = row.sameAssetFactoryVaultsCreatedBeforeB
      .filter((vault) => vault !== row.vault)
      .sort()
    for (const vault of [row.vault, ...controls]) {
      const creation = factory.get(vault)
      if (
        !creation ||
        creation.asset !== row.asset ||
        creation.block >= row.block ||
        (vault === row.vault && creation.block !== row.factoryCreationBlock)
      )
        throw new Error('Factory creation/asset risk-set mismatch')
    }
    return {
      anchorIndex: index,
      eventKey: row.eventKey,
      anchorBlock: row.block,
      anchorBlockHash: row.blockHash,
      anchorTxHash: row.txHash,
      anchorLogIndex: row.logIndex,
      preBlock: row.block - 1,
      asset: row.asset,
      treated: {
        vault: row.vault,
        creationBlock: factory.get(row.vault).block,
        expectedPreRoute: row.fromAdapter,
      },
      controls: controls.map((vault) => ({
        vault,
        creationBlock: factory.get(vault).block,
        expectedPreRoute: null,
      })),
      split: row.split,
      inclusionReason: 'same-asset-factory-vault-created-before-B; funding-unmeasured',
      fundedStatus: 'UNKNOWN',
      holderStatus: 'UNKNOWN',
      exitStatus: 'UNKNOWN',
    }
  })
  const core = {
    study: 'morpho-v2-route-full-baselines-plan-v1',
    sourceManifestSha256: sha(manifest),
    sourceVerification: 'caller-supplied-unverified',
    anchorCount: anchors.length,
    requiredPrestate: [
      'B-minus-1-header-and-hash-pinned-reads',
      'B-minus-1-runtime-code-asset-and-liquidity-adapter',
      'complete-creation-to-B-minus-1-Transfer-ledger-equals-totalSupply',
      'positive-EOA-holder-code-and-balanceOf',
      'totalAssets-previewRedeem-fixed-q',
      'same-holder-fixed-q-B-minus-1-withdraw-probe',
    ],
    caveat:
      'Candidate same-asset factory vaults are not funded or matched controls. All B−1 statuses await pinned evidence; no B or later state is authorized here.',
    anchors,
  }
  return { ...core, planSha256: sha(core) }
}

export function readSealedFullBaselinePlan({ factoryPath, routePath, headerPath }) {
  const manifest = readSealedRouteRiskManifest({ factoryPath, routePath, headerPath })
  readFactory(factoryPath) // Verify the pinned physical artifact before using its asset/creation rows.
  const factoryEvents = JSON.parse(readFileSync(factoryPath, 'utf8')).events
  const { planSha256, ...core } = buildFullBaselinePlan(manifest, factoryEvents)
  core.sourceVerification = 'physically-pinned-factory-route-header'
  return { ...core, planSha256: sha(core) }
}

export function baselineSlots(plan) {
  const { planSha256, ...core } = plan || {}
  if (
    plan?.study !== 'morpho-v2-route-full-baselines-plan-v1' ||
    planSha256 !== sha(core) ||
    plan.anchorCount !== plan.anchors?.length
  )
    throw new Error('Plan integrity mismatch')
  return plan.anchors.flatMap((anchor) =>
    [
      { ...anchor, role: 'treated', ...anchor.treated },
      ...anchor.controls.map((control) => ({ ...anchor, role: 'candidate-control', ...control })),
    ].map(({ treated, controls, ...slot }) => ({ ...slot, planSha256 })),
  )
}

export function classifyPrestate(slot, evidence) {
  const base = {
    planSha256: slot.planSha256,
    anchorIndex: slot.anchorIndex,
    eventKey: slot.eventKey,
    role: slot.role,
    vault: slot.vault,
    anchorBlock: slot.anchorBlock,
    preBlock: slot.preBlock,
    fundedStatus: 'UNKNOWN',
    holderStatus: 'UNKNOWN',
    exitStatus: 'UNKNOWN',
    evidenceLevel: 'caller-reported-unverified',
  }
  const finish = (status, additions = {}) => {
    const result = { ...base, ...additions, status }
    return Object.freeze({ ...result, resultSha256: sha(result) })
  }
  if (!evidence) return finish('missing-prestate')
  if (
    evidence.anchorBlock !== slot.anchorBlock ||
    evidence.vault !== slot.vault ||
    evidence.readBlock !== slot.preBlock ||
    evidence.readBlock >= slot.anchorBlock ||
    !hash(evidence.preBlockHash) ||
    evidence.preHeader?.block !== slot.preBlock ||
    evidence.preHeader.hash !== evidence.preBlockHash ||
    evidence.anchorBlockHash !== slot.anchorBlockHash ||
    evidence.state?.blockHash !== evidence.preBlockHash
  )
    return finish('invalid-pre-block-identity')
  const state = evidence.state
  if (
    !state ||
    state.blockHash !== evidence.preBlockHash ||
    !hash(state.runtimeCodeHash) ||
    state.asset !== slot.asset ||
    !address(state.route) ||
    (slot.expectedPreRoute !== null && state.route !== slot.expectedPreRoute)
  )
    return finish('invalid-pre-state-or-route')
  const stateFields = { preBlockHash: evidence.preBlockHash, preRoute: state.route }
  if (
    !Array.isArray(evidence.holders) ||
    evidence.ledgerStatus !== 'complete' ||
    evidence.ledgerBlockHash !== evidence.preBlockHash ||
    evidence.ledgerFromBlock !== slot.creationBlock ||
    evidence.ledgerThroughBlock !== slot.preBlock ||
    !/^[0-9a-f]{64}$/.test(evidence.ledgerSha256 || '')
  )
    return finish('missing-or-incomplete-holder-ledger', stateFields)
  let supply, assets, holders
  try {
    supply = uint(state.totalSupplyRaw)
    assets = uint(state.totalAssetsRaw)
    holders = evidence.holders.map((row) => {
      if (!address(row.address)) throw new Error('Invalid holder address')
      return { ...row, shares: uint(row.sharesRaw) }
    })
  } catch {
    return finish('invalid-raw-prestate', stateFields)
  }
  if (
    new Set(holders.map((row) => row.address)).size !== holders.length ||
    holders.reduce((sum, row) => sum + row.shares, 0n) !== supply
  )
    return finish('caller-reported-holder-ledger-supply-mismatch', stateFields)
  const ranked = holders
    .filter((row) => row.shares > 0n)
    .sort((a, b) =>
      a.shares === b.shares
        ? keccak256(a.address).localeCompare(keccak256(b.address))
        : a.shares > b.shares
          ? -1
          : 1,
    )
  for (const holder of ranked) {
    if (holder.codeAtPreBlock === undefined || holder.codeBlockHash !== evidence.preBlockHash)
      return finish('holder-code-unknown', stateFields)
    if (holder.codeAtPreBlock !== '0x') continue
    const selected = {
      ...stateFields,
      reportedHolder: holder.address,
      reportedHolderSharesRaw: holder.shares.toString(),
    }
    let balance
    try {
      balance = uint(holder.balanceOfRaw)
    } catch {
      return finish('holder-ledger-balance-mismatch', selected)
    }
    if (holder.balanceOfBlockHash !== evidence.preBlockHash || balance !== holder.shares)
      return finish('holder-ledger-balance-mismatch', selected)
    let redeemable
    try {
      if (holder.previewRedeemBlockHash !== evidence.preBlockHash)
        throw new Error('Unpinned preview')
      redeemable = uint(holder.previewRedeemRaw)
    } catch {
      return finish('preview-redeem-unavailable', selected)
    }
    const q = assets / 1000n < redeemable / 10n ? assets / 1000n : redeemable / 10n
    if (q === 0n)
      return finish('caller-reported-zero-q-unverified', {
        ...selected,
        provisionalQAssetsRaw: '0',
      })
    const sized = { ...selected, provisionalQAssetsRaw: q.toString() }
    const probe = evidence.withdrawProbe
    const expectedData = encodeFunctionData({
      abi: WITHDRAW_ABI,
      functionName: 'withdraw',
      args: [q, holder.address, holder.address],
    })
    if (
      !probe ||
      probe.rpcMethod !== 'eth_call' ||
      probe.blockNumber !== slot.preBlock ||
      probe.blockParameter?.blockHash !== evidence.preBlockHash ||
      probe.blockParameter?.requireCanonical !== true ||
      probe.blockHash !== evidence.preBlockHash ||
      probe.from !== holder.address ||
      probe.to !== slot.vault ||
      probe.data !== expectedData ||
      probe.gas !== PROBE_GAS ||
      probe.holder !== holder.address ||
      probe.qAssetsRaw !== q.toString() ||
      !['success', 'evm-revert', 'rpc-error'].includes(probe.status) ||
      (probe.status === 'success' && !/^0x[0-9a-f]{64}$/.test(probe.returnData || '')) ||
      (probe.status === 'evm-revert' && typeof probe.errorData !== 'string')
    )
      return finish('unverified-probe-context', sized)
    return finish('caller-reported-baseline-unverified', {
      ...sized,
      reportedPreWithdrawStatus: probe.status,
    })
  }
  return finish('caller-reported-no-EOA-unverified', stateFields)
}
