import { Route, StatCard, Tier, Venue, VenueKey } from './types'

/**
 * Illustrative market constants ported from public/proto/landing.html.
 * Figures illustrative — Bitcoin at $95,000, borrow rate 3%. Not live data.
 */
export const BTC_PX = 95000
export const BORROW_RATE = 0.03
export const MAX_LTV = 0.73

/**
 * Venue mixes. `liquid` / `cooled` = share of the deployed loan the liquidation
 * engine can actually recall, normally and with a cooldown-bearing venue locked.
 * Higher-yield mixes hold more in venues that go illiquid exactly when needed.
 */
export const VENUES: Record<VenueKey, Venue> = {
  steady: { nm: 'Steady', mix: 'steady', apr: 0.042, liquid: 0.97, cooled: 0.97, note: 'deepest venues, closest to free to exit' },
  bal: { nm: 'Balanced', mix: 'balanced', apr: 0.079, liquid: 0.88, cooled: 0.63, note: 'a spread of venues' },
  hot: { nm: 'Higher', mix: 'higher-yield', apr: 0.118, liquid: 0.74, cooled: 0.32, note: 'thinner books; costs more to get out of' },
}

/** Ordered venue segment buttons. */
export const VENUE_ORDER: VenueKey[] = ['steady', 'bal', 'hot']

/** Default hero state. */
export const DEFAULT_STATE = { btc: 1, ltv: 0.42, venue: 'bal' as VenueKey }

/** Real measured carry routes; provenance stated in the section copy. */
export const ROUTES: Route[] = [
  { nm: 'AUSD → Staked USDat', pos: 15, net: 11.53 },
  { nm: 'apxUSD → ApyUSD', pos: 19, net: 9.01 },
  { nm: 'USDT → Fluid [USDC]', pos: 15, net: 3.91 },
  { nm: 'USDC → VaultV2 [USDC]', pos: 182, net: 3.44, big: true },
  { nm: 'USDS → StUsds', pos: 21, net: 2.59 },
  { nm: 'PYUSD → StakingVault', pos: 26, net: 1.98 },
  { nm: 'USDe → Staked USDe', pos: 25, net: 0.62 },
  { nm: 'USDC → USD3', pos: 78, net: 0.22 },
  { nm: 'RLUSD → VaultV2', pos: 37, net: -0.36 },
  { nm: 'USDC → supply on Compound', pos: 20, net: -0.78 },
  { nm: 'PYUSD → VaultV2 [PYUSD]', pos: 54, net: -2.43 },
  { nm: 'GHO → UmbrellaStakeToken', pos: 21, net: -3.75 },
]

/** Route-section summary stat cards. */
export const ROUTE_STATS: StatCard[] = [
  { k: 'Routes positive', v: '17', n: '580 positions', tone: 'success' },
  { k: 'Routes negative', v: '8', n: '239 positions, right now', tone: 'danger' },
  { k: 'Median net carry', v: '+0.60%', n: 'weighted mean +1.31%' },
  { k: 'Already closed', v: '~50%', n: 'of carry positions opened' },
]

/** Risk-desk tiers — the scanner's threshold ritual. */
export const TIERS: Tier[] = [
  { nm: 'Borrow against your bitcoin', st: 'open', always: true },
  { nm: 'Read a curator’s doctrine', st: 'sealed' },
  { nm: 'Size across several curators', st: 'sealed' },
  { nm: 'Set parameters yourself', st: 'sealed' },
]

/** Diverging bar scale for the routes viz. */
export const ROUTE_BAR_MAX = 12
export const ROUTE_BAR_ZERO = 50
