/**
 * Minimal CuratorRegistry ABI — read-only views + the history events.
 *
 * Source of truth: membrane-solidity (branch feat/ltv-change-cap)
 * contracts/CuratorRegistry.sol. Every entry below was checked against that file;
 * units noted per entry. CDT is an 18-decimal ERC20, so every CDT figure is WAD.
 */
export const curatorRegistryAbi = [
  // ── enumeration ────────────────────────────────────────────────────────────
  // address[] public allVaults  (CuratorRegistry.sol:296)
  { type: 'function', name: 'allVaults', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  // :947
  { type: 'function', name: 'allVaultsLength', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },

  // ── bond ───────────────────────────────────────────────────────────────────
  // mapping(address => uint256) public bondOf — CDT wei (:247)
  { type: 'function', name: 'bondOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  // uint256 public totalBonded — CDT wei, Σ bondOf (:249)
  { type: 'function', name: 'totalBonded', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  // mapping(address => Unbond) public pendingUnbond — (bool active, uint256 newCap CDT wei, uint64 readyTime unix s) (:274-280)
  {
    type: 'function',
    name: 'pendingUnbond',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [
      { name: 'active', type: 'bool' },
      { name: 'newCap', type: 'uint256' },
      { name: 'readyTime', type: 'uint64' },
    ],
  },

  // ── capacity / reputation ──────────────────────────────────────────────────
  // aumCap(vault) — CDT wei; 0 when unlisted, else BASE_CAP (100_000e18) + bond·1e18/curve (:593)
  { type: 'function', name: 'aumCap', stateMutability: 'view', inputs: [{ name: 'vault', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  // rampOf(vault) — WAD fraction of the 90-day reputation clock, 0..1e18 (:610)
  { type: 'function', name: 'rampOf', stateMutability: 'view', inputs: [{ name: 'vault', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  // mapping(address => uint256) public trackedAum — CDT-value WAD (:261)
  { type: 'function', name: 'trackedAum', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },

  // ── payment ranking ────────────────────────────────────────────────────────
  // realizedRate(vault) — annualized WAD (1e18 = 100%/yr); 0 with no payments or no AUM (:732)
  { type: 'function', name: 'realizedRate', stateMutability: 'view', inputs: [{ name: 'vault', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  // rateDenominator(vault) == trackedAum(vault), CDT wei (:728)
  { type: 'function', name: 'rateDenominator', stateMutability: 'view', inputs: [{ name: 'vault', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  // trailingPayments(vault) — CDT wei over the trailing 30 × 1-day ring (:943)
  { type: 'function', name: 'trailingPayments', stateMutability: 'view', inputs: [{ name: 'vault', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  // avoidanceRate() — WAD/yr, stored (:793)
  { type: 'function', name: 'avoidanceRate', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  // bucketOf(vault) — index = realizedRate / 5e15 (0.5% wide), clamped to 2000 (:747)
  { type: 'function', name: 'bucketOf', stateMutability: 'view', inputs: [{ name: 'vault', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  // bucketMembers(index) — settled members + their trackedAum (:757)
  {
    type: 'function',
    name: 'bucketMembers',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [
      { name: 'vaults', type: 'address[]' },
      { name: 'aums', type: 'uint256[]' },
    ],
  },
  // :776 / :781 / :786 — NO_BUCKET == type(uint256).max
  { type: 'function', name: 'lowestNonEmptyBucket', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'highestSeenBucket', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'noBucketSentinel', stateMutability: 'pure', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  // bytes32 public servedAssetDenom (:237)
  { type: 'function', name: 'servedAssetDenom', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }] },

  // ── events (:363-375) ──────────────────────────────────────────────────────
  { type: 'event', name: 'BondPosted', inputs: [
    { name: 'vault', type: 'address', indexed: true },
    { name: 'payer', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'newBond', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'UnbondBegun', inputs: [
    { name: 'vault', type: 'address', indexed: true },
    { name: 'newCap', type: 'uint256', indexed: false },
    { name: 'readyTime', type: 'uint64', indexed: false },
  ] },
  { type: 'event', name: 'UnbondCompleted', inputs: [
    { name: 'vault', type: 'address', indexed: true },
    { name: 'newCap', type: 'uint256', indexed: false },
    { name: 'released', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'PaymentRecorded', inputs: [
    { name: 'vault', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'trailingTotal', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'RateDeclared', inputs: [
    { name: 'vault', type: 'address', indexed: true },
    { name: 'rateWad', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'AumCredited', inputs: [
    { name: 'vault', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'newTrackedAum', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'AumDebited', inputs: [
    { name: 'vault', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'newTrackedAum', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'Slashed', inputs: [
    { name: 'vault', type: 'address', indexed: true },
    { name: 'failedAmount', type: 'uint256', indexed: false },
    { name: 'slashed', type: 'uint256', indexed: false },
    { name: 'newBond', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'SlashedOnLoss', inputs: [
    { name: 'vault', type: 'address', indexed: true },
    { name: 'lossRatioWad', type: 'uint256', indexed: false },
    { name: 'slashed', type: 'uint256', indexed: false },
    { name: 'newBond', type: 'uint256', indexed: false },
  ] },
] as const

/** The event names the history list is built from. */
export const CURATOR_HISTORY_EVENTS = [
  'BondPosted',
  'UnbondBegun',
  'UnbondCompleted',
  'PaymentRecorded',
  'RateDeclared',
  'AumCredited',
  'AumDebited',
  'Slashed',
  'SlashedOnLoss',
] as const
