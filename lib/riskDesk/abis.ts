// Minimal read-only ABIs for the risk desk. Every signature below was checked
// against membrane-solidity branch feat/ltv-change-cap (the local anvil deploy):
//   Collateral.sol   assets :86 (struct :47), assetList :502, targetMaxLTV :521,
//                    currentMaxLTV :554, ltvGlideOf :721 (struct LtvGlide :182),
//                    pendingLtvMove :730, discoOracle :103, LtvGlideUpdated :248
//   LtvDisco.sol     assetTotalMbrn :305, assetTotalVT :323,
//                    assetLtvSupplyFloor :353, queryAverageLTV :1701
//   RevenueDistributor.sol reserveAccumulation :171, epochRevenueAccumulation :206,
//                    revenueSplit :166 (struct RevenueSplit :130)
//   Transmuter.sol   trancheStates :323 (struct TrancheState :179),
//                    totalOutstandingHole :392
//   LiqQueue.sol     totalBidSupply :2008
//   Auction.sol      getAllocation :1536 (struct :173), isAllocationActive :1540

export const collateralAbi = [
  { type: 'function', name: 'assetList', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32[]' }] },
  {
    type: 'function',
    name: 'assets',
    stateMutability: 'view',
    inputs: [{ name: 'denom', type: 'bytes32' }],
    outputs: [
      { name: 'denom', type: 'bytes32' },
      { name: 'temp_ltv', type: 'uint256' },
      { name: 'max_threshold_to_delay', type: 'uint256' },
      { name: 'oracle_source', type: 'address' },
      { name: 'enabled', type: 'bool' },
      { name: 'onboarding_window_end', type: 'uint64' },
      { name: 'max_ltv_cap', type: 'uint256' },
    ],
  },
  { type: 'function', name: 'targetMaxLTV', stateMutability: 'view', inputs: [{ name: 'asset', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'currentMaxLTV', stateMutability: 'view', inputs: [{ name: 'asset', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'pendingLtvMove', stateMutability: 'view', inputs: [{ name: 'asset', type: 'bytes32' }], outputs: [{ type: 'int128' }] },
  {
    type: 'function',
    name: 'ltvGlideOf',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'applied', type: 'uint128' },
          { name: 'committed', type: 'int128' },
          { name: 'windowStart', type: 'uint64' },
          { name: 'seeded', type: 'bool' },
        ],
      },
    ],
  },
  { type: 'function', name: 'discoOracle', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'event',
    name: 'LtvGlideUpdated',
    inputs: [
      { name: 'denom', type: 'bytes32', indexed: true },
      { name: 'applied', type: 'uint128', indexed: false },
      { name: 'committed', type: 'int128', indexed: false },
      { name: 'windowStart', type: 'uint64', indexed: false },
    ],
  },
] as const

export const ltvDiscoAbi = [
  { type: 'function', name: 'assetTotalMbrn', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'assetTotalVT', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'assetLtvSupplyFloor', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'queryAverageLTV', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
] as const

export const revenueDistributorAbi = [
  { type: 'function', name: 'reserveAccumulation', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'epochRevenueAccumulation', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'revenueSplit',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'disco_ratio', type: 'uint256' },
      { name: 'junior_ratio', type: 'uint256' },
      { name: 'senior_ratio', type: 'uint256' },
      { name: 'reserve_ratio', type: 'uint256' },
    ],
  },
] as const

export const transmuterAbi = [
  {
    type: 'function',
    name: 'trancheStates',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'bool' }],
    outputs: [
      { name: 'vault_token_supply', type: 'uint256' },
      { name: 'total_staked', type: 'uint256' },
    ],
  },
  { type: 'function', name: 'totalOutstandingHole', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

export const liqQueueAbi = [
  { type: 'function', name: 'totalBidSupply', stateMutability: 'view', inputs: [{ name: 'asset', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
] as const

export const auctionAbi = [
  {
    type: 'function',
    name: 'getAllocation',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'asset', type: 'bytes32' },
          { name: 'mbrnAllocated', type: 'uint256' },
          { name: 'mbrnUsed', type: 'uint256' },
          { name: 'cdtBadDebt', type: 'uint256' },
          { name: 'cdtFulfilled', type: 'uint256' },
        ],
      },
    ],
  },
  { type: 'function', name: 'isAllocationActive', stateMutability: 'view', inputs: [{ name: 'asset', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
] as const
