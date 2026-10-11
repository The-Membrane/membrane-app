import { describe, expect, it, vi } from 'vitest'

import {
  issueSusdeCurrentProtocolCapacityEvidence,
  mapSusdeCurrentProtocolCapacityToHolderCurrent,
  readSusdeCurrentProtocolOrigin,
  replaySusdeCurrentProtocolCapacityEvidence,
  susdeCurrentProtocolReadPlan,
} from '@/lib/carry/susdeCurrentProtocolCapacity'
import { buildSusdeHolderTimeProcess } from '@/lib/carry/susdeHolderTimeProcess'
import { susdePinnedJointHistory } from '@/lib/carry/susdeJointHistoryPins'

import {
  syntheticSusdeClient,
  syntheticSusdeExpected,
  SUSDE_SYNTHETIC_NOW as NOW,
} from '../fixtures/susdeCurrentProtocolCapacity'
async function pair() {
  const expected = syntheticSusdeExpected(),
    a = syntheticSusdeClient(expected),
    b = syntheticSusdeClient(expected)
  const first = await readSusdeCurrentProtocolOrigin(a, expected, { now: () => NOW })
  const second = await readSusdeCurrentProtocolOrigin(b, expected, { now: () => NOW + 10 })
  const evidence = issueSusdeCurrentProtocolCapacityEvidence(
    [
      { origin: 'first.example', observation: first! },
      { origin: 'second.example', observation: second! },
    ],
    expected,
    NOW + 20,
  )
  return { expected, a, b, first, second, evidence }
}
describe('sUSDe source-qualified current native economics, synthetic getter controls', () => {
  it('uses genuine captured runtime bytes and 12 serial same-source reads per origin', async () => {
    const p = await pair()
    expect(p.evidence).not.toBeNull()
    expect(p.a.request).toHaveBeenCalledTimes(12)
    expect(p.b.request).toHaveBeenCalledTimes(12)
    expect(p.a.getMaxActive()).toBe(1)
    expect(p.a.request.mock.calls[5][0]).toEqual({
      method: 'eth_call',
      params: susdeCurrentProtocolReadPlan(p.expected)[5].params,
    })
    for (const [wire] of p.a.request.mock.calls.filter(
      ([w]) => w.method !== 'eth_getBlockByNumber',
    ))
      expect(wire.params.at(-1)).toEqual({
        blockHash: p.expected.source.blockHash,
        requireCanonical: true,
      })
    expect(p.first?.traces[0].result).toEqual({
      number: `0x${BigInt(p.expected.source.blockNumber).toString(16)}`,
      hash: p.expected.source.blockHash,
      timestamp: `0x${BigInt(Date.parse(p.expected.source.blockTime) / 1000).toString(16)}`,
    })
    expect(Object.isFrozen(p.first?.traces)).toBe(true)
    const current = replaySusdeCurrentProtocolCapacityEvidence(
      p.evidence,
      p.expected,
      ['first.example', 'second.example'],
      NOW + 20,
    )
    expect(current).toMatchObject({
      activeEntitlementRaw: '5500000',
      pendingAssetsRaw: '2500000',
      readAtUtc: new Date(NOW + 10).toISOString(),
      vaultCashRaw: '9000000',
      siloCashRaw: '3000000',
      successfulExactQInitiation: { requestedRaw: '1000000' },
    })
    expect(p.evidence?.availableAtUtc).toBe(new Date(NOW + 20).toISOString())
    expect(JSON.stringify(p.evidence)).not.toContain('https://')
    expect(p.evidence?.sourceAuthority.attestation).toBe(
      'sourcify_exact_match_not_independent_compilation',
    )
  })
  it('does not approve a self seal or source field flag for the pure model', async () => {
    const p = await pair(),
      names = ['first.example', 'second.example']
    expect(
      mapSusdeCurrentProtocolCapacityToHolderCurrent(p.evidence, p.expected, names, NOW + 20),
    ).toBeNull()
    const current = replaySusdeCurrentProtocolCapacityEvidence(
      p.evidence,
      p.expected,
      names,
      NOW + 20,
    )!
    expect(
      buildSusdeHolderTimeProcess({
        history: susdePinnedJointHistory(),
        current,
        requestedRaw: p.expected.requestedRaw,
        issueAtUtc: new Date(NOW + 20).toISOString(),
        horizonHours: 24,
        analysisMode: 'issue_time_conditional',
      }),
    ).toBeNull()
    // An externally held whole-current approval is mandatory; flags/hashes are insufficient.
    const approved = structuredClone(current)
    const accept = (candidate: unknown) => JSON.stringify(candidate) === JSON.stringify(approved)
    expect(
      mapSusdeCurrentProtocolCapacityToHolderCurrent(
        p.evidence,
        p.expected,
        names,
        NOW + 20,
        accept,
      ),
    ).toEqual(current)
    expect(
      mapSusdeCurrentProtocolCapacityToHolderCurrent(
        p.evidence,
        { ...p.expected, requestedRaw: '2000000' },
        names,
        NOW + 20,
        accept,
      ),
    ).toBeNull()
  })
  it.each([
    'code_vault',
    'activeSharesRaw',
    'activeEntitlementRaw',
    'maxWithdrawRaw',
    'cooldowns',
    'closing_header',
  ])('fails optional-only on malformed or differing %s', async (key) => {
    const expected = syntheticSusdeExpected(),
      client = syntheticSusdeClient(expected, (k, v) => (k === key ? '0x00' : v))
    expect(await readSusdeCurrentProtocolOrigin(client, expected, { now: () => NOW })).toBeNull()
    expect(client.request.mock.calls.length).toBeLessThanOrEqual(12)
  })
  it('retains no provider errors and launches no further read after a timeout', async () => {
    const client = { request: vi.fn(() => new Promise<unknown>(() => {})) }
    expect(
      await readSusdeCurrentProtocolOrigin(client, syntheticSusdeExpected(), {
        now: () => NOW,
        deadlineMs: 1,
      }),
    ).toBeNull()
    expect(client.request).toHaveBeenCalledTimes(1)
  })
  it('rejects different origin labels backed by two reads through the same private client', async () => {
    const expected = syntheticSusdeExpected(),
      client = syntheticSusdeClient(expected)
    const first = await readSusdeCurrentProtocolOrigin(client, expected, { now: () => NOW })
    const second = await readSusdeCurrentProtocolOrigin(client, expected, { now: () => NOW + 10 })
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(
      issueSusdeCurrentProtocolCapacityEvidence(
        [
          { origin: 'a.example', observation: first! },
          { origin: 'b.example', observation: second! },
        ],
        expected,
        NOW + 20,
      ),
    ).toBeNull()
    const distinctClient = syntheticSusdeClient(expected)
    const distinctObservation = await readSusdeCurrentProtocolOrigin(distinctClient, expected, {
      now: () => NOW + 10,
    })
    expect(
      issueSusdeCurrentProtocolCapacityEvidence(
        [
          { origin: 'a.example', observation: first! },
          { origin: 'b.example', observation: distinctObservation! },
        ],
        expected,
        NOW + 20,
      ),
    ).not.toBeNull()
  })

  it('rejects externally fabricated origin observations even if replay is internally consistent', async () => {
    const p = await pair()
    expect(
      issueSusdeCurrentProtocolCapacityEvidence(
        [
          { origin: 'first.example', observation: structuredClone(p.first!) },
          { origin: 'second.example', observation: structuredClone(p.second!) },
        ],
        p.expected,
        NOW + 20,
      ),
    ).toBeNull()
  })
  it.each(['owner', 'Q', 'source', 'frame', 'runtime', 'queuedM', 'clock', 'authority', 'origin'])(
    'rejects %s witness tampering',
    async (variant) => {
      const p = await pair(),
        value = structuredClone(p.evidence!),
        expected = structuredClone(p.expected)
      if (variant === 'owner') expected.owner = '0x0000000000000000000000000000000000000002'
      if (variant === 'Q') expected.requestedRaw = '2'
      if (variant === 'source') expected.source.blockHash = `0x${'b'.repeat(64)}`
      if (variant === 'frame')
        value.origins[1].observation.traces[11].result = {
          number: '0x1',
          hash: expected.source.blockHash,
          timestamp: '0x1',
        }
      if (variant === 'runtime') value.runtimeCodes.asset = '0x00'
      if (variant === 'queuedM') expected.pendingAssetsRaw = '5500000'
      if (variant === 'clock')
        value.origins[1].observation.readAtUtc = new Date(NOW + 8001).toISOString()
      if (variant === 'authority')
        (value.sourceAuthority.primarySources as Record<string, string>).erc4626 = '0'.repeat(64)
      if (variant === 'origin') value.origins[1].origin = 'first.example'
      expect(
        replaySusdeCurrentProtocolCapacityEvidence(
          value,
          expected,
          ['first.example', 'second.example'],
          NOW + 20,
        ),
      ).toBeNull()
    },
  )
  it('does not create an exact-Q initiation witness when the pinned assay reverted', async () => {
    const expected = { ...syntheticSusdeExpected(), initiationStatus: 'evm_revert' as const },
      a = syntheticSusdeClient(expected),
      b = syntheticSusdeClient(expected)
    const first = await readSusdeCurrentProtocolOrigin(a, expected, { now: () => NOW }),
      second = await readSusdeCurrentProtocolOrigin(b, expected, { now: () => NOW })
    const evidence = issueSusdeCurrentProtocolCapacityEvidence(
      [
        { origin: 'a.example', observation: first! },
        { origin: 'b.example', observation: second! },
      ],
      expected,
      NOW,
    )
    expect(
      replaySusdeCurrentProtocolCapacityEvidence(
        evidence,
        expected,
        ['a.example', 'b.example'],
        NOW,
      ),
    ).not.toHaveProperty('successfulExactQInitiation')
  })
})
