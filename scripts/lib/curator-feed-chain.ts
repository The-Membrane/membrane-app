/**
 * Chain configuration for the curator-feed collector. Ethereum mainnet only today
 * (owner 2026-10-11: "we launch on mainnet only"); another chain is a new entry here
 * with its own factories, singletons and Aave configurators — the collector reads
 * nothing chain-specific from anywhere else.
 *
 * Every address below was checked on chain on 2026-10-07 / 2026-10-11:
 *   MetaMorpho factories: isMetaMorpho(known vault) = true (v1.0 holds Steakhouse /
 *   Gauntlet USDC; v1.1 the newer vaults). VaultV2Factory.isVaultV2 = true for a known V2
 *   vault; deployed at block 23,375,073 (binary search on getCode). Euler Earn factory
 *   from euler-xyz/euler-interfaces addresses/1/CoreAddresses.json (getVaultListLength = 48).
 *   MorphoMarketV1AdapterV2Factory.isMorphoMarketV1AdapterV2 = true for a live adapter.
 *   Aave PoolConfigurators from bgd-labs/aave-address-book (AaveV3Ethereum*.sol).
 */

export interface ChainConfig {
  key: string
  chainId: 1
  morpho: string
  mmFactories: string[]
  v2Factory: string
  /** First block with VaultV2Factory code (allocator history starts here). */
  v2FactoryDeploy: number
  v2AdapterFactory: string
  eeFactory: string
  morphoPublicAllocator: string
  eulerPublicAllocator: string
  aave: Record<string, string>
  /** Morpho API chain id + Euler labels path segment. */
  morphoApiChainId: number
  eulerLabels: string
}

export const MAINNET: ChainConfig = {
  key: 'ethereum',
  chainId: 1,
  morpho: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
  mmFactories: [
    '0xa9c3d3a366466fa809d1ae982fb2c46e5fc41101', // MetaMorpho v1.0
    '0x1897a8997241c1cd4bd0698647e4eb7213535c24', // MetaMorpho v1.1
  ],
  v2Factory: '0xa1d94f746defa1928926b84fb2596c06926c0405',
  v2FactoryDeploy: 23_375_073,
  v2AdapterFactory: '0x32bb1c0d48d8b1b3363e86eeb9a0300bad61ccc1',
  eeFactory: '0x59709b029b140c853fe28d277f83c3a65e308af4',
  morphoPublicAllocator: '0xfd32fa2ca22c76dd6e550706ad913fc6ce91c75d',
  eulerPublicAllocator: '0x8fdcb80a2894f0dc052c8d52d22544dc90274800',
  aave: {
    '0x64b761d848206f447fe2dd461b0c635ec39ebb27': 'Aave v3 Core',
    '0x342631c6cefc9cfbf97b2fe4aa242a236e1fd517': 'Aave v3 Prime',
    '0x8438f4d29d895d75c86bdc25360c25ef0607e65d': 'Aave v3 EtherFi',
    '0x83cb1b4af26eef6463ac20afbac9c0e2e017202f': 'Aave v3 Horizon',
  },
  morphoApiChainId: 1,
  eulerLabels: 'https://raw.githubusercontent.com/euler-xyz/euler-labels/master/1/entities.json',
}

export const CHAINS: Record<string, ChainConfig> = { ethereum: MAINNET }
