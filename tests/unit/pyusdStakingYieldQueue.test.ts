import { describe, expect, it, vi } from 'vitest'

import { readPyusdStakingYieldQueue } from '@/lib/carry/pyusdStakingYieldQueue'
import { HASTRA_YIELD_VAULT } from '@/lib/carry/pyusdStakingRouteIdentity'

const HASH = `0x${'a'.repeat(64)}` as const
const HOLDER = '0x0000000000000000000000000000000000000001'
const REDEEM_VAULT = '0x0000000000000000000000000000000000000002'

describe('Hastra existing holder wYLDS queue', () => {
  it('reads holder state at the verified route block without simulating a new request', async () => {
    const values: Record<string, unknown> = {
      balanceOf: 2_000_000n,
      pendingRedemptions: [1_000_000n, 990_000n, 1_790_800_000n],
      paused: false,
      frozen: false,
      redeemVault: REDEEM_VAULT,
    }
    const readContract = vi.fn(async (args: { functionName: string }) => values[args.functionName])
    const result = await readPyusdStakingYieldQueue({ readContract } as never, HOLDER, HASH)
    expect(result).toEqual({
      holder: HOLDER,
      existingWyldsSharesRaw: '2000000',
      pendingSharesRaw: '1000000',
      pendingUsdcRaw: '990000',
      pendingSinceUnix: '1790800000',
      yieldPaused: false,
      yieldFrozen: false,
      redeemVault: REDEEM_VAULT,
      requestAssessed: false,
      completion: 'admin_gated_unassessed',
      usdcPayout: 'not_attested',
    })
    expect(readContract).toHaveBeenCalledTimes(5)
    for (const [args] of readContract.mock.calls)
      expect(args).toMatchObject({
        address: HASTRA_YIELD_VAULT,
        blockHash: HASH,
        requireCanonical: true,
      })
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'pendingRedemptions',
        args: [HOLDER],
      }),
    )
  })

  it('rejects invalid block identity before calling the provider', async () => {
    const readContract = vi.fn()
    await expect(
      readPyusdStakingYieldQueue({ readContract } as never, HOLDER, '0x1234'),
    ).rejects.toThrow('pyusd_staking_yield_queue_input_invalid')
    expect(readContract).not.toHaveBeenCalled()
  })
})
