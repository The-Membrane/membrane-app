import { describe, expect, it } from 'vitest'

import { aggregateUmbrellaRedeemEvidence } from '@/lib/carry/localHolderExitEvidence'

const route = 'GHO → UmbrellaStakeToken [GHO]'
const destination = '0x4f827a63755855cdf3e8f3bcd20265c833f15033'
const issue = {
  sequence: 1,
  sha256: 'sealed',
  routeKey: route,
  destination,
  measurement: { gate: 'waiting', outcome: 'evm_revert' as const },
  targets: [{ horizonHours: 1, deadlineUtc: '2026-10-01T06:00:00.000Z' }],
}

describe('public Umbrella holder evidence', () => {
  it('keeps a waiting cooldown and a pending future check separate from exit availability', () => {
    const cells = aggregateUmbrellaRedeemEvidence(
      route,
      destination,
      [issue],
      [],
      Date.parse('2026-10-01T04:00:00.000Z'),
    )
    expect(cells).toMatchObject([
      {
        issued: 1,
        baselineWaiting: 1,
        baselineReverted: 1,
        stateScored: 0,
        redeemCallMeasured: 0,
        pending: 1,
      },
    ])
    expect(JSON.stringify(cells)).not.toContain('0x')
  })

  it('counts observed recovery only when the same holder redeem call was measured', () => {
    const cells = aggregateUmbrellaRedeemEvidence(
      route,
      destination,
      [issue],
      [
        {
          issueSequence: 1,
          issueSha256: 'sealed',
          horizonHours: 1,
          status: 'measured',
          transition: 'simulated_call_recovery',
          measurement: { gate: 'window_open', outcome: 'success' },
        },
      ],
    )
    expect(cells[0]).toMatchObject({
      stateScored: 1,
      redeemCallMeasured: 1,
      simulatedCallRecovery: 1,
      windowOpen: 1,
    })
  })

  it('rejects a score that points at a different immutable issue', () => {
    expect(() =>
      aggregateUmbrellaRedeemEvidence(
        route,
        destination,
        [issue],
        [
          {
            issueSequence: 1,
            issueSha256: 'changed',
            horizonHours: 1,
            status: 'measured',
            transition: 'still_reverting',
            measurement: { gate: 'waiting', outcome: 'evm_revert' },
          },
        ],
      ),
    ).toThrow('umbrella_redeem_score_issue_mismatch')
  })
})
