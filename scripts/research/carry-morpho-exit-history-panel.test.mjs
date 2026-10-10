import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chooseQ, selectCandidates, classifyProbe, findFirstBlockAtOrAfter,
  loadUniverse, logsBeforeAnchor, aggregateRows, validatePanel, savePanelOnce,
  METHOD } from './carry-morpho-exit-history-panel.mjs'

const VAULT = '0x1111111111111111111111111111111111111111'
const OWNER = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const HASH = `0x${'a'.repeat(64)}`
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const topicAddress = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`
const log = (owner, block, index = 0) => ({address: VAULT,
  blockNumber: BigInt(block), transactionIndex: 0, logIndex: index,
  blockHash: HASH, transactionHash: HASH, removed: false, data: `0x${'0'.repeat(63)}1`,
  topics: [TOPIC, topicAddress(OTHER), topicAddress(owner)]})
const manifestSha = createHash('sha256').update(readFileSync(new URL('../../lib/carry/morpho-v2-asset-identities.json', import.meta.url))).digest('hex')

function validPanel() {
  const rows = loadUniverse().map((entry) => ({vault: entry.vault,
    expectedAsset: entry.asset, status: 'not_attempted_budget'}))
  rows[0] = {...rows[0], status: 'measured', totalAssetsRaw: '1000',
    holder: OWNER, holderDiscovery: {owner: OWNER, discoveryBlock: 99,
      discoveryBlockHash: HASH, discoveryTimestamp: 900},
    qAssetsRaw: '1', anchorSharesRaw: '10', anchorClaimRaw: '10',
    anchorCall: {status: 'success', sharesBurnedRaw: '1'},
    horizonSharesRaw: '10', horizonClaimRaw: '10', horizonHolderCodePresent: false,
    horizonCall: {status: 'success', sharesBurnedRaw: '1'}, horizonClass: 'success'}
  return {schemaVersion: 1, study: 'carry-morpho-exit-history-panel-v1',
    chainId: 1, mode: 'historical_read_only', prospectiveValidation: false,
    futureExitForecast: false,
    universe: {manifestSha256: manifestSha, knownVaults: 49, attemptedVaults: 1},
    method: METHOD, anchor: {number: 100, hash: HASH, timestamp: 1000},
    horizon: {number: 400, hash: HASH, timestamp: 4600, requestedTimestamp: 4600,
      priorTimestamp: 4599, realizedLagSeconds: 0},
    ...aggregateRows(rows), rows}
}

test('manifest is the pinned exact 49-vault universe', () => {
  const entries = loadUniverse()
  assert.equal(entries.length, 49)
  assert.equal(new Set(entries.map((entry) => entry.vault)).size, 49)
})

test('holder candidates can only come from strictly pre-anchor transfers', () => {
  const candidates = selectCandidates([log(OWNER, 99), log(OTHER, 98), log(OWNER, 97)], VAULT, 90n, 100n)
  assert.deepEqual(candidates.map((row) => row.owner), [OWNER, OTHER])
  assert.throws(() => selectCandidates([log(OWNER, 100)], VAULT, 90n, 100n), /malformed_pre_anchor/)
  assert.throws(() => selectCandidates([log(OWNER, 89)], VAULT, 90n, 100n), /malformed_pre_anchor/)
})

test('fixed Q is bounded by anchor holder claim and vault assets', () => {
  assert.equal(chooseQ(1000n, 500000n), 100n)
  assert.equal(chooseQ(100000n, 500000n), 500n)
  assert.equal(chooseQ(9n, 500000n), 0n)
})

test('horizon attrition is separated from venue revert and missing RPC', () => {
  const base = {shares: 100n, claim: 100n, q: 50n, code: '0x'}
  assert.equal(classifyProbe({...base, call: {status: 'success'}}), 'success')
  assert.equal(classifyProbe({...base, call: {status: 'evm_revert'}}), 'evm_revert')
  assert.equal(classifyProbe({...base, claim: 49n, call: {status: 'evm_revert'}}), 'position_attrition')
  assert.equal(classifyProbe({...base, claim: 49n, call: {status: 'success'}}), 'success')
  assert.equal(classifyProbe({...base, call: {status: 'missing_rpc'}}), 'missing_rpc')
  assert.equal(classifyProbe({...base, code: '0x1234', call: {status: 'success'}}), 'holder_type_changed')
})

test('archive log reads use Transfer ABI filter rather than ignored raw topics option', async () => {
  const requests = []
  const client = {getLogs: async (request) => { requests.push(request); return [] }}
  await logsBeforeAnchor(client, VAULT, 4_200n)
  assert.equal(requests.length, 8)
  assert.equal(requests[0].event.name, 'Transfer')
  assert.deepEqual(requests[0].event.inputs.map((x) => x.indexed), [true, true, undefined])
  assert.equal('topics' in requests[0], false)
  assert.equal(requests.at(-1).toBlock, 4_199n)
})

test('horizon finds first block at or after physical H1, with prior evidence', async () => {
  const timestamps = [1000, 2000, 4000, 4599, 4601, 4612, 4800]
  const client = {getBlock: async ({blockNumber}) => ({number: blockNumber,
    hash: HASH, timestamp: BigInt(timestamps[Number(blockNumber)])})}
  const result = await findFirstBlockAtOrAfter(client, {number: 2, timestamp: 4000}, 4600,
    {number: 6, timestamp: 4800, hash: HASH})
  assert.equal(result.number, 4)
  assert.equal(result.priorTimestamp, 4599)
  assert.equal(result.realizedLagSeconds, 1)
})

test('published counts, risk-set counts, and manifest digest are recomputed from rows', () => {
  const clean = validPanel()
  assert.equal(validatePanel(clean), true)
  for (const mutate of [
    (x) => {x.baselineCounts.success = 999},
    (x) => {x.baselineSuccessRiskSet.horizonCounts.success = 999},
    (x) => {x.baselineSuccessRiskSet.uniqueHolders = 999},
    (x) => {x.holderDependence.measuredUniqueHolders = 999},
    (x) => {x.universe.manifestSha256 = '0'.repeat(64)},
  ]) {
    const changed = structuredClone(clean)
    mutate(changed)
    assert.throws(() => validatePanel(changed), /historical_panel_/)
  }
})

test('mode, validation flags, method, and zero-share success cannot be relabeled', () => {
  const clean = validPanel()
  for (const mutate of [
    (x) => {x.mode = 'prospective'},
    (x) => {x.prospectiveValidation = true},
    (x) => {x.futureExitForecast = true},
    (x) => {x.method.discoveryReceiptVerification = 'verified'},
    (x) => {x.rows[0].anchorCall.sharesBurnedRaw = '0'},
    (x) => {x.rows[0].horizonCall.sharesBurnedRaw = '0'},
  ]) {
    const changed = structuredClone(clean)
    mutate(changed)
    assert.throws(() => validatePanel(changed), /historical_panel_/)
  }
})

test('repeated holders are counted once, and artifact writes are replay-only', () => {
  const clean = validPanel()
  const repeated = {...clean.rows[0], vault: clean.rows[1].vault,
    expectedAsset: clean.rows[1].expectedAsset}
  const summary = aggregateRows([clean.rows[0], repeated])
  assert.equal(summary.baselineSuccessRiskSet.count, 2)
  assert.equal(summary.baselineSuccessRiskSet.uniqueHolders, 1)
  assert.equal(summary.holderDependence.independentObservations, false)
  const dir = mkdtempSync(join(tmpdir(), 'carry-morpho-exit-history-test-'))
  try {
    const path = join(dir, 'panel.json')
    assert.equal(savePanelOnce(clean, path).replay, false)
    assert.equal(savePanelOnce(clean, path).replay, true)
    const different = structuredClone(clean)
    different.anchor.hash = `0x${'b'.repeat(64)}`
    assert.throws(() => savePanelOnce(different, path), /artifact_conflict/)
    assert.equal(JSON.parse(readFileSync(path)).anchor.hash, HASH)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('anchor success remains in the risk set when its horizon RPC is missing', () => {
  const clean = validPanel()
  clean.rows[0].status = 'missing_rpc'
  delete clean.rows[0].horizonCall
  delete clean.rows[0].horizonClass
  Object.assign(clean, aggregateRows(clean.rows))
  assert.equal(clean.baselineSuccessRiskSet.count, 1)
  assert.deepEqual(clean.baselineSuccessRiskSet.horizonCounts, {missing_rpc: 1})
  assert.equal(validatePanel(clean), true)
})
