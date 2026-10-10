import { describe, expect, it, vi } from 'vitest'

import { readLocalHolderExitEvidence } from '@/lib/carry/localHolderExitEvidence'
import { UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO } from '@/lib/carry/umbrellaGhoExit'

vi.mock('@/scripts/research/carry-local-umbrella-gho-holder.mjs', () => ({
  verifyAll: async () => ({ issues: [], scores: [] }),
}))
vi.mock('@/scripts/research/carry-public-sgho-exit-issue.mjs', () => {
  throw Error('unrelated_sgho_ledger_unavailable')
})

describe('Umbrella holder evidence isolation', () => {
  it('returns its own empty ledger without reading unrelated holder studies', async () => {
    await expect(readLocalHolderExitEvidence(UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO)).resolves.toEqual(
      expect.objectContaining({
        status: 'unavailable',
        cells: [],
        queueRequestEvidence: null,
        umbrellaRedeemEvidence: expect.objectContaining({ cells: [] }),
      }),
    )
  })
})
