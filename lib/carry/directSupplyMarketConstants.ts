/**
 * Ethereum market addresses copied from the identity-checked research market
 * lists, without importing their CLI modules (which have top-level await).
 * Runtime reads must still verify each contract's underlying at a finalized
 * block before these addresses support a cash observation.
 *
 * Sources: scripts/research/aave-core-forward-panel.mjs MARKETS,
 * scripts/research/carry-public-direct-exit-issue.mjs frozen Aave USDe route,
 * scripts/research/compound-comet-weekly-screen.mjs MARKETS, and the
 * receipt-verified August SparkLend route manifest.
 */
export const DIRECT_SUPPLY_MARKETS = {
  aaveV3Usdc: {
    routeKey: 'USDC → supply on Aave V3',
    destination: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
    underlying: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
  },
  aaveV3Usde: {
    routeKey: 'USDe → supply on Aave V3',
    destination: '0x4F5923Fc5FD4a93352581b38B7cD26943012DECF',
    underlying: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
    decimals: 18,
  },
  compoundV3Usdc: {
    routeKey: 'USDC → supply on Compound v3',
    destination: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    underlying: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
  },
  sparkLendUsdt: {
    routeKey: 'USDT → supply on Spark',
    destination: '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f',
    underlying: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    decimals: 6,
  },
} as const
