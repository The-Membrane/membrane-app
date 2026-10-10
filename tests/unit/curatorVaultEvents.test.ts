import { encodeAbiParameters, encodeEventTopics, toEventSelector } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  CURATOR_VAULT_ACTION_ABI,
  decodeCandidateCuratorVaultAction,
  type RawCuratorVaultLog,
} from '@/lib/alerts/curatorVaultEvents'

const VAULT = '0x1111111111111111111111111111111111111111'
const VENUE = '0x2222222222222222222222222222222222222222'
const CALLER = '0x3333333333333333333333333333333333333333'
const OTHER = '0x4444444444444444444444444444444444444444'
const HASH = `0x${'a'.repeat(64)}`
const BLOCK_HASH = `0x${'b'.repeat(64)}`

function log(topics: readonly `0x${string}`[], data: `0x${string}`): RawCuratorVaultLog {
  return {
    chainId: 1,
    address: VAULT,
    topics,
    data,
    transactionHash: HASH,
    logIndex: 2,
    blockNumber: 25_000_000n,
    blockHash: BLOCK_HASH,
    removed: false,
  }
}

describe('CuratorVault candidate manager actions', () => {
  it('distinguishes a pending cap proposal from an applied cap', () => {
    const pending = decodeCandidateCuratorVaultAction(
      log(
        encodeEventTopics({
          abi: CURATOR_VAULT_ACTION_ABI,
          eventName: 'PendingCapSubmitted',
          args: { venue: VENUE },
        }),
        encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [100n, 1_800_000_000n]),
      ),
      VAULT,
    )
    expect(pending?.action).toBe('PendingCapSubmitted')
    expect(pending?.args).toMatchObject({ venue: VENUE, cap: 100n, validAt: 1_800_000_000n })
    expect(pending?.status).toBe('candidate_unfinalized')

    const applied = decodeCandidateCuratorVaultAction(
      log(
        encodeEventTopics({
          abi: CURATOR_VAULT_ACTION_ABI,
          eventName: 'CapSet',
          args: { venue: VENUE },
        }),
        encodeAbiParameters([{ type: 'uint256' }], [100n]),
      ),
      VAULT,
    )
    expect(applied?.action).toBe('CapSet')
    expect(applied?.args).toMatchObject({ venue: VENUE, cap: 100n })
  })

  it('decodes actual reallocation, queue and rate actions', () => {
    const cases = [
      {
        name: 'Reallocated' as const,
        args: { caller: CALLER },
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [10n, 10n]),
      },
      {
        name: 'SupplyQueueSet' as const,
        args: { caller: CALLER },
        data: encodeAbiParameters([{ type: 'address[]' }], [[VENUE]]),
      },
      {
        name: 'WithdrawQueueSet' as const,
        args: { caller: CALLER },
        data: encodeAbiParameters([{ type: 'address[]' }], [[VENUE]]),
      },
      {
        name: 'ProtocolRateDeclared' as const,
        args: {},
        data: encodeAbiParameters([{ type: 'uint256' }], [10n ** 16n]),
      },
    ]
    for (const item of cases) {
      const decoded = decodeCandidateCuratorVaultAction(
        log(
          encodeEventTopics({
            abi: CURATOR_VAULT_ACTION_ABI,
            eventName: item.name,
            args: item.args,
          }),
          item.data,
        ),
        VAULT,
      )
      expect(decoded?.action).toBe(item.name)
    }
  })

  it('rejects a foreign emitter, removed log, malformed payload and unlisted event', () => {
    const valid = log(
      encodeEventTopics({
        abi: CURATOR_VAULT_ACTION_ABI,
        eventName: 'PendingCapRevoked',
        args: { venue: VENUE },
      }),
      '0x',
    )
    expect(decodeCandidateCuratorVaultAction(valid, VAULT)?.action).toBe('PendingCapRevoked')
    expect(decodeCandidateCuratorVaultAction({ ...valid, address: OTHER }, VAULT)).toBeNull()
    expect(decodeCandidateCuratorVaultAction({ ...valid, removed: true }, VAULT)).toBeNull()
    expect(decodeCandidateCuratorVaultAction({ ...valid, blockNumber: 0 }, VAULT)).toBeNull()
    expect(decodeCandidateCuratorVaultAction({ ...valid, data: '0x12' }, VAULT)).toBeNull()
    expect(
      decodeCandidateCuratorVaultAction(
        { ...valid, topics: [toEventSelector('Transfer(address,address,uint256)')] },
        VAULT,
      ),
    ).toBeNull()
  })
})
