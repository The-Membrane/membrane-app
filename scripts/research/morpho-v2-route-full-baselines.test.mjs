import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { encodeFunctionData, parseAbi, toHex } from 'viem'
import {
  buildFullBaselinePlan,
  baselineSlots,
  classifyPrestate,
  readSealedFullBaselinePlan,
} from './morpho-v2-route-full-baselines.mjs'
import {
  DEFAULT_ROUTE_PATH,
  DEFAULT_HEADER_PATH,
} from './morpho-v2-route-risk-manifest.mjs'

const A = `0x${'1'.repeat(40)}`, C = `0x${'2'.repeat(40)}`
const ASSET = `0x${'3'.repeat(40)}`, OLD = `0x${'4'.repeat(40)}`, NEW = `0x${'5'.repeat(40)}`
const HOLDER = `0x${'6'.repeat(40)}`
const factoryEvents = [{ vault: A, asset: ASSET, block: 1 }, { vault: C, asset: ASSET, block: 2 }]
const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
const ABI = parseAbi(['function withdraw(uint256,address,address) returns (uint256)'])
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const synthetic = () => ({
  study: 'morpho-v2-route-risk-manifest-v1',
  transitionCount: 116,
  transitions: Array.from({ length: 116 }, (_, index) => ({
    chronologicalIndex: index,
    eventKey: `${100 + index}:0:1`,
    vault: A,
    asset: ASSET,
    fromAdapter: OLD,
    blockHash: H(100 + index),
    txHash: H(300 + index),
    block: 100 + index,
    factoryCreationBlock: 1,
    logIndex: 1,
    sameAssetFactoryVaultsCreatedBeforeB: [A, C],
    split: index < 81 ? 'development' : 'held-out',
  })),
})
const makeSlot = () => baselineSlots(buildFullBaselinePlan(synthetic(), factoryEvents))[0]
const evidenceFor = (slot) => ({
  vault: slot.vault,
  anchorBlock: slot.anchorBlock,
  anchorBlockHash: slot.anchorBlockHash,
  readBlock: slot.preBlock,
  preBlockHash: H(99),
  preHeader: { block: slot.preBlock, hash: H(99) },
  state: {
    blockHash: H(99), runtimeCodeHash: H(7), asset: ASSET, route: OLD,
    totalSupplyRaw: '1000', totalAssetsRaw: '1000000',
  },
  ledgerStatus: 'complete', ledgerBlockHash: H(99), ledgerFromBlock: slot.creationBlock,
  ledgerThroughBlock: slot.preBlock, ledgerSha256: 'a'.repeat(64),
  holders: [{ address: HOLDER, sharesRaw: '1000', codeAtPreBlock: '0x',
    codeBlockHash: H(99), balanceOfBlockHash: H(99), balanceOfRaw: '1000',
    previewRedeemBlockHash: H(99), previewRedeemRaw: '5000' }],
  withdrawProbe: {
    rpcMethod: 'eth_call', blockNumber: slot.preBlock, blockHash: H(99),
    blockParameter: { blockHash: H(99), requireCanonical: true },
    from: HOLDER, to: slot.vault, holder: HOLDER, qAssetsRaw: '500',
    data: encodeFunctionData({ abi: ABI, functionName: 'withdraw', args: [500n, HOLDER, HOLDER] }),
    gas: toHex(20_000_000), status: 'success', returnData: H(5),
  },
})

test('plan retains all 116 anchors and same-asset controls with B−1-only work', () => {
  const plan = buildFullBaselinePlan(synthetic(), factoryEvents)
  const slots = baselineSlots(plan)
  assert.equal(plan.anchorCount, 116)
  assert.equal(plan.sourceVerification, 'caller-supplied-unverified')
  assert.equal(slots.length, 232)
  assert.deepEqual(slots.slice(0, 2).map((slot) => [slot.role, slot.vault, slot.preBlock]), [
    ['treated', A, 99], ['candidate-control', C, 99],
  ])
  assert.equal(slots[0].expectedPreRoute, OLD)
  assert.equal(slots[1].expectedPreRoute, null)
  assert.equal(slots[0].creationBlock, 1)
  assert.equal(slots[1].creationBlock, 2)
  assert.equal(slots[0].fundedStatus, 'UNKNOWN')
  assert.match(plan.caveat, /not funded or matched controls/)
  assert.throws(() => baselineSlots({ ...plan, planSha256: '0'.repeat(64) }), /integrity/)
})

