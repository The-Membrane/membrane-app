import { encodeAbiParameters } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { readPyusdStakingFirstLeg } from '@/lib/carry/pyusdStakingFirstLeg'
import { HASTRA_STAKING_VAULT } from '@/lib/carry/pyusdStakingRouteIdentity'

const OWNER = '0x0000000000000000000000000000000000000001'
const HASH = `0x${'a'.repeat(64)}` as const

function clientFixture() {
  return {
    request: vi.fn().mockResolvedValue('0x'),
    readContract: vi.fn(async ({ functionName }: { functionName: string; blockHash?: string }) => {
      switch (functionName) {
        case 'balanceOf':
        case 'maxRedeem':
          return 3_000_000n
        case 'paused':
        case 'frozen':
          return false
        case 'previewRedeem':
          return 1_050_000n
        default:
          throw new Error('unexpected_read')
      }
    }),
    call: vi.fn().mockResolvedValue({
      data: encodeAbiParameters([{ type: 'uint256' }], [1_050_000n]),
    }),
  }
}

describe('PYUSD staking independent PRIME first leg', () => {
  it('simulates an exact holder share redemption at the identity block', async () => {
    const client = clientFixture()
    const result = await readPyusdStakingFirstLeg(client as never, OWNER, '1000000', HASH)
    expect(result).toMatchObject({
      requestedPrimeSharesRaw: '1000000',
      holderPrimeSharesRaw: '3000000',
      maxRedeemRaw: '3000000',
      simulatedWyldsRaw: '1050000',
      reason: 'prime_to_wylds_callable',
    })
    expect(client.request).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [OWNER, { blockHash: HASH, requireCanonical: true }],
    })
    expect(client.call).toHaveBeenCalledWith(
      expect.objectContaining({
        to: HASTRA_STAKING_VAULT,
        account: OWNER,
        blockHash: HASH,
        requireCanonical: true,
      }),
    )
    expect(client.readContract.mock.calls.every(([request]) => request.blockHash === HASH)).toBe(
      true,
    )
  })

  it('distinguishes an EVM revert from a provider failure', async () => {
    const client = clientFixture()
    client.call.mockRejectedValueOnce(new Error('execution reverted'))
    const reverted = await readPyusdStakingFirstLeg(client as never, OWNER, '1000000', HASH)
    expect(reverted.reason).toBe('redeem_reverted')
    expect(reverted.simulatedWyldsRaw).toBeNull()
    client.call.mockRejectedValueOnce(new Error('rpc timeout'))
    await expect(readPyusdStakingFirstLeg(client as never, OWNER, '1000000', HASH)).rejects.toThrow(
      'rpc timeout',
    )
  })

  it('rejects a contract holder before claiming EOA forceability', async () => {
    const client = clientFixture()
    client.request.mockResolvedValue('0x6000')
    await expect(readPyusdStakingFirstLeg(client as never, OWNER, '1000000', HASH)).rejects.toThrow(
      'holder_exit_eoa_unverified',
    )
    expect(client.call).not.toHaveBeenCalled()
  })

  it('rejects a missing raw code response instead of assuming an EOA', async () => {
    const client = clientFixture()
    client.request.mockResolvedValue(undefined)
    await expect(readPyusdStakingFirstLeg(client as never, OWNER, '1000000', HASH)).rejects.toThrow(
      'holder_exit_eoa_unverified',
    )
    expect(client.call).not.toHaveBeenCalled()
  })
})
