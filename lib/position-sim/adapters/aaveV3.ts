/**
 * Aave V3 mainnet — and, through the same factory, Spark (a near-verbatim Aave V3 fork
 * that keeps the PoolAddressesProvider / Pool / PoolDataProvider / Oracle layout).
 *
 * WHY THE ADDRESSES PROVIDER IS THE ONLY HARDCODED ADDRESS:
 * Aave upgrades the Pool, the data provider and the oracle behind the
 * PoolAddressesProvider registry. The provider address itself is immutable and is the
 * documented entry point, so resolving `getPool()` / `getPoolDataProvider()` /
 * `getPriceOracle()` at read time means a protocol upgrade cannot silently point us at
 * a dead contract. Hardcoding the Pool would break on the next upgrade.
 *
 * SCALING CONVENTIONS (all verified against Aave V3 core):
 *   - `getUserAccountData` returns values in the oracle's BASE CURRENCY. On mainnet
 *     that is USD with `BASE_CURRENCY_UNIT` = 1e8. We READ that unit rather than
 *     assuming 8, because Spark and future deployments are free to differ.
 *   - `ltv` and `currentLiquidationThreshold` are basis points (10000 = 100%).
 *   - `healthFactor` is 1e18-scaled, and is `type(uint256).max` when the user has no
 *     debt. We map that to Infinity — printing 1.157e59 would be nonsense.
 *   - interest rates are RAY (1e27) and are already an annualised APR, so the decimal
 *     APR is simply rate / 1e27.
 */

import { getMainnetClient, rpcLabel, toNumber } from '../rpc'
import { stamp, type CollateralLeg, type DebtLeg, type ProtocolId, type ProtocolPosition } from '../types'
import { decimalsFromScale, mc, optional, ratio, unwrap, type Call, type LendingAdapter } from './types'

// ----------------------------------------------------------------------- ABIs

