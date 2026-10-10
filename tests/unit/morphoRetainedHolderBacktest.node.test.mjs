import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBacktest, digest, foldPair, INPUT_PINS, loadRetainedInputs, readPinnedInput, seal, writeReportExclusive } from '../../scripts/research/morpho-retained-holder-backtest.mjs'

const analysisAt = '2026-10-08T12:00:00.000Z'
const inputs = loadRetainedInputs()
const usdt = inputs.records.find((r) => r.routeIndex === 5 && r.sourceBlock === 25881014)
const clone = (x) => JSON.parse(JSON.stringify(x))
const reseal = (x) => { const { sha256, ...body } = x; return seal(body) }

test('replays the frozen real archive and retains full roster exclusions', () => {
  const report = buildBacktest(inputs, analysisAt)
  assert.equal(report.scope.rosterDestinations, 49)
  assert.equal(report.scope.retainedRecords, 81)
  assert.equal(report.scope.verifiedAssayPairs, 14)
  assert.equal(report.scope.retainedFullHolderPairs, 14)
  assert.equal(report.scope.unchangedFullHolderPairs, 5)
  assert.equal(report.scope.shareChangedPairs, 9)
  assert.equal(report.scope.fundedDestinations, 6)
  assert.deepEqual(report.coverage.filter((r) => r.retainedFullHolderPairs > 0).map((r) => [r.routeIndex, r.retainedFullHolderPairs]), [[1, 2], [2, 1], [3, 1], [5, 1], [10, 3], [38, 6]])
  assert.equal(report.scope.fundedNativeAssets.length, 2)
  assert.equal(report.coverage.length, 49)
  assert.equal(new Set(report.coverage.map((r) => r.asset)).size, 7)
  assert.equal(report.pairs.filter((p) => p.reason === 'no_source_holder').length, 65)
  assert.equal(report.pairs.filter((p) => p.reason === 'vault_not_deployed').length, 2)
  assert.equal(report.coverage.filter((r) => r.historicalNativeCash.pointCount === 120).length, 48)
  const shorterHistories = report.coverage.filter((r) => r.historicalNativeCash.pointCount !== 120)
  assert.equal(shorterHistories.length, 1)
  assert.equal(shorterHistories[0].destination, '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96')
  assert.equal(shorterHistories[0].historicalNativeCash.pointCount, 109)
  assert.equal(report.interpretation.forecastProbability, null)
  assert.equal(report.interpretation.all49HolderQualification, undefined)
  assert.equal(report.scope.all49HolderQualification, false)
})

test('USDT receipt uses the entire unchanged owner balance independently of Q', () => {
  const pair = foldPair(usdt)
  assert.equal(pair.assetDecimals, 6)
  assert.equal(pair.source.shareDecimals, null)
  assert.equal(pair.source.sharesRaw, '10437267800221756345625')
  assert.equal(pair.outcome.sharesRaw, pair.source.sharesRaw)
  assert.equal(pair.source.fullEntitlementRaw, '10587000089')
  assert.equal(pair.outcome.fullEntitlementRaw, '10587739900')
  assert.equal(pair.frozenRequestedQRaw, '620302694')
  assert.equal(pair.source.entitlementHeadroomRaw, '9966697395')
  assert.equal(pair.persistence.signedErrorRaw, '-739811')
  assert.equal(pair.persistence.predictedFullEntitlementRaw, pair.source.fullEntitlementRaw)
  assert.equal(pair.persistence.capacityForecast, null)
  assert.equal(pair.queue.MRaw, null)
  assert.equal(pair.protocol.capacityRaw, null)
  assert.equal(pair.duration.continuousAvailabilitySeconds, null)
  assert.equal(pair.sampledAbility.fullEaWithdrawSimulated, false)
  assert.equal(pair.sampledAbility.minedPaymentObserved, false)
})

