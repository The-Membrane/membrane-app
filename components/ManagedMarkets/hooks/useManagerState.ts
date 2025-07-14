import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export interface AutoCloseParams {
    ltv: string; // Decimal as string
    percent_to_close: string; // Decimal as string 
    send_to?: string; // Optional string
}


export type RateIndex = {
  rate_index: string; // Decimal as string
  last_accrued: number; // u64
};


export type TWAPPoolInfo = {
  /// Pool ID
  pool_id: number,
  /// Base asset denom
  base_asset_denom: string,
  /// Quote asset denom
  quote_asset_denom: string,
}

export type AssetOracleInfo = {
  /** Basket ID */
  basket_id: string; // Uint128 as string
  /** Pyth price feed ID */
  pyth_price_feed_id?: string; // Option<String>
  /** Osmosis pools for OSMO TWAP */
  pools_for_osmo_twap: TWAPPoolInfo[];
  /** Bool to provide $1 static_price if the asset is USD-par */
  is_usd_par: boolean;
  /** LP pool info */
  lp_pool_info?: any; // Option<PoolInfo>
  /** Vault Info (for vault tokens only) */
  vault_info?: any; // Option<VaultTokenInfo>
  /** Asset decimals */
  decimals: number; // u64
};

export type BorrowCap = {
  fixed_cap?: string; // Option<Uint128> as string
  /** Cap borrows based on current liquidatibility thru the oracle pools */
  cap_borrows_by_liquidity: boolean;
};

export type RateKinkParams = {
  rate_mulitplier: string; // Decimal
  kink_starting_point_ratio: string; // Decimal
};

export type RateParams = {
  base_rate: string; // Decimal
  /** If this is undefined, the base rate becomes a fixed rate. */
  rate_kink?: RateKinkParams;
  rate_max: string; // Decimal
};

export type CollateralParams = {
  collateral_asset: string;
  max_borrow_LTV: string; // Decimal
  liquidation_LTV: string; // Decimal
};


export type ManagedConfig = {
  owner: string;
  osmosis_proxy_contract: string;
  global_rate_index: RateIndex;
  /** This includes supplied CDT & CDT accrued from interest to make sure debt suppliers always withdraw their full share. */
  total_debt_tokens: string; // Uint128 as string
  bad_debt: string; // Uint128 as string
  debt_supply_cap?: string; // Option<Uint128>
  debt_supply_vault_token: string;
  /** Junior tranche vault token denom */
  junior_debt_supply_vault_token?: string;
  /** Junior tranche debt information */
  junior_debt_info?: DebtInfo;
  /** Fixed yield target for senior (core) tranche */
  senior_debt_fixed_yield_target?: string; // Decimal as string
  /** Total borrowed across all markets (optional in config) */
  total_borrowed?: string; // Uint128 as string
  /** Set Whitelists to None to disable new capital */
  whitelisted_debt_suppliers?: string[]; // Option<Vec<String>>
  manager_fee: string; // Decimal as string
  
};

export type MarketParams = {
  collateral_params: CollateralParams;
  rate_params: RateParams;
  market_rate_index: RateIndex;
  /** This is the total amount of debt that has been borrowed. */
  total_borrowed: string; // Uint128
  pool_for_oracle_and_liquidations: AssetOracleInfo;
  borrow_fee: string; // Decimal
  /** Set Whitelists to None to disable new capital */
  whitelisted_collateral_suppliers?: string[]; // Option<Vec<String>>
  borrow_cap: BorrowCap;
  /** Max slippage for liquidation swaps. If the swaps fail, liquidations fail.
   * If the swap quality is bad, we get inefficient liquidations & bad debt.
   */
  max_slippage: string; // Decimal
};

export interface MarketConfig {
  owner: string; // Addr is typically a string in CosmWasm
  osmosis_proxy_contract: string;
  global_rate_index: RateIndex;
  /** This includes supplied CDT & CDT accrued from interest to make sure debt suppliers always withdraw their full share. */
  total_debt_tokens: string; // Uint128 →  string
  bad_debt: string; // Uint128 → string
  debt_supply_cap?: string; // Option<Uint128>
  debt_supply_vault_token: string;
  /** Set Whitelists to empty vec to disable new capital */
  whitelisted_debt_suppliers?: string[]; // Option<Vec<String>> → optional string array
  manager_fee: string; // Decimal → string
}

export interface MarketData {
  address: string;
  name: string;
  socials: string[];
  config: MarketConfig,
  params: MarketParams
}

export type LTVRamp = {
  /** The LTV at the end of the ramp */
  end_ltv: string; // Decimal
  /** The time in days until the ramp ends */
  end_time: number; // u64
}

export type DebtInfo = {
  /** Total debt tokens in the tranche */
  total_debt: string; // Uint128 as string
  /** Bad debt inside the tranche */
  bad_debt: string;   // Uint128 as string
};


export type UpdateOverallMarket = {
  pause_actions?: boolean;
  manager_fee?: string;
  whitelisted_debt_suppliers?: string[] | null;
  debt_supply_cap?: string | null;
}

export type UpdateCollateralParams = {
  collateral_denom: string;
  max_borrow_LTV?: string; // Option<Decimal>
  liquidation_LTV?: LTVRamp; // Option<LTVRamp>
  rate_params?: RateParams; // Option<RateParams>
  borrow_fee?: string; // Option<Decimal>
  whitelisted_collateral_suppliers?: string[] | null; // Option<Option<Vec<String>>>
  borrow_cap?: BorrowCap; // Option<BorrowCap>
  max_slippage?: string; // Option<Decimal>
  pool_for_oracle_and_liquidations?: AssetOracleInfo; // Option<AssetOracleInfo>
  per_user_debt_cap?: string | null;
  debt_minimum?: string | null;
}

export type ManagerState = {
  updateOverallMarket?: UpdateOverallMarket
  updateCollateralParams?: UpdateCollateralParams
}

type Store = {
  managerState: ManagerState
  setManagerState: (partialState: Partial<ManagerState>) => void
  reset: () => void
}

const initialState: ManagerState = {
}

// @ts-ignore
const store = (set) => ({
  managerState: initialState,
  setManagerState: (partialState: Partial<ManagerState>) =>
    set(
      (state: Store) => ({ managerState: { ...state.managerState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
  reset: () => set((state: Store) => ({ ...state, managerState: initialState }), false, '@reset'),
})

// Suppress zustand devtools generic type mismatch in TS 5
// @ts-expect-error - Zustand devtools mutator type mismatch
const useManagerState = create<Store>(devtools(store as any, { name: 'managerState' }))

export default useManagerState