const addressesProviderAbi = [
  { type: 'function', name: 'getPool', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getPoolDataProvider', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getPriceOracle', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

const poolAbi = [
  {
    type: 'function',
    name: 'getUserAccountData',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
] as const

const dataProviderAbi = [
  {
    type: 'function',
    name: 'getAllReservesTokens',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          { name: 'symbol', type: 'string' },
          { name: 'tokenAddress', type: 'address' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getUserReserveData',
    stateMutability: 'view',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'user', type: 'address' },
    ],
    outputs: [
      { name: 'currentATokenBalance', type: 'uint256' },
      { name: 'currentStableDebt', type: 'uint256' },
      { name: 'currentVariableDebt', type: 'uint256' },
      { name: 'principalStableDebt', type: 'uint256' },
      { name: 'scaledVariableDebt', type: 'uint256' },
      { name: 'stableBorrowRate', type: 'uint256' },
      { name: 'liquidityRate', type: 'uint256' },
      { name: 'stableRateLastUpdated', type: 'uint40' },
      { name: 'usageAsCollateralEnabled', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'getReserveConfigurationData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'decimals', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'liquidationThreshold', type: 'uint256' },
      { name: 'liquidationBonus', type: 'uint256' },
      { name: 'reserveFactor', type: 'uint256' },
      { name: 'usageAsCollateralEnabled', type: 'bool' },
      { name: 'borrowingEnabled', type: 'bool' },
      { name: 'stableBorrowRateEnabled', type: 'bool' },
      { name: 'isActive', type: 'bool' },
      { name: 'isFrozen', type: 'bool' },
    ],
  },
  {
    // The VARIABLE borrow rate is a market-level value and lives here, not on
    // getUserReserveData (which only exposes the user's own stable rate).
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'unbacked', type: 'uint256' },
      { name: 'accruedToTreasuryScaled', type: 'uint256' },
      { name: 'totalAToken', type: 'uint256' },
      { name: 'totalStableDebt', type: 'uint256' },
      { name: 'totalVariableDebt', type: 'uint256' },
      { name: 'liquidityRate', type: 'uint256' },
      { name: 'variableBorrowRate', type: 'uint256' },
      { name: 'stableBorrowRate', type: 'uint256' },
      { name: 'averageStableBorrowRate', type: 'uint256' },
      { name: 'liquidityIndex', type: 'uint256' },
      { name: 'variableBorrowIndex', type: 'uint256' },
      { name: 'lastUpdateTimestamp', type: 'uint40' },
    ],
  },
] as const

const oracleAbi = [
  {
    type: 'function',
    name: 'getAssetsPrices',
    stateMutability: 'view',
    inputs: [{ name: 'assets', type: 'address[]' }],
    outputs: [{ type: 'uint256[]' }],
  },
  { type: 'function', name: 'BASE_CURRENCY_UNIT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

// ----------------------------------------------------------------- deployments

/** Aave V3 mainnet PoolAddressesProvider. Immutable registry; everything else is
 *  resolved from it at read time. */
export const AAVE_V3_MAINNET_ADDRESSES_PROVIDER =
  '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e' as const

/** Spark mainnet PoolAddressesProvider. Spark is an Aave V3 fork, so the same reader
 *  works verbatim — only the registry address differs. */
export const SPARK_MAINNET_ADDRESSES_PROVIDER =
  '0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE' as const

/** RAY, 1e27. Aave stores every interest rate at this scale. */
const RAY_DECIMALS = 27
/** healthFactor is WAD-scaled, 1e18. */
const HF_DECIMALS = 18
/** `type(uint256).max` — what Aave returns for healthFactor when totalDebtBase == 0. */
const UINT256_MAX = (1n << 256n) - 1n

// --------------------------------------------------------------- shared reads

interface ResolvedAave {
  pool: `0x${string}`
  dataProvider: `0x${string}`
  oracle: `0x${string}`
}

/** Resolve Pool / PoolDataProvider / AaveOracle from the immutable provider. */
async function resolve(provider: `0x${string}`, label: string): Promise<ResolvedAave> {
  const client = getMainnetClient()
  const calls: Call[] = (['getPool', 'getPoolDataProvider', 'getPriceOracle'] as const).map((fn) => ({
    address: provider,
    abi: addressesProviderAbi,
    functionName: fn,
  }))
  const res = await mc<`0x${string}`>(client, calls)
  const pool = unwrap(res[0], `${label}: PoolAddressesProvider.getPool()`)
  const dataProvider = unwrap(res[1], `${label}: PoolAddressesProvider.getPoolDataProvider()`)
  const oracle = unwrap(res[2], `${label}: PoolAddressesProvider.getPriceOracle()`)
  for (const [name, addr] of [
    ['pool', pool],
    ['data provider', dataProvider],
    ['oracle', oracle],
  ] as const) {
    if (!addr || /^0x0{40}$/i.test(addr)) {
      throw new Error(`${label}: PoolAddressesProvider returned the zero address for the ${name}`)
    }
  }
  return { pool, dataProvider, oracle }
}

/**
 * USD prices from an Aave-family oracle, keyed by lowercased token address.
 *
 * Exported because Morpho Blue's oracles quote collateral in LOAN-TOKEN units, so
 * pricing a non-stablecoin Morpho market in USD needs a real external USD source for
 * the loan token. Reusing Aave's oracle keeps that number READ rather than invented.
 *
 * Tokens Aave does not list come back as 0 and are OMITTED from the result — the
 * caller must treat a missing key as "no price available" and fail loudly.
 */
export async function aaveOracleUsdPrices(
  tokens: `0x${string}`[],
  provider: `0x${string}` = AAVE_V3_MAINNET_ADDRESSES_PROVIDER,
  label = 'aave v3 oracle',
): Promise<Record<string, number>> {
  if (tokens.length === 0) return {}
  const client = getMainnetClient()
  const { oracle } = await resolve(provider, label)
  const res = await mc<bigint[] | bigint>(client, [
    { address: oracle, abi: oracleAbi, functionName: 'getAssetsPrices', args: [tokens] },
    { address: oracle, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT' },
  ])
  const prices = unwrap(res[0], `${label}: AaveOracle.getAssetsPrices()`) as bigint[]
  const baseUnit = unwrap(res[1], `${label}: AaveOracle.BASE_CURRENCY_UNIT()`) as bigint
  const baseDecimals = decimalsFromScale(baseUnit, `${label}: BASE_CURRENCY_UNIT`)
  const out: Record<string, number> = {}
  tokens.forEach((token, i) => {
    const raw = prices[i]
    if (raw === undefined || raw === 0n) return // no source configured — omit, never default
    out[token.toLowerCase()] = toNumber(raw, baseDecimals)
  })
  return out
}

// -------------------------------------------------------------------- adapter

export interface AaveV3AdapterConfig {
  id: ProtocolId
  label: string
  addressesProvider: `0x${string}`
}

/**
 * Builds an Aave-V3-shaped adapter. Spark reuses this unchanged — the fork keeps the
 * same interfaces, so anything that diverges here would be a genuine Spark bug we
 * would rather surface as an error than paper over.
 */
export function createAaveV3Adapter(config: AaveV3AdapterConfig): LendingAdapter {
  return {
    id: config.id,
    label: config.label,
    async read(user: `0x${string}`): Promise<ProtocolPosition[]> {
      const client = getMainnetClient()
      const tag = config.label.toLowerCase()
      const { pool, dataProvider, oracle } = await resolve(config.addressesProvider, tag)

      // --- aggregate + reserve list -------------------------------------------
      const head = await mc<unknown>(client, [
        { address: pool, abi: poolAbi, functionName: 'getUserAccountData', args: [user] },
        { address: dataProvider, abi: dataProviderAbi, functionName: 'getAllReservesTokens' },
        { address: oracle, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT' },
      ])
      const account = unwrap(head[0], `${tag}: Pool.getUserAccountData()`) as readonly bigint[]
      const reserves = unwrap(head[1], `${tag}: PoolDataProvider.getAllReservesTokens()`) as readonly {
        symbol: string
        tokenAddress: `0x${string}`
      }[]
      const baseUnit = unwrap(head[2], `${tag}: AaveOracle.BASE_CURRENCY_UNIT()`) as bigint
      const baseDecimals = decimalsFromScale(baseUnit, `${tag}: BASE_CURRENCY_UNIT`)

      const [totalCollateralBase, totalDebtBase, , liqThresholdBps, , healthFactorRaw] = account
      if (totalCollateralBase === 0n && totalDebtBase === 0n) return []

      // --- per-reserve user balances ------------------------------------------
      const userCalls: Call[] = reserves.map((r) => ({
        address: dataProvider,
        abi: dataProviderAbi,
        functionName: 'getUserReserveData',
        args: [r.tokenAddress, user],
      }))
      const userRes = await mc<readonly unknown[]>(client, userCalls)

      interface Active {
        symbol: string
        token: `0x${string}`
        aTokenBalance: bigint
        stableDebt: bigint
        variableDebt: bigint
        userStableRate: bigint
        collateralEnabled: boolean
      }
      const active: Active[] = []
      reserves.forEach((r, i) => {
        const entry = userRes[i]
        // A single reserve that fails to read is fatal: silently dropping it would
        // under-report the position, which is worse than showing an error.
        const d = unwrap(entry, `${tag}: getUserReserveData(${r.symbol})`)
        const aTokenBalance = d[0] as bigint
        const stableDebt = d[1] as bigint
        const variableDebt = d[2] as bigint
        if (aTokenBalance === 0n && stableDebt === 0n && variableDebt === 0n) return
        active.push({
          symbol: r.symbol,
          token: r.tokenAddress,
          aTokenBalance,
          stableDebt,
          variableDebt,
          userStableRate: d[5] as bigint,
          collateralEnabled: d[8] as boolean,
        })
      })

      if (active.length === 0) {
        // The aggregate says there is value but no reserve carries it. That is a real
        // inconsistency, not an empty wallet — say so rather than returning nothing.
        throw new Error(
          `${tag}: Pool reports ${totalCollateralBase} collateral / ${totalDebtBase} debt (base units) but no reserve holds a balance`,
        )
      }

      // --- config, market rates, prices ---------------------------------------
      const cfgCalls: Call[] = active.map((a) => ({
        address: dataProvider,
        abi: dataProviderAbi,
        functionName: 'getReserveConfigurationData',
        args: [a.token],
      }))
      const rateCalls: Call[] = active.map((a) => ({
        address: dataProvider,
        abi: dataProviderAbi,
        functionName: 'getReserveData',
        args: [a.token],
      }))
      const [cfgRes, rateRes, priceRes] = await Promise.all([
        mc<readonly unknown[]>(client, cfgCalls),
        mc<readonly unknown[]>(client, rateCalls),
        mc<bigint[]>(client, [
          {
            address: oracle,
            abi: oracleAbi,
            functionName: 'getAssetsPrices',
            args: [active.map((a) => a.token)],
          },
        ]),
      ])
      const prices = unwrap(priceRes[0], `${tag}: AaveOracle.getAssetsPrices()`)

      const collateral: CollateralLeg[] = []
      const debt: DebtLeg[] = []

      active.forEach((a, i) => {
        const cfg = unwrap(cfgRes[i], `${tag}: getReserveConfigurationData(${a.symbol})`)
        const decimals = Number(cfg[0] as bigint)
        const maxLtv = Number(cfg[1] as bigint) / 10_000 // bps
        const liqThreshold = Number(cfg[2] as bigint) / 10_000 // bps
        // liquidationBonus is bps-of-par: 10500 = the liquidator receives 105% of the
        // repaid value, i.e. a 5% bonus. Subtract par to get the bonus itself.
        const liqBonus = Math.max(0, Number(cfg[3] as bigint) / 10_000 - 1)
        const priceRaw = prices[i]
        if (priceRaw === undefined || priceRaw === 0n) {
          throw new Error(`${tag}: AaveOracle has no price for ${a.symbol} (${a.token})`)
        }
        const priceUsd = toNumber(priceRaw, baseDecimals)

        if (a.aTokenBalance > 0n && a.collateralEnabled) {
          // Supplied-but-not-collateral balances are intentionally excluded: they do
          // not back the debt, so counting them would overstate the safety margin.
          const amount = toNumber(a.aTokenBalance, decimals)
          collateral.push({
            symbol: a.symbol,
            address: a.token,
            decimals,
            amount,
            priceUsd,
            valueUsd: amount * priceUsd,
            liquidationThreshold: liqThreshold,
            maxLtv,
            liquidationBonus: liqBonus,
          })
        }

        const totalDebtRaw = a.stableDebt + a.variableDebt
        if (totalDebtRaw > 0n) {
          const amount = toNumber(totalDebtRaw, decimals)
          // Rates are RAY (1e27) annualised APRs. A borrower can hold both a stable
          // and a variable tranche in the same reserve, so blend by outstanding
          // principal rather than picking one arbitrarily.
          const market = optional(rateRes[i])
          const variableRate = market ? (market[6] as bigint) : null
          let borrowApr: number | null = null
          if (a.variableDebt > 0n && a.stableDebt > 0n && variableRate !== null) {
            const v = toNumber(variableRate, RAY_DECIMALS)
            const s = toNumber(a.userStableRate, RAY_DECIMALS)
            const vw = toNumber(a.variableDebt, decimals)
            const sw = toNumber(a.stableDebt, decimals)
            borrowApr = (v * vw + s * sw) / (vw + sw)
          } else if (a.variableDebt > 0n && variableRate !== null) {
            borrowApr = toNumber(variableRate, RAY_DECIMALS)
          } else if (a.stableDebt > 0n && a.variableDebt === 0n) {
            borrowApr = toNumber(a.userStableRate, RAY_DECIMALS)
          }
          debt.push({
            symbol: a.symbol,
            address: a.token,
            decimals,
            amount,
            priceUsd,
            valueUsd: amount * priceUsd,
            borrowApr,
          })
        }
      })

      // The AGGREGATE is authoritative for totals: it already applies e-mode, isolation
      // mode and collateral flags exactly as the liquidation logic does. The legs above
      // are the breakdown, not the source of the totals.
      const totalCollateralUsd = toNumber(totalCollateralBase, baseDecimals)
      const totalDebtUsd = toNumber(totalDebtBase, baseDecimals)
      const liquidationLtv = Number(liqThresholdBps) / 10_000
      const healthFactor =
        totalDebtBase === 0n || healthFactorRaw === UINT256_MAX
          ? Number.POSITIVE_INFINITY // no debt: Aave literally returns uint256 max
          : toNumber(healthFactorRaw, HF_DECIMALS)

      return [
        {
          protocol: config.id,
          label: config.label,
          collateral,
          debt,
          totalCollateralUsd,
          totalDebtUsd,
          ltv: ratio(totalDebtUsd, totalCollateralUsd),
          liquidationLtv,
          healthFactor,
          provenance: stamp(
            'onchain',
            `${tag} · ${rpcLabel()}`,
            `Pool ${pool} · data provider ${dataProvider} · oracle ${oracle}, all resolved from PoolAddressesProvider ${config.addressesProvider}. Totals from getUserAccountData in base units (BASE_CURRENCY_UNIT 1e${baseDecimals}); per-asset prices from getAssetsPrices; thresholds in bps.`,
          ),
        },
      ]
    },
  }
}

export const aaveV3Adapter: LendingAdapter = createAaveV3Adapter({
  id: 'aave-v3',
  label: 'Aave V3',
  addressesProvider: AAVE_V3_MAINNET_ADDRESSES_PROVIDER,
})

export const sparkAdapter: LendingAdapter = createAaveV3Adapter({
  id: 'spark',
  label: 'Spark',
  addressesProvider: SPARK_MAINNET_ADDRESSES_PROVIDER,
})