test('the retained input manifest rejects omission, permutation, and re-sealed modifications', () => {
  assert.throws(() => buildBacktest({ ...inputs, records: inputs.records.slice(1) }, analysisAt), /cohort_size/)
  assert.throws(() => buildBacktest({ ...inputs, records: [...inputs.records].reverse() }, analysisAt), /cohort_pin/)
  const altered = clone(inputs.records); altered[0].capturedAtUtc = analysisAt; altered[0] = reseal(altered[0])
  assert.throws(() => buildBacktest({ ...inputs, records: altered }, analysisAt), /cohort_pin/)
  assert.throws(() => buildBacktest({ ...inputs, provenance: [] }, analysisAt), /manifest_binding/)
  assert.throws(() => buildBacktest(inputs, '2026-10-07T12:00:00.000Z'), /analysis_clock/)
})

test('raw full-E calldata, exact Q, owner, and independent replay are load-bearing', () => {
  for (const mutate of [
    (r) => { r.sourceAssay.evidence.requiredCoverageRpc.request.params[0].data = '0x4cdad506' + BigInt(r.assetsRaw).toString(16).padStart(64, '0') },
    (r) => { r.sourceAssay.evidence.requiredCoverageRaw = r.assetsRaw },
    (r) => { r.assetsRaw = '1' },
    (r) => { r.sourceAssay.evidence.holder = r.destination },
    (r) => { r.futureAssay.evidence.replayEvidenceDoc.responses.secondary.requiredCoverageRpc.result = '0x' + '0'.repeat(64) },
    (r) => { r.futureAssay.evidence.replayEvidenceDoc.origins.secondary = r.futureAssay.evidence.replayEvidenceDoc.origins.primary },
    (r) => { r.future.primary.canonicalityEvidenceDoc.targetHeader.timestamp = r.source.primary.targetBlockAt },
  ]) {
    const r = clone(usdt); mutate(r)
    assert.throws(() => foldPair(reseal(r)))
  }
})

test('native precision binds to own-cash identities and does not normalize to six decimals', () => {
  const report = buildBacktest(inputs, analysisAt)
  assert.ok(report.coverage.some((r) => r.assetDecimals === 18))
  assert.equal(report.coverage.find((r) => r.routeIndex === 5).assetDecimals, 6)
  const x = clone(inputs); x.cash.historyResults.find((h) => h.identity.destination === usdt.destination).identity.assetDecimals = 18
  assert.throws(() => buildBacktest(x, analysisAt), /cash_pin/)
})

test('bounded pinned reader verifies original bytes and rejects symlinks and changed bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'morpho-retained-read-'))
  const pin = INPUT_PINS.find((p) => p.path.endsWith('05-000025881014.json'))
  const file = join(root, 'receipt.json')
  writeFileSync(file, readFileSync(pin.path), { mode: 0o600 })
  assert.equal(readPinnedInput(root, { ...pin, path: 'receipt.json' }).sha256, usdt.sha256)
  symlinkSync(file, join(root, 'link.json'))
  assert.throws(() => readPinnedInput(root, { ...pin, path: 'link.json' }))
  writeFileSync(file, JSON.stringify(usdt) + '\n\n')
  assert.throws(() => readPinnedInput(root, { ...pin, path: 'receipt.json' }), /input_file_hash/)
})

test('report writer creates a sealed private exclusive artifact', () => {
  const report = buildBacktest(inputs, analysisAt)
  const file = join(mkdtempSync(join(tmpdir(), 'morpho-retained-write-')), 'report.json')
  const written = writeReportExclusive(file, report)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(written.contentSha256, report.sha256)
  assert.equal(JSON.parse(readFileSync(file)).sha256, report.sha256)
  assert.throws(() => writeReportExclusive(file, report), /EEXIST/)
  assert.equal(digest(INPUT_PINS), report.inputManifestSha256)
})


test('changed balances retain endpoint Ea evidence while censoring fixed-position drift', () => {
  const report = buildBacktest(inputs, analysisAt)
  const changed = report.pairs.filter((p) => p.sharesUnchanged === false)
  assert.equal(changed.length, 9)
  assert.ok(changed.every((p) => p.status === 'retained_full_holder_pair' && p.persistence === null && p.driftStatus === 'censored_share_balance_changed'))
  assert.ok(report.pairs.filter((p) => p.sharesUnchanged).every((p) => p.persistence !== null))
})
