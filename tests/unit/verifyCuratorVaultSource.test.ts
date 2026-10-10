import { encodeAbiParameters, encodeEventTopics, keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  CURATOR_VAULT_ACTION_ABI,
  decodeCandidateCuratorVaultAction,
} from '@/lib/alerts/curatorVaultEvents'
import {
  verifyFinalizedCuratorVaultSource,
  type CuratorVaultSourceReads,
} from '@/lib/alerts/verifyCuratorVaultSource'

const FACTORY = '0x1111111111111111111111111111111111111111'
const VAULT = '0x2222222222222222222222222222222222222222'
const VENUE = '0x3333333333333333333333333333333333333333'
const TX = `0x${'a'.repeat(64)}`
const BLOCK_HASH = `0x${'b'.repeat(64)}`
const FACTORY_CODE = '0x60016000'
const VAULT_CODE = '0x60026000'
const FACTORY_HASH = keccak256(FACTORY_CODE)
const VAULT_HASH = keccak256(VAULT_CODE)

const raw = {
  chainId: 1,
  address: VAULT,
  topics: encodeEventTopics({
    abi: CURATOR_VAULT_ACTION_ABI,
    eventName: 'CapSet',
    args: { venue: VENUE },
  }),
  data: encodeAbiParameters([{ type: 'uint256' }], [100n]),
  transactionHash: TX,
  logIndex: 2,
  blockNumber: 25_000_000n,
  blockHash: BLOCK_HASH,
  removed: false,
}
const claim = decodeCandidateCuratorVaultAction(raw, VAULT)!

function reads(overrides: Partial<CuratorVaultSourceReads> = {}): CuratorVaultSourceReads {
  return {
    chainId: async () => 1,
    finalizedBlockNumber: async () => 25_000_100n,
    block: async () => ({ hash: BLOCK_HASH, timestamp: 1_800_000_000n }),
    receipt: async () => ({
      status: 'success',
      blockNumber: 25_000_000n,
      blockHash: BLOCK_HASH,
      logs: [raw],
    }),
    code: async (address) => (address === FACTORY ? FACTORY_CODE : VAULT_CODE),
    factoryRecognizesVault: async () => true,
    ...overrides,
  }
}

const verify = (source: CuratorVaultSourceReads, event = claim) =>
  verifyFinalizedCuratorVaultSource(event, FACTORY, FACTORY_HASH, VAULT_HASH, source)

describe('finalized CuratorVault action source', () => {
  it('returns only receipt-decoded action fields after finality and factory/instance checks', async () => {
    let recognitionBlock: bigint | null = null
    const result = await verify(
      reads({
        factoryRecognizesVault: async (_factory, _vault, block) => {
          recognitionBlock = block
          return true
        },
      }),
      { ...claim, args: { cap: 999n } },
    )
    expect(result).toMatchObject({
      status: 'verified_finalized',
      action: 'CapSet',
      vault: VAULT,
      args: { venue: VENUE, cap: 100n },
      occurredAt: '2027-01-15T08:00:00.000Z',
    })
    expect(recognitionBlock).toBe(25_000_000n)
  })

  it('rejects unfinalized, failed, wrong-chain, and noncanonical receipts', async () => {
    await expect(verify(reads({ finalizedBlockNumber: async () => 24_999_999n }))).rejects.toThrow()
    await expect(verify(reads({ chainId: async () => 31337 }))).rejects.toThrow()
    await expect(
      verify(
        reads({
          receipt: async () => ({
            status: 'reverted',
            blockNumber: 25_000_000n,
            blockHash: BLOCK_HASH,
            logs: [raw],
          }),
        }),
      ),
    ).rejects.toThrow()
    await expect(
      verify(reads({ block: async () => ({ hash: `0x${'c'.repeat(64)}`, timestamp: 1n }) })),
    ).rejects.toThrow()
  })

  it('rejects absent factory membership and either wrong runtime identity', async () => {
    await expect(verify(reads({ factoryRecognizesVault: async () => false }))).rejects.toThrow()
    await expect(
      verify(reads({ code: async (address) => (address === FACTORY ? '0x6000' : VAULT_CODE) })),
    ).rejects.toThrow()
    await expect(
      verify(reads({ code: async (address) => (address === FACTORY ? FACTORY_CODE : '0x6000') })),
    ).rejects.toThrow()
  })

  it('rejects missing, duplicate, or action-mismatched receipt logs', async () => {
    await expect(
      verify(
        reads({
          receipt: async () => ({
            status: 'success',
            blockNumber: 25_000_000n,
            blockHash: BLOCK_HASH,
            logs: [],
          }),
        }),
      ),
    ).rejects.toThrow()
    await expect(
      verify(
        reads({
          receipt: async () => ({
            status: 'success',
            blockNumber: 25_000_000n,
            blockHash: BLOCK_HASH,
            logs: [raw, raw],
          }),
        }),
      ),
    ).rejects.toThrow()
    await expect(verify(reads(), { ...claim, action: 'PendingCapSubmitted' })).rejects.toThrow()
    await expect(
      verify(
        reads({
          receipt: async () => ({
            status: 'success',
            blockNumber: 25_000_000n,
            blockHash: BLOCK_HASH,
            logs: [{ ...raw, topics: undefined }],
          }),
        }),
      ),
    ).rejects.toThrow()
  })
})