test('caller evidence computes provisional q but never certifies funded or baseline success', () => {
  const slot = makeSlot()
  const result = classifyPrestate(slot, evidenceFor(slot))
  assert.equal(result.status, 'caller-reported-baseline-unverified')
  assert.equal(result.provisionalQAssetsRaw, '500')
  assert.equal(result.reportedHolder, HOLDER)
  assert.equal(result.reportedPreWithdrawStatus, 'success')
  assert.equal(result.fundedStatus, 'UNKNOWN')
  assert.equal(result.holderStatus, 'UNKNOWN')
  assert.equal(result.exitStatus, 'UNKNOWN')
  assert.equal(result.resultSha256, digest(Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'resultSha256'))))
  assert.equal(Object.isFrozen(result), true)
})

test('missing/failure rows remain explicit and B state is rejected', () => {
  const slot = makeSlot()
  assert.equal(classifyPrestate(slot).status, 'missing-prestate')
  const atB = evidenceFor(slot)
  atB.readBlock = slot.anchorBlock
  assert.equal(classifyPrestate(slot, atB).status, 'invalid-pre-block-identity')
  const wrongRoute = evidenceFor(slot)
  wrongRoute.state.route = NEW
  assert.equal(classifyPrestate(slot, wrongRoute).status, 'invalid-pre-state-or-route')
  const wrongHeader = evidenceFor(slot)
  wrongHeader.preHeader.hash = H(98)
  assert.equal(classifyPrestate(slot, wrongHeader).status, 'invalid-pre-block-identity')
  const incomplete = evidenceFor(slot)
  incomplete.ledgerStatus = 'partial'
  assert.equal(classifyPrestate(slot, incomplete).status, 'missing-or-incomplete-holder-ledger')
  const wrongLedgerStart = evidenceFor(slot)
  wrongLedgerStart.ledgerFromBlock = 2
  assert.equal(classifyPrestate(slot, wrongLedgerStart).status, 'missing-or-incomplete-holder-ledger')
  const revert = evidenceFor(slot)
  revert.withdrawProbe.status = 'evm-revert'
  revert.withdrawProbe.errorData = '0x08c379a0'
  assert.equal(classifyPrestate(slot, revert).status, 'caller-reported-baseline-unverified')
  assert.equal(classifyPrestate(slot, revert).exitStatus, 'UNKNOWN')
})

test('forged probe target, sender, calldata, and return cannot claim success', () => {
  const slot = makeSlot()
  for (const change of [
    (probe) => { probe.to = C },
    (probe) => { probe.from = C },
    (probe) => { probe.data = '0x1234' },
    (probe) => { probe.returnData = '0x' },
    (probe) => { probe.blockParameter.blockHash = H(98) },
  ]) {
    const evidence = evidenceFor(slot)
    change(evidence.withdrawProbe)
    const result = classifyPrestate(slot, evidence)
    assert.equal(result.status, 'unverified-probe-context')
    assert.equal(result.fundedStatus, 'UNKNOWN')
    assert.equal(result.exitStatus, 'UNKNOWN')
  }
})

test('read-only sealed source expands full 116 transitions without any archive RPC', () => {
  const plan = readSealedFullBaselinePlan({
    factoryPath: 'data/research/venue-signals/745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa.json',
    routePath: DEFAULT_ROUTE_PATH, headerPath: DEFAULT_HEADER_PATH,
    manifest: synthetic(), // Ignored: source must be rebuilt from the pinned caches.
  })
  assert.equal(plan.anchorCount, 116)
  assert.equal(plan.sourceVerification, 'physically-pinned-factory-route-header')
  assert.equal(baselineSlots(plan).length, 18279)
  assert.equal(plan.anchors[0].eventKey, '23420016:224:488')
  assert.ok(plan.anchors.every((anchor) => anchor.preBlock === anchor.anchorBlock - 1))
})
