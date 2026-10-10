import { describe, expect, it } from 'vitest'
import { keccak256, padHex, toEventSelector, toHex } from 'viem'

import {
  makeVerifiedLiquidationEventLoader,
  verifyFinalizedLiquidationSource,
  type LiquidationSourceReads,
} from '@/lib/alerts/verifyLiquidationSource'
import type { FinalizedChainLog } from '@/lib/alerts/outbox'

const emitter = '0x2222222222222222222222222222222222222222'
const owner = '0x1111111111111111111111111111111111111111'
const tx = `0x${'ab'.repeat(32)}`
const hash = `0x${'cd'.repeat(32)}`
const code = '0x6001600055'
const codeHash = keccak256(code)
const time = 1_790_000_000
const claim: FinalizedChainLog = {
  chainId: 1,
  emitter,
  transactionHash: tx,
  logIndex: 2,
  blockNumber: 26_000_000,
  blockHash: hash,
  occurredAt: new Date(time * 1000).toISOString(),
  firstObservedAt: new Date((time + 1) * 1000).toISOString(),
  kind: 'delay_started',
  subjectAddress: owner,
}
const attestedClaim = {
  ...claim,
  sourceAttestation: {
    proofVersion: 1,
    runtimeCodeHash: codeHash,
    positionId: '41',
    startTime: time,
  },
}

function fixture(): LiquidationSourceReads {
  return {
    chainId: async () => 1,
    finalizedBlockNumber: async () => 26_000_010n,
    block: async () => ({ hash, timestamp: BigInt(time) }),
    receipt: async () => ({
      status: 'success',
      blockNumber: 26_000_000n,
      blockHash: hash,
      logs: [
        {
          chainId: 1,
          address: emitter,
          topics: [
            toEventSelector('LiquidationTimerStarted(uint256,address,uint64)'),
            toHex(41n, { size: 32 }),
            padHex(owner, { size: 32 }),
          ],
          data: toHex(time, { size: 32 }),
          transactionHash: tx,
          logIndex: 2,
          blockNumber: 26_000_000n,
          blockHash: hash,
        },
      ],
    }),
    code: async () => code,
  }
}

describe('finalized LiquidationEngine source proof', () => {
  it('returns a sendable record only after matching the exact finalized receipt and runtime', async () => {
    await expect(
      verifyFinalizedLiquidationSource(attestedClaim, emitter, codeHash, fixture()),
    ).resolves.toEqual({ ...claim, positionId: '41', startTime: time })
  })

  it('fails closed on non-finality, receipt, log, time, owner, and runtime mismatches', async () => {
    const cases: Array<[string, FinalizedChainLog, LiquidationSourceReads, string]> = [
      ['chain', attestedClaim, { ...fixture(), chainId: async () => 31337 }, codeHash],
      [
        'head',
        attestedClaim,
        { ...fixture(), finalizedBlockNumber: async () => 25_999_999n },
        codeHash,
      ],
      [
        'block',
        attestedClaim,
        { ...fixture(), block: async () => ({ hash: tx, timestamp: BigInt(time) }) },
        codeHash,
      ],
      [
        'time',
        attestedClaim,
        { ...fixture(), block: async () => ({ hash, timestamp: BigInt(time + 1) }) },
        codeHash,
      ],
      ['receipt', attestedClaim, { ...fixture(), receipt: async () => null }, codeHash],
      ['runtime', attestedClaim, { ...fixture(), code: async () => '0x6002' }, codeHash],
      ['owner', { ...attestedClaim, subjectAddress: emitter }, fixture(), codeHash],
      ['kind', { ...attestedClaim, kind: 'position_kept' }, fixture(), codeHash],
    ]
    for (const [name, event, reads, runtimeHash] of cases) {
      await expect(
        verifyFinalizedLiquidationSource(event, emitter, runtimeHash, reads),
        name,
      ).rejects.toThrow()
    }
  })

  it('rejects absent or conflicting stored position/timer attestation and invalid event timing', async () => {
    const badClaims = [
      claim,
      {
        ...attestedClaim,
        sourceAttestation: { ...attestedClaim.sourceAttestation, positionId: '42' },
      },
      {
        ...attestedClaim,
        sourceAttestation: { ...attestedClaim.sourceAttestation, startTime: time + 1 },
      },
      {
        ...attestedClaim,
        sourceAttestation: { ...attestedClaim.sourceAttestation, runtimeCodeHash: tx },
      },
      {
        ...attestedClaim,
        sourceAttestation: { ...attestedClaim.sourceAttestation, proofVersion: 2 },
      },
    ]
    for (const bad of badClaims)
      await expect(
        verifyFinalizedLiquidationSource(bad, emitter, codeHash, fixture()),
      ).rejects.toThrow()
    const wrongStart = fixture()
    wrongStart.receipt = async (transactionHash) => {
      const receipt = await fixture().receipt(transactionHash)
      if (!receipt) return null
      return { ...receipt, logs: [{ ...receipt.logs[0], data: toHex(time + 1, { size: 32 }) }] }
    }
    await expect(
      verifyFinalizedLiquidationSource(attestedClaim, emitter, codeHash, wrongStart),
    ).rejects.toThrow()
  })

  it('requires an independently configured runtime identity', async () => {
    await expect(verifyFinalizedLiquidationSource(claim, emitter, '0x', fixture())).rejects.toThrow(
      'configuration',
    )
  })

  it('never turns a missing source row into a suppressible null event', async () => {
    const loader = makeVerifiedLiquidationEventLoader(
      async () => null,
      emitter,
      codeHash,
      fixture(),
    )
    await expect(loader('42')).rejects.toThrow('unavailable')
  })
})
