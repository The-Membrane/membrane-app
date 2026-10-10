import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildAlignedBacktest, CAPTURE_PINS, foldCases, holderBound, loadAlignedInputs, projectProngs } from '../../scripts/research/fluid-aligned-holder-flow-backtest.mjs'
import { digest, writeReportExclusive } from '../../scripts/research/fluid-retained-holder-backtest.mjs'

const INPUT = loadAlignedInputs(resolve(import.meta.dirname, '../..'))
const AT = '2026-10-08T05:40:00.000Z'
test('complete retained native replay scores every original correlated Q with source-frozen NET forecast', async () => {
  const report = await buildAlignedBacktest(INPUT, AT)
  const { sha256, ...body } = report
  assert.equal(digest(body), sha256)
  assert.equal(report.scope.originalFrozenResearchSizeCases, 5)
  assert.deepEqual(report.cases.map(c => [c.label, c.requestedQRaw]), INPUT.original.issue.cases.map(c => [c.label, c.assetsRaw]))
  assert.equal(report.lineage.acquisitionReadCount, 112)
  assert.equal(report.lineage.completeProtocolReceiptsReplayed, true)
  assert.equal(report.fullHolder.sourceEaRaw, '10048495305')
  assert.equal(report.fullHolder.targetEaRaw, '10048575783')
  assert.equal(report.fullHolder.observedEaGrowthRaw, '80478')
  assert.equal(report.fullHolder.MRaw, null)
  assert.equal(report.comparison.entitlementBindsAllThreeStates, true)
  assert.equal(report.comparison.allForecastsTiePersistence, true)
  for (const c of report.cases) {
    assert.equal(c.signedErrorRaw, '-80478')
    assert.equal(c.persistenceSignedErrorRaw, '-80478')
    assert.equal(c.absoluteErrorImprovementRaw, '0')
    assert.equal(c.sampledFirstRestriction.status, 'right_censored_at_target_sample')
    assert.equal(c.sampledFirstRestriction.restrictionTime, null)
  }
  assert.equal(report.cases.at(-1).forecastHeadroomRaw, '0')
  assert.equal(report.cases.at(-1).observedHeadroomRaw, '80478')
  assert.equal(report.clocks.actualHorizonSeconds, 4728)
  assert.equal(report.clocks.trainingSeconds, 86400)
  assert.deepEqual(report.method.scaledDelta, { C: '-177872541669', S: '61517882997', W: '30758941498' })
  assert.deepEqual(report.method.projected, { C: '19394901684158', S: '130180364462538', W: '65090182231268' })
  assert.equal(report.method.competingFlowSubtractedAgain, false)
  assert.equal(report.method.targetUsedForFitting, false)
  assert.ok(report.exclusions.includes('withdrawal_limit_parameter_regime_changed'))
  assert.ok(report.exclusions.includes('queued_M_unknown_excluded_from_active_Ea'))
  assert.equal(report.claims.forwardProbability, null)
  assert.equal(report.claims.forecastValidated, false)
  assert.equal(report.clocks.prospectiveIssue, false)
  assert.equal(report.status, 'conditional_retrospective_scenario_error_fold')
  assert.equal(report.clocks.donorTransformFrozenBeforeNewAcquisition, true)
  assert.equal(report.clocks.scoringImplementationFrozenBeforeAcquisition, false)
  assert.equal(Object.hasOwn(report.clocks, 'algorithmFrozenBeforeNewAcquisition'), false)
  assert.equal(report.claims.outOfSampleForecastClaim, false)
  assert.equal(report.scope.all25RouteQualification, false)
})
test('signed rate rounding precedes physical-stock floor; overflowing stocks are rejected', () => {
  const result = projectProngs({ C: '1', S: '10', W: '3' }, { C: '-9', S: '7', W: '-7' }, 1, 4)
  assert.deepEqual(result.scaledDelta, { C: '-2', S: '1', W: '-1' })
  assert.deepEqual(result.projected, { C: '0', S: '11', W: '2' })
  const MAX = ((1n << 256n) - 1n).toString()
  assert.throws(() => projectProngs({ C: MAX, S: '1', W: '0' }, { C: '1', S: '0', W: '0' }, 1, 1), /overflow/)
  assert.throws(() => projectProngs({ C: '1', S: '1', W: '0' }, { C: '-0', S: '0', W: '0' }, 1, 1), /native_signed/)
})
test('full entitlement and competed protocol stocks stay independent of Q; negative headroom remains signed', () => {
  const source = { C: '12', S: '100', W: '90' }, forecast = { C: '5', S: '100', W: '90' }, target = { C: '20', S: '100', W: '90' }
  const result = foldCases([{ label: 'small', assetsRaw: '4' }, { label: 'large', assetsRaw: '15' }], '100', '110', source, forecast, target)
  assert.equal(result.bounds.source.fullEaRaw, '100')
  assert.equal(result.bounds.source.holderCapacityRaw, '10')
  assert.equal(result.cases[0].forecastHeadroomRaw, '1')
  assert.equal(result.cases[1].forecastHeadroomRaw, '-10')
  assert.equal(result.cases[1].sourceHeadroomRaw, '-5')
  assert.equal(result.cases[1].signedErrorRaw, '-5')
  assert.equal(holderBound('100', { C: '100', S: '2', W: '3' }).holderCapacityRaw, '0')
})
test('changing target entitlement changes the observed error but cannot fit the frozen forecast', () => {
  const p = { C: '900', S: '1000', W: '0' }, cases = [{ label: 'Q', assetsRaw: '20' }]
  const a = foldCases(cases, '100', '115', p, p, p), b = foldCases(cases, '100', '200', p, p, p)
  assert.equal(a.cases[0].forecastHeadroomRaw, '80')
  assert.equal(b.cases[0].forecastHeadroomRaw, '80')
  assert.equal(a.cases[0].signedErrorRaw, '-15')
  assert.equal(b.cases[0].signedErrorRaw, '-100')
})
test('sealed capture substitution and analysis before acquisition fail closed', async () => {
  const input = structuredClone(INPUT)
  input.training.signedNativeDeltas.C = '0'
  delete input.training.sha256; input.training.sha256 = digest(input.training)
  await assert.rejects(buildAlignedBacktest(input, AT), /capture_content_pin/)
  await assert.rejects(buildAlignedBacktest(INPUT, '2026-10-08T05:30:26.000Z'), /analysis_before_capture/)
  assert.equal(INPUT.plan.sha256, CAPTURE_PINS.plan.contentSha256)
})
test('report writer creates private exclusive durable output and refuses symlink/clobber', async () => {
  const report = await buildAlignedBacktest(INPUT, AT), dir = mkdtempSync(join(tmpdir(), 'fluid-aligned-backtest-'))
  const out = join(dir, 'report.json'); writeReportExclusive(out, report)
  assert.equal(statSync(out).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(out)), report)
  assert.throws(() => writeReportExclusive(out, report), /EEXIST/)
  symlinkSync(out, join(dir, 'link.json'))
  assert.throws(() => writeReportExclusive(join(dir, 'link.json'), report), /EEXIST/)
})
