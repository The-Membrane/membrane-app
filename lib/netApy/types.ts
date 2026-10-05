/**
 * NET APY AT SIZE — shared types.
 *
 * THE THREE CONTRACT TERMS this lane exports (umbrella board entry, Layer DATA+PRODUCT):
 *
 *   venue-key     a stable lowercase slug, `<protocol>-<market>`, e.g. `aave-v3-usdc`,
 *                 `morpho-blue-cbbtc-usdc-86`, `euler-v2-eusdc-2`. Where the venue
 *                 recorder already names a venue (tools/venue-recorder.config.json
 *                 `name`), the key IS that name (`aave-v3-usde`), so rows join.
 *   block anchor  every on-chain number in one snapshot was read at ONE block
 *                 (`BlockAnchor`). A projection names the anchor it projects from.
 *   label class   every figure says what kind of claim it is (`LabelClass`). A
 *                 projection is never shown as a measurement, and nothing here is a
 *                 promise of positive carry.
 */

export type Address = `0x${string}`

export interface BlockAnchor {
  chainId: 1
  blockNumber: bigint
  /** block.timestamp, seconds. Morpho's IRM adapts on elapsed time from this. */
  blockTimestamp: bigint
  blockHash: Address
}

/**
 * What kind of claim a number is. The card renders the class next to the number.
 *   measured     read on-chain at the anchor block
 *   derived      exact arithmetic on measured values (a fee split, a reconstructed rate)
 *   projected    a what-if from measured values: at the user's size, at the kink, along
 *                a rate path, an incentive diluted by the user's deposit. Not a forecast.
 *   reported     from a third-party API (Merkl) and not verified on-chain
 *   curator-set  Membrane's take: a curator declares it; it is not fixed pre-launch
 */
export type LabelClass = 'measured' | 'derived' | 'projected' | 'reported' | 'curator-set'

export type NetApyProtocol = 'aave-v3' | 'spark' | 'morpho-blue' | 'euler-v2'

export interface AssetRef {
  address: Address
  symbol: string
  decimals: number
  /**
   * Sizes arrive in USD. Every venue in the registry lends a USD stablecoin and is
   * priced at $1.00 — an assumption that is stated on every response, never hidden.
   */
  usdPriceAssumption: 1
}

// ------------------------------------------------------------------- IRM params

/** Aave v3.2+ DefaultReserveInterestRateStrategyV2 — params stored per reserve, in bps. */
export interface AaveV2StrategyIrm {
  model: 'aave-rate-strategy-v2'
  strategy: Address
  optimalUsageRatioBps: bigint
  baseVariableBorrowRateBps: bigint
  variableRateSlope1Bps: bigint
  variableRateSlope2Bps: bigint
}

/**
 * SparkLend VariableBorrowInterestRateStrategy (sparklend-advanced). Aave v3.0 layout,
 * no stable leg. Params are ray and read from the strategy's getters AT THE ANCHOR:
 * Spark's rate-target strategies derive slope1 from a live rate source (verified
 * 2026-10-05: getBaseStableBorrowRate() == getVariableRateSlope1() on USDC/USDT/USDS),
 * so they are not constants.
 */
export interface SparkVariableBorrowIrm {
  model: 'spark-variable-borrow'
  strategy: Address
  optimalUsageRatioRay: bigint
  baseVariableBorrowRateRay: bigint
  variableRateSlope1Ray: bigint
  variableRateSlope2Ray: bigint
}

/** Morpho Blue AdaptiveCurveIrm. rateAtTarget is the per-second WAD rate stored at
 *  the market's last update; it keeps adapting with elapsed time. */
export interface MorphoAdaptiveCurveIrm {
  model: 'morpho-adaptive-curve'
  irm: Address
  rateAtTarget: bigint
}

/** Euler v2 IRMLinearKink. Rates are per-second ray (SPY); kink is in uint32 units
 *  of utilization (type(uint32).max = 100%). */
export interface EulerLinearKinkIrm {
  model: 'euler-linear-kink'
  irm: Address
  baseRate: bigint
  slope1: bigint
  slope2: bigint
  kink: bigint
}

