// Versioned August 2026 frozen cohort. Changing the identities requires a new report schema.
const FROZEN_GROSS_FLOW_PINS = Object.freeze({
  manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
  identitySetSha256: '446600e2c0822845310c8a3c60bd3cb4a80e3fac57bfeef64c959e724e800a8b',
  routeGroups: 25,
  exactSubjects: 67,
  morpho: Object.freeze({
    enrollmentSha256: 'bbd82ad83c8ad16a9d1ee51575c59fd0e833db2692e4206dd5786704ecc7c0f0',
    exactVaults: 49,
    routeKeys: Object.freeze([
      'AUSD → VaultV2 [AUSD]',
      'EURCV → VaultV2 [EURCV]',
      'LINK → VaultV2 [LINK]',
      'PYUSD → VaultV2 [PYUSD]',
      'RLUSD → VaultV2 [RLUSD]',
      'USDC → VaultV2 [USDC]',
      'USDT → VaultV2 [USDT]',
    ]),
  }),
  secondaryRouteFlows: Object.freeze({
    sUSDe: Object.freeze({
      venue: 'sUSDe',
      routeKey: 'USDe → Staked USDe [USDe]',
      destination: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
      subjectAsset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
      genesisSha256: 'd5078ec88d85d2754fbbe020c5013b7b6c6cc54c551207444087fda2fcb0a837',
      attribution: 'configured_curve_pool_swaps_not_holder_attributed',
      legs: Object.freeze([
        Object.freeze({
          market: '0x744793b5110f6ca9cc7cdfe1ce16677c3eb192ef',
          outputAsset: '0x865377367054516e17014ccded1e7d814edc9ce4',
          outputSymbol: 'DOLA',
          outputDecimals: 18,
          scope: 'configured_curve_pool_swap',
          exitDirection: 'toward_exit',
          entryDirection: 'toward_entry',
        }),
      ]),
    }),
    sUSDS: Object.freeze({
      venue: 'sUSDS',
      routeKey: 'USDS → SUsds [USDS]',
      destination: '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',
      subjectAsset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
      genesisSha256: 'c826f9cd099f75e39c31dd49667c372223ccb709516edfd84d07f73b05c53105',
      attribution: 'shared_psm_leg_not_susds_holder_attributed',
      legs: Object.freeze([
        Object.freeze({
          market: '0xf6e72db5454dd049d0788e411b06cfaf16853042',
          outputAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          outputSymbol: 'USDC',
          outputDecimals: 6,
          scope: 'shared_psm_buy_sell_gem_leg',
          exitDirection: 'buyGem',
          entryDirection: 'sellGem',
        }),
      ]),
    }),
  }),
})

export default FROZEN_GROSS_FLOW_PINS
