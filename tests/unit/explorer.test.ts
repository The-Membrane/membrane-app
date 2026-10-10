import { describe, expect, it } from 'vitest'
import { mainnet, sepolia } from 'viem/chains'

import { anvil } from '@/config/evm/chains'
import { getTxExplorerUrl } from '@/helpers/explorer'

// Contract tests for the tx explorer link shared by the toaster, the confirm modal's
// ExplorerLink and Ditto's tx confirmation. What must hold: the link comes from the active
// viem chain's block explorer (never a hard-coded Cosmos explorer), and a chain without an
// explorer yields no link rather than a wrong one.

const HASH = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060'

describe('getTxExplorerUrl', () => {
  it('builds <chain blockExplorers.default.url>/tx/<hash>', () => {
    expect(getTxExplorerUrl(mainnet, HASH)).toBe(`https://etherscan.io/tx/${HASH}`)
    expect(getTxExplorerUrl(sepolia, HASH)).toBe(`https://sepolia.etherscan.io/tx/${HASH}`)
  })

  it('never points at the legacy Cosmos explorers', () => {
    expect(getTxExplorerUrl(mainnet, HASH)).not.toMatch(/celatone|osmosis\.zone|mintscan/)
  })

  it('drops trailing slashes on the base url', () => {
    const chain = { blockExplorers: { default: { name: 'X', url: 'https://explorer.example/' } } }
    expect(getTxExplorerUrl(chain, HASH)).toBe(`https://explorer.example/tx/${HASH}`)
  })

  it('returns undefined when the chain has no block explorer (local anvil)', () => {
    expect(getTxExplorerUrl(anvil, HASH)).toBeUndefined()
    expect(getTxExplorerUrl(undefined, HASH)).toBeUndefined()
  })

  it('returns undefined without a tx hash', () => {
    expect(getTxExplorerUrl(mainnet, undefined)).toBeUndefined()
    expect(getTxExplorerUrl(mainnet, '')).toBeUndefined()
  })
})