export type IrmParams = AaveV2StrategyIrm | SparkVariableBorrowIrm | MorphoAdaptiveCurveIrm | EulerLinearKinkIrm

// ---------------------------------------------------------------- market state

/** Aave v3.1+ (virtual accounting): liquidity is the pool's virtual balance. */
export interface AaveVirtualState {
  kind: 'aave-virtual'
  /** Receipt and debt tokens — incentive campaigns are keyed by these addresses. */
  aToken: Address
  variableDebtToken: Address
  virtualUnderlyingBalance: bigint
  /** variableDebtToken.totalSupply() at the anchor — accrued to the anchor block. */
  totalDebt: bigint
  unbacked: bigint
  reserveFactorBps: bigint
  /** Whole tokens; 0 = no cap (Aave's encoding). */
  supplyCapWhole: bigint
  borrowCapWhole: bigint
  /** aToken.totalSupply() at the anchor, for the supply-cap headroom check. */
  totalSupplied: bigint
  storedLiquidityRateRay: bigint
  storedVariableBorrowRateRay: bigint
  lastUpdateTimestamp: bigint
}

/** SparkLend (Aave v3.0 layout): liquidity is the underlying balance of the aToken. */
export interface SparkState {
  kind: 'spark'
  aToken: Address
  variableDebtToken: Address
  /** IERC20(asset).balanceOf(aToken) at the anchor — what Spark's strategy reads. */
  availableLiquidity: bigint
  /** The strategy reads variable debt only (sparklend-advanced VariableBorrowInterestRateStrategy). */
  totalVariableDebt: bigint
  unbacked: bigint
  reserveFactorBps: bigint
  supplyCapWhole: bigint
  borrowCapWhole: bigint
  totalSupplied: bigint
  storedLiquidityRateRay: bigint
  storedVariableBorrowRateRay: bigint
  lastUpdateTimestamp: bigint
}

export interface MorphoMarketState {
  kind: 'morpho-market'
  marketId: Address
  loanToken: Address
  collateralToken: Address
  oracle: Address
  lltv: bigint
  totalSupplyAssets: bigint
  totalSupplyShares: bigint
  totalBorrowAssets: bigint
  totalBorrowShares: bigint
  lastUpdate: bigint
  /** WAD share of interest kept by the market's fee recipient. */
  fee: bigint
}

export interface EulerVaultState {
  kind: 'euler-vault'
  cash: bigint
  totalBorrows: bigint
  /** CONFIG_SCALE 1e4 share of interest kept by the vault governor. */
  interestFee: bigint
  storedInterestRateSpy: bigint
}

export type MarketState = AaveVirtualState | SparkState | MorphoMarketState | EulerVaultState

// -------------------------------------------------------------------- snapshot

export interface VenueSnapshot {
  venueKey: string
  protocol: NetApyProtocol
  label: string
  anchor: BlockAnchor
  asset: AssetRef
  irm: IrmParams
  state: MarketState
  /** RPC host label, never a URL (keyed URLs carry secrets). */
  rpc: string
}

// ------------------------------------------------------------------ projections

/** A position change, in raw token units of the venue's asset. */
export interface SizeDelta {
  supply: bigint
  borrow: bigint
}

/** Rates as a JS number fraction per year (0.05 = 5%) plus the exact WAD value. */
export interface RatePoint {
  /** Borrow utilization, 0–1. */
  utilization: number
  borrowApr: number
  supplyApr: number
  /** Interest borrowers pay per unit supplied (borrowApr × supply-usage): the venue's
   *  gross yield before its own fee. supplyApr = grossSupplyApr − venueFeeApr. */
  grossSupplyApr: number
  venueFeeApr: number
  /** Exact WAD-per-year values, for consumers that compare across sizes. */
  wad: { utilization: bigint; borrowApr: bigint; supplyApr: bigint; grossSupplyApr: bigint }
}

export interface RatePathPoint {
  /** Seconds after the anchor. */
  t: number
  utilization: number
  borrowApr: number
  supplyApr: number
}
