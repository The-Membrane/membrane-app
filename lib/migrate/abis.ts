/**
 * External ABIs the migrate flow calls. Signatures copied from the deployed sources:
 *   Bundler3 / GeneralAdapter1 / AaveV3MigrationAdapter  morpho-org/bundler3 @ b4014349
 *   Morpho Blue                                          morpho-org/morpho-blue (IMorpho.sol)
 *   ERC-2612                                             EIP-2612 (USDC FiatTokenV2, Aave AToken, MembraneToken)
 * The Membrane adapter ABI is generated: contracts/abis/membraneBundlerAdapter.ts.
 */

import { parseAbi } from 'viem'

export const bundler3Abi = parseAbi([
  'struct Call { address to; bytes data; uint256 value; bool skipRevert; bytes32 callbackHash; }',
  'function multicall(Call[] bundle) payable',
  'function initiator() view returns (address)',
])

export const generalAdapter1Abi = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'function morphoFlashLoan(address token, uint256 assets, bytes data)',
  'function morphoRepay(MarketParams marketParams, uint256 assets, uint256 shares, uint256 maxSharePriceE27, address onBehalf, bytes data)',
  'function morphoWithdrawCollateral(MarketParams marketParams, uint256 assets, address receiver)',
  'function erc20TransferFrom(address token, address receiver, uint256 amount)',
  'function erc20Transfer(address token, address receiver, uint256 amount)',
  'function BUNDLER3() view returns (address)',
  'function MORPHO() view returns (address)',
])

export const aaveV3MigrationAdapterAbi = parseAbi([
  'function aaveV3Repay(address token, uint256 amount, uint256 interestRateMode, address onBehalf)',
  'function aaveV3Withdraw(address token, uint256 amount, address receiver)',
  'function erc20Transfer(address token, address receiver, uint256 amount)',
  'function AAVE_V3_POOL() view returns (address)',
])

export const morphoAbi = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'struct Authorization { address authorizer; address authorized; bool isAuthorized; uint256 nonce; uint256 deadline; }',
  'struct Signature { uint8 v; bytes32 r; bytes32 s; }',
  'function setAuthorizationWithSig(Authorization authorization, Signature signature)',
  'function isAuthorized(address authorizer, address authorized) view returns (bool)',
  'function nonce(address authorizer) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
])

export const permitTokenAbi = parseAbi([
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function nonces(address owner) view returns (uint256)',
  'function name() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

export const cdpOperatorAbi = parseAbi([
  'function setPositionOperator(address operator, bool approved)',
  'function positionOperator(address owner, address operator) view returns (bool)',
  'function assetToken(bytes32 denom) view returns (address)',
  'function transmuterForPeg() view returns (address)',
  'function userPositionIds(address owner, uint256 index) view returns (uint256)',
  'function positionDebt(uint256 positionId) view returns (uint256)',
  'function oracle() view returns (address)',
  'function currentPositionId() view returns (uint256)',
  'struct Fund { bytes32 denom; uint256 amount; }',
  'function deposit(uint256 positionId, address positionOwner, Fund[] funds) returns (uint256)',
  'function increaseDebt(uint256 positionId, bytes32 borrowAsset, uint256 amount)',
])

/** Membrane's oracle surface as Cdp consumes it (Cdp.sol IOracleMin). 1e18 USD per whole token. */
export const membraneOracleAbi = parseAbi([
  'function getPrice(bytes32 asset) view returns (uint256 price, uint256 timestamp)',
])
