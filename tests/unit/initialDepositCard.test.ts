import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ExitPressureCard, formatExitPressureSignedRaw } from '@/components/Carry/ExitPressureCard'
import { NOW, initialDepositUiFixture } from './initialDepositUiFixture'
const render = (p: any) =>
  renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(ExitPressureCard, p)),
  )
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
describe('actual initial-deposit Card rendering', () => {
  it.each([0, 1])(
    'renders native pilot %i with original checked source and receipt-clipped net headroom',
    (market) => {
      const f = initialDepositUiFixture({ market })
      const text = render(f.props)
      const summary = f.projection.process!.targetSummary!
      expect(text).toContain('After deposit · if admitted')
      expect(text).toContain('Admission unknown')
      expect(text).toContain('D 0.000010 · Q 0.000009')
      expect(text).toContain('Hypothetical receipt')
      expect(text).toContain('SOURCE 2026-10-08 11:59 UTC')
      expect(text).toContain('Projected exit headroom')
      expect(text).toContain(
        `${formatExitPressureSignedRaw(summary.empiricalP10HeadroomRaw, 6)}–${formatExitPressureSignedRaw(summary.empiricalP90HeadroomRaw, 6)}`,
      )
      let floorSeen = false
      for (const s of f.projection.process!.scenarios)
        for (const point of s.points) {
          expect(BigInt(point.capacityRaw)).toBe(
            BigInt(point.availableRaw) < 10n ? BigInt(point.availableRaw) : 10n,
          )
          expect(point.headroomRaw).toBe(String(BigInt(point.capacityRaw) - 9n))
          if (point.availableRaw === '0') floorSeen = true
        }
      expect(floorSeen).toBe(true)
      expect(f.projection.currentSource.cashRaw).toBe('100')
    },
  )
  it('keeps unknown receipt cash headroom separate from holder exit', () => {
    const f = initialDepositUiFixture({ native: false })
    const text = render(f.props)
    expect(text).toContain('Receipt unassessed · cash only')
    expect(text).toContain('Projected cash headroom')
    expect(text).not.toContain('Projected exit headroom')
    expect(text).not.toContain('CONDITIONAL HOLDER OUTLOOK')
  })
  it('ignores every current-wallet holder witness in the hypothetical Deposit scenario', () => {
    const f = initialDepositUiFixture({ native: false })
    const unusable = new Proxy(
      {},
      {
        get() {
          throw Error('current holder evidence used in hypothetical deposit')
        },
      },
    )
    expect(
      render({
        ...f.props,
        holderAssessment: unusable,
        holderCapacityAgreement: unusable,
        holderTimeProcessIssue: unusable,
        holderCometFactsAgreement: unusable,
        holderStusdsProtocolCapacityEvidence: unusable,
        holderMorphoV2ProtocolCapacityEvidence: unusable,
        requestedHolderAddress: `0x${'b'.repeat(40)}`,
      }),
    ).toBe(render(f.props))
  })
  it('shows blocked admission as a counterfactual even when the conditional path is positive', () => {
    const f = initialDepositUiFixture({
      blocked: true,
      cash: '1000000000000000000000000000000000000',
      D: '100000000',
      Q: '1',
    })
    expect(BigInt(f.projection.process!.targetSummary!.minimumHeadroomRaw)).toBeGreaterThan(0n)
    const text = render(f.props)
    expect(text).toContain('After deposit · counterfactual admission')
    expect(text).toContain('Admission blocked under reference rules')
    expect(text).toContain('Projected exit headroom')
  })
  it('retains shortfall censoring brackets when the intended exit exceeds the hypothetical receipt', () => {
    const f = initialDepositUiFixture({ Q: '20' })
    expect(render(f.props)).toMatch(/SHORTFALL ≥24H/i)
    for (const s of f.projection.process!.scenarios)
      expect(s.sampledShortfalls[0]).toMatchObject({
        leftCensored: true,
        rightCensored: true,
        recovery: null,
      })
  })
  it('rejects late D/Q/horizon answers and expires the fixed issuance without erasing current cash', () => {
    const f = initialDepositUiFixture()
    for (const changed of [
      { depositAmount: '0.000011' },
      { requestedAmount: '0.000010', requestedRaw: '10' },
      { horizonHours: 48 },
      { asOfMs: NOW + 1800001 },
    ]) {
      const text = render({ ...f.props, ...changed })
      expect(text).toContain('Deposit outlook unassessed')
      expect(text).not.toContain('AFTER DEPOSIT · CONDITIONAL')
      expect(text).not.toContain('Hypothetical receipt')
      expect(text).toContain('Market cash')
    }
  })
  it('preserves old Exit rendering and ignores an unrelated deposit issue in default Exit mode', () => {
    const f = initialDepositUiFixture()
    const baseline = {
      ...f.props,
      scenarioMode: undefined,
      initialDepositIssue: undefined,
      depositAmount: undefined,
    }
    expect(
      render({
        ...baseline,
        scenarioMode: 'exit',
        initialDepositIssue: f.issue,
        depositAmount: '0.000010',
      }),
    ).toBe(render(baseline))
    const unsupported = render({
      ...f.props,
      routeKey: 'USDC → VaultV2 [USDC]',
      currentCash: { ...f.currentCash, routeKey: 'USDC → VaultV2 [USDC]' },
    })
    expect(unsupported).toContain('Deposit outlook unassessed')
    expect(unsupported).toContain('Market cash')
    expect(unsupported).not.toContain('Hypothetical receipt')
  })
  it('rejects modified stored issue intervals and incomplete projections while retaining observed cash', () => {
    const f = initialDepositUiFixture()
    for (const change of [
      { sentAtMs: NOW + 1 },
      { sentAtMs: NaN },
      { receivedAtMs: NOW - 1 },
      { projection: { ...f.projection, hypotheticalReceipt: undefined } },
      { projection: { ...f.projection, request: undefined } },
    ]) {
      const text = render({ ...f.props, initialDepositIssue: { ...f.issue, ...change } })
      expect(text).toContain('Deposit outlook unassessed')
      expect(text).toContain('Market cash')
      expect(text).not.toContain('Projected exit headroom')
      expect(text).not.toContain('Hypothetical receipt')
    }
  })
})
