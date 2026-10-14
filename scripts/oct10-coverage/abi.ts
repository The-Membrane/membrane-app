/** ABIs and encode/decode helpers for the Oct 10 on-chain pull. */
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi, type Hex } from 'viem'

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const
export const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const

export const ADDRESSES = {
  mainnet: {
    provider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
    oracle: '0x54586bE62E3c3580375aE3723C145253060Ca0C2',
    poolPrefix: '0x87870bca',
  },
  arbitrum: {
    provider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
    oracle: '0xb56c2f0b653b2e0b10c9b928c8580ac5df02c7c7',
    poolPrefix: '0x794a6135',
  },
  optimism: {
    provider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
    oracle: '0xd81eb3728a631871a7ebbad631b5f424909f0c77',
    poolPrefix: '0x794a6135',
  },
  base: {
    provider: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',
    oracle: '0x2cc0fc26ed4563a5ce5e8bdcfe1a2878676ae156',
    poolPrefix: '0xa238dd80',
  },
} as const

export const providerAbi = parseAbi([
  'function getPool() view returns (address)',
  'function getPriceOracle() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
])

export const poolAbi = parseAbi([
  'function getReservesList() view returns (address[])',
  'function getUserEMode(address user) view returns (uint256)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getUserConfiguration(address user) view returns ((uint256 data))',
  'function getConfiguration(address asset) view returns ((uint256 data))',
  'function getEModeCategoryCollateralConfig(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus))',
  'function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)',
  'function getEModeCategoryData(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus, address priceSource, string label))',
  'function getEModeCategoryLabel(uint8 id) view returns (string)',
  'function POOL_REVISION() view returns (uint256)',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
])

export const dataProviderAbi = parseAbi([
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
])

export const oracleAbi = parseAbi([
  'function getAssetsPrices(address[] assets) view returns (uint256[])',
  'function getAssetPrice(address asset) view returns (uint256)',
  'function getSourceOfAsset(address asset) view returns (address)',
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
  'function BASE_CURRENCY() view returns (address)',
  'function getFallbackOracle() view returns (address)',
])

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
])
export const erc20Bytes32Abi = parseAbi(['function symbol() view returns (bytes32)'])

export const morphoAbi = parseAbi([
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
])
export const morphoOracleAbi = parseAbi(['function price() view returns (uint256)'])
export const irmAbi = parseAbi([
  'function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)',
])

export const feedAbi = parseAbi([
  'function aggregator() view returns (address)',
  'function phaseId() view returns (uint16)',
  'function phaseAggregators(uint16) view returns (address)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function latestRound() view returns (uint256)',
  'function latestAnswer() view returns (int256)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
])

/** Getters that Aave price adapters expose for the feed(s) they wrap. Probed in order. */
export const adapterAbi = parseAbi([
  'function ASSET_TO_USD_AGGREGATOR() view returns (address)',
  'function BASE_TO_USD_AGGREGATOR() view returns (address)',
  'function ASSET_TO_PEG() view returns (address)',
  'function PEG_TO_BASE() view returns (address)',
  'function RATIO_PROVIDER() view returns (address)',
  'function description() view returns (string)',
  'function DECIMALS() view returns (uint8)',
  'function decimals() view returns (uint8)',
  'function latestAnswer() view returns (int256)',
  'function isCapped() view returns (bool)',
  'function getPriceCap() view returns (int256)',
  'function getMaxRatio() view returns (uint256)',
])

export const multicallAbi = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getCurrentBlockTimestamp() view returns (uint256)',
])

export interface SubCall {
  target: string
  abi: Abi
  fn: string
  args?: readonly unknown[]
}

export function enc(c: SubCall): Hex {
  return encodeFunctionData({
    abi: c.abi,
    functionName: c.fn,
    args: (c.args ?? []) as never[],
  } as never)
}
export function dec<T = unknown>(c: { abi: Abi; fn: string }, data: Hex): T {
  return decodeFunctionResult({ abi: c.abi, functionName: c.fn, data } as never) as T
}

export function encMulticall(calls: SubCall[]): Hex {
  return encodeFunctionData({
    abi: multicallAbi,
    functionName: 'aggregate3',
    args: [calls.map((c) => ({ target: c.target as Hex, allowFailure: true, callData: enc(c) }))],
  })
}

export interface SubResult<T = unknown> {
  ok: boolean
  value?: T
  /** revert data hex when !ok */
  err?: string
  /** raw return data */
  raw: Hex
}
export function decMulticall(calls: SubCall[], data: Hex): SubResult[] {
  const rows = decodeFunctionResult({
    abi: multicallAbi,
    functionName: 'aggregate3',
    data,
  }) as readonly { success: boolean; returnData: Hex }[]
  if (rows.length !== calls.length)
    throw new Error(`multicall length ${rows.length} != ${calls.length}`)
  return rows.map((r, i) => {
    if (!r.success) return { ok: false, err: r.returnData, raw: r.returnData }
    if (r.returnData === '0x') return { ok: false, err: 'empty-return', raw: r.returnData }
    try {
      return { ok: true, value: dec(calls[i], r.returnData), raw: r.returnData }
    } catch (e) {
      return {
        ok: false,
        err: 'decode: ' + String((e as Error).message).slice(0, 80),
        raw: r.returnData,
      }
    }
  })
}

/** Decode a revert payload to a short reason. */
export function revertReason(data?: string): string {
  if (!data || data === '0x') return 'revert (no data)'
  if (data.startsWith('0x08c379a0')) {
    try {
      const len = parseInt(data.slice(10 + 64, 10 + 128), 16)
      const hex = data.slice(10 + 128, 10 + 128 + len * 2)
      return 'Error(' + Buffer.from(hex, 'hex').toString('utf8') + ')'
    } catch {
      return data.slice(0, 74)
    }
  }
  if (data.startsWith('0x4e487b71')) return 'Panic(0x' + data.slice(-2) + ')'
  return 'custom ' + data.slice(0, 10)
}

export const bigStr = (v: unknown) => (typeof v === 'bigint' ? v.toString() : v)
export function jsonBig(v: unknown) {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))
}
