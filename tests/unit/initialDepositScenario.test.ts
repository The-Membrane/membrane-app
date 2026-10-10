import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  changeInitialDepositAmounts,
  initialDepositIssueFromResponse,
  initialDepositNativeRaw,
  initialDepositQuestion,
  initialDepositRenderWindow,
  issuedInitialDepositScenario,
} from '@/components/Carry/initialDepositScenario'
import { NOW, initialDepositUiFixture } from './initialDepositUiFixture'

afterEach(() => vi.restoreAllMocks())
describe('initial-deposit question and fixed issuance binding', () => {
  it('keeps native six-decimal principal separate from planned exit and unsupported subjects', () => {
    expect(initialDepositNativeRaw('120.000001')).toBe('120000001')
    for (const s of ['0', '1.0000001', '1e6', '-1', '01', ' 1', String(1n << 256n)])
      expect(initialDepositNativeRaw(s)).toBeNull()
    const f = initialDepositUiFixture()
    expect(
      initialDepositQuestion('exit', f.question.routeKey, f.question.destination, '2', '3', 24),
    ).toBeNull()
    expect(
      initialDepositQuestion(
        'initial_deposit',
        'USDC → VaultV2 [USDC]',
        f.question.destination,
        '2',
        '3',
        24,
      ),
    ).toBeNull()
    expect(
      initialDepositQuestion(
        'initial_deposit',
        f.question.routeKey,
        f.question.destination,
        '2',
        '3',
        24,
      ),
    ).toMatchObject({
      depositAssetsRaw: '2000000',
      plannedExitAssetsRaw: '3000000',
      assetDecimals: 6,
    })
  })
  it('follows D with Q until Q is edited, then preserves the intended exit on later D changes', () => {
    let s = { depositSize: '1', plannedExitSize: '1', plannedExitEdited: false }
    s = changeInitialDepositAmounts(s, 'deposit', '2')
    expect(s.plannedExitSize).toBe('2')
    s = changeInitialDepositAmounts(s, 'planned_exit', '3')
    s = changeInitialDepositAmounts(s, 'deposit', '4')
    expect(s).toEqual({ depositSize: '4', plannedExitSize: '3', plannedExitEdited: true })
  })
  it('binds D, Q, mode, subject and horizon before accepting a late response', () => {
    const f = initialDepositUiFixture()
    expect(issuedInitialDepositScenario(f.issue, f.question, f.currentCash)).toEqual(f.projection)
    for (const changed of [
      { depositAssetsRaw: '11' },
      { plannedExitAssetsRaw: '10' },
      { mode: 'exit' },
      { destination: `0x${'b'.repeat(40)}` },
      { routeKey: 'other' },
      { horizonHours: 48 },
    ]) {
      expect(
        issuedInitialDepositScenario(f.issue, { ...f.question, ...changed } as any, f.currentCash),
      ).toBeNull()
      expect(
        initialDepositIssueFromResponse(f.body, { ...f.question, ...changed } as any, NOW, NOW),
      ).toBeNull()
    }
  })
  it('rejects relabeled sources, C+D as measured cash, changed units and modified paths', () => {
    const f = initialDepositUiFixture()
    for (const changed of [
      { cashRaw: '110' },
      { blockHash: `0x${'b'.repeat(64)}` },
      { observedAt: new Date(NOW - 2000).toISOString() },
      { readAtUtc: new Date(NOW + 1).toISOString() },
      { assetDecimals: 18 },
      { freshness: 'stale' },
    ])
      expect(
        issuedInitialDepositScenario(f.issue, f.question, { ...f.currentCash, ...changed }),
      ).toBeNull()
    const changed = structuredClone(f.issue)
    if (changed.projection.status === 'conditional_initial_deposit_projection')
      changed.projection.hypotheticalPostDepositCashRaw = '999'
    expect(issuedInitialDepositScenario(changed, f.question, f.currentCash)).toBeNull()
  })
  it.each([
    { sentAtMs: NaN },
    { sentAtMs: Infinity },
    { sentAtMs: NOW + 1 },
    { receivedAtMs: NOW - 1 },
    { receivedAtMs: NaN },
  ])('rechecks stored issuance clocks before reconstructing a deposit result', (changed) => {
    const f = initialDepositUiFixture()
    expect(
      issuedInitialDepositScenario({ ...f.issue, ...changed }, f.question, f.currentCash),
    ).toBeNull()
  })
  it.each([null, {}, { toString: null }, [], [new Date(NOW).toISOString()], NOW])(
    'rejects a malformed JSON issue clock without coercion or throwing: %j',
    (asOf) => {
      const f = initialDepositUiFixture()
      const body = structuredClone(f.body)
      const issue = structuredClone(f.issue)
      ;(body.initialDepositProjection.request as any).asOf = asOf
      ;(issue.projection.request as any).asOf = asOf
      expect(initialDepositIssueFromResponse(body, f.question, NOW, NOW)).toBeNull()
      expect(issuedInitialDepositScenario(issue, f.question, f.currentCash)).toBeNull()
    },
  )
  it.each([1, 24, 48, 168])(
    'retains the original source, read, issue and %ih target clocks when the display ticks',
    (H) => {
      const f = initialDepositUiFixture({ H })
      const p = issuedInitialDepositScenario(f.issue, f.question, f.currentCash)!
      expect(p.status).toBe('conditional_initial_deposit_projection')
      if (p.status !== 'conditional_initial_deposit_projection') throw Error('missing projection')
      const before = JSON.stringify(p)
      expect(initialDepositRenderWindow(p, NOW + 1000)).toBe(true)
      expect(JSON.stringify(p)).toBe(before)
      expect(p.currentSource).toEqual(f.source)
      expect(p.hypotheticalDepositAtUtc).toBe(f.source.blockTime)
      expect(p.target.at).toBe(new Date(NOW + H * 3600000).toISOString())
      expect(
        initialDepositRenderWindow(p, Date.parse(p.cashOnlyProcess.sourceProofValidUntil) + 1),
      ).toBe(false)
      expect(initialDepositRenderWindow(p, Date.parse(p.target.at))).toBe(false)
      expect(initialDepositIssueFromResponse(f.body, f.question, NOW + 1, NOW + 2)).toBeNull()
    },
  )
})
