import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import { TWYNE_AAVE_POOL, TWYNE_PT_ASSET, TWYNE_PT_ROUTE, TWYNE_PT_WRAPPER } from './twynePtExit'

const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3' as Address
const PT_ATOKEN = '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545' as Address
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' as const
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const RAW = /^[1-9][0-9]{0,77}$/
const MAX_U256 = (1n << 256n) - 1n
const abi = parseAbi([
  'function collateralVaultFactory() view returns (address)',
  'function isCollateralVault(address) view returns (bool)',
  'function collateralVaultBeacon(address) view returns (address)',
  'function implementation() view returns (address)',
  'function version() view returns (uint256)',
  'function asset() view returns (address)',
  'function targetAsset() view returns (address)',
  'function targetVault() view returns (address)',
  'function underlyingAsset() view returns (address)',
  'function aToken() view returns (address)',
  'function intermediateVault() view returns (address)',
  'function borrower() view returns (address)',
  'function maxRelease() view returns (uint256)',
  'function maxRepay() view returns (uint256)',
  'function totalAssetsDepositedOrReserved() view returns (uint256)',
  'function isExternallyLiquidated() view returns (bool)',
  'function debtOf(address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function redeemUnderlying(uint256,address) returns (uint256)',
])

export type TwyneBorrowerExitClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'getCode' | 'getStorageAt' | 'readContract' | 'call'
>

/** Must come from an independently reviewed, trusted deployment record, never from request JSON. */
export type TwyneBorrowerDeployment = {
  factory: Address
  factoryProxyCodeHash: `0x${string}`
  factoryImplementation: Address
  factoryImplementationCodeHash: `0x${string}`
  collateralVaultProxyCodeHash: `0x${string}`
  beacon: Address
  beaconCodeHash: `0x${string}`
  collateralVaultImplementation: Address
  collateralVaultImplementationCodeHash: `0x${string}`
  wrapperProxyCodeHash: `0x${string}`
  wrapperImplementation: Address
  wrapperImplementationCodeHash: `0x${string}`
}

/** Ethereum mainnet identity pinned from finalized block 26098984; checked again on every read. */
export const TWYNE_PT_BORROWER_DEPLOYMENT: TwyneBorrowerDeployment = {
  factory: '0xa1517cce0be75700a8838ea1cee0dc383cd3a332',
  factoryProxyCodeHash: '0xb38ff55e7123278c076a91f680988f081e60f4c6921dd83429e3643140b06f23',
  factoryImplementation: '0x70879b4f43a5ae639173fa4e3546f4775f0e4383',
  factoryImplementationCodeHash:
    '0x0ca96c62eb63c6c71822ac1034e9af88f0e9e2b446357f47cbc28cb54395f7d2',
  collateralVaultProxyCodeHash:
    '0xcf61546a9073878187323699a802f646bf71057b5ca2c39acf7e93db553d6d50',
  beacon: '0x07AcB5854090216585C28F5a230F1bB57E73D085',
  beaconCodeHash: '0xa12bf73eabc7d322497f1a68de61fb5514f8ec461dc66193664949c5d087f87b',
  collateralVaultImplementation: '0x5A443A2D9Ae21B5c4e7dE8CFc09A0E7DaD3dDa90',
  collateralVaultImplementationCodeHash:
    '0xc95a12aa4199465006e97a15e50e80542a6f87e1bc020cfe2be36ccb92d3299a',
  wrapperProxyCodeHash: '0x815c4d3d433b86ca34f214b94aafd3660ed5cd228f0205cc77600da6679f0a11',
  wrapperImplementation: '0x41695d3304e38bc806f077a3541c5cd34f8f034b',
  wrapperImplementationCodeHash:
    '0xe3dca07a6a6730d4a8d90ed26b440937c3cbe51ca0f1e8a3f90c73e4cf2f8c62',
}

export type TwyneBorrowerExitRequest = {
  routeKey: typeof TWYNE_PT_ROUTE
  collateralVault: Address
  requestedPtRaw: string
}

type Reason =
  | 'deployment_unattested'
  | 'source_unattested'
  | 'identity_changed'
  | 'factory_unregistered'
  | 'credit_reserved'
  | 'position_insufficient'
  | 'externally_liquidated'
  | 'evm_revert'
  | 'under_delivery'

export type TwyneBorrowerExitResult = {
  status: 'observed' | 'unsupported' | 'restricted'
  reason?: Reason
  routeKey: typeof TWYNE_PT_ROUTE
  collateralVault: Address
  borrower: Address | null
  requestedPtRaw: string
  evidence: {
    chainId: 1
    blockNumber: number
    blockHash: `0x${string}`
    blockTimestamp: number
    factory: Address | null
    beacon: Address | null
    collateralVaultImplementation: Address | null
    collateralVaultVersion: string | null
    factoryVersion: string | null
    asset: Address | null
    targetAsset: Address | null
    targetVault: Address | null
    intermediateVault: Address | null
    aToken: Address | null
    maxReleaseRaw: string | null
    totalAssetsDepositedOrReservedRaw: string | null
    wrapperBalanceRaw: string | null
    intermediateDebtRaw: string | null
    maxRepayRaw: string | null
    previewSharesRaw: string | null
    returnedPtRaw: string | null
    source: 'ethereum_finalized_eip1898_eth_call'
    firstLeg: 'twyne_cv_redeem_underlying_pt'
    receiver: 'borrower'
    borrowerKeyControl: 'unassessed'
    finalUsdePayout: 'unassessed'
    deploymentSourceEquivalence: 'unassessed'
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const nonzeroAddress = (value: unknown): value is Address =>
  typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/i.test(value)
const slotAddress = (value: unknown): Address | null =>
  typeof value === 'string' && HASH.test(value) && !/^0x0{64}$/i.test(value)
    ? (`0x${value.slice(-40)}`.toLowerCase() as Address)
    : null
const validHash = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && HASH.test(value)
const validUint = (value: unknown): value is bigint =>
  typeof value === 'bigint' && value >= 0n && value <= MAX_U256

function isRevert(error: unknown): boolean {
  const e = error as { name?: string; shortMessage?: string; message?: string }
  const message = `${e?.shortMessage ?? ''} ${e?.message ?? ''}`.toLowerCase()
  if (/timeout|http request|network|gas limit|out of gas|rate limit/.test(message)) return false
  return (
    e?.name === 'ContractFunctionRevertedError' || /execution reverted|reverted with/.test(message)
  )
}

/** Read-only borrower-authorized PT first leg. This is neither key control nor final USDe delivery. */
export async function readTwyneBorrowerExit(
  client: TwyneBorrowerExitClient,
  request: TwyneBorrowerExitRequest,
  deployment: TwyneBorrowerDeployment,
  nowMs = Date.now(),
): Promise<TwyneBorrowerExitResult> {
  if (
    request.routeKey !== TWYNE_PT_ROUTE ||
    !nonzeroAddress(request.collateralVault) ||
    !RAW.test(request.requestedPtRaw) ||
    BigInt(request.requestedPtRaw) > MAX_U256
  )
    throw new Error('twyne_borrower_exit_request_invalid')
  if (
    !deployment ||
    ![
      deployment.factory,
      deployment.factoryImplementation,
      deployment.beacon,
      deployment.collateralVaultImplementation,
      deployment.wrapperImplementation,
    ].every(nonzeroAddress) ||
    ![
      deployment.factoryProxyCodeHash,
      deployment.factoryImplementationCodeHash,
      deployment.collateralVaultProxyCodeHash,
      deployment.beaconCodeHash,
      deployment.collateralVaultImplementationCodeHash,
      deployment.wrapperProxyCodeHash,
      deployment.wrapperImplementationCodeHash,
    ].every(validHash)
  )
    throw new Error('twyne_borrower_deployment_identity_missing')
  if ((await client.getChainId()) !== 1) throw new Error('twyne_borrower_exit_chain_mismatch')
  const block = await client.getBlock({ blockTag: 'finalized' })
  const blockTimestamp = Number(block.timestamp)
  if (
    typeof block.number !== 'bigint' ||
    block.number < 0n ||
    block.number > BigInt(Number.MAX_SAFE_INTEGER) ||
    !validHash(block.hash) ||
    !Number.isSafeInteger(blockTimestamp) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs - blockTimestamp * 1000 < -120_000 ||
    nowMs - blockTimestamp * 1000 > 7_200_000
  )
    throw new Error('twyne_borrower_exit_finalized_block_unavailable')
  const confirmation = await client.getBlock({ blockNumber: block.number })
  if (confirmation.number !== block.number || !same(confirmation.hash ?? '', block.hash!))
    throw new Error('twyne_borrower_exit_block_changed')
  const pinned = { blockHash: block.hash!, requireCanonical: true as const }
  const evidence: TwyneBorrowerExitResult['evidence'] = {
    chainId: 1,
    blockNumber: Number(block.number),
    blockHash: block.hash!,
    blockTimestamp,
    factory: null,
    beacon: null,
    collateralVaultImplementation: null,
    collateralVaultVersion: null,
    factoryVersion: null,
    asset: null,
    targetAsset: null,
    targetVault: null,
    intermediateVault: null,
    aToken: null,
    maxReleaseRaw: null,
    totalAssetsDepositedOrReservedRaw: null,
    wrapperBalanceRaw: null,
    intermediateDebtRaw: null,
    maxRepayRaw: null,
    previewSharesRaw: null,
    returnedPtRaw: null,
    source: 'ethereum_finalized_eip1898_eth_call',
    firstLeg: 'twyne_cv_redeem_underlying_pt',
    receiver: 'borrower',
    borrowerKeyControl: 'unassessed',
    finalUsdePayout: 'unassessed',
    deploymentSourceEquivalence: 'unassessed',
  }
  const base = {
    routeKey: TWYNE_PT_ROUTE,
    collateralVault: request.collateralVault,
    borrower: null,
    requestedPtRaw: request.requestedPtRaw,
    evidence,
  } as const
  const codeTargets = [
    [request.collateralVault, deployment.collateralVaultProxyCodeHash],
    [deployment.factory, deployment.factoryProxyCodeHash],
    [deployment.factoryImplementation, deployment.factoryImplementationCodeHash],
    [deployment.beacon, deployment.beaconCodeHash],
    [deployment.collateralVaultImplementation, deployment.collateralVaultImplementationCodeHash],
    [TWYNE_PT_WRAPPER, deployment.wrapperProxyCodeHash],
    [deployment.wrapperImplementation, deployment.wrapperImplementationCodeHash],
  ] as const
  const [cvBeaconSlot, factoryImplementationSlot, wrapperImplementationSlot, ...codes] =
    await Promise.all([
      client.getStorageAt({ address: request.collateralVault, slot: BEACON_SLOT, ...pinned }),
      client.getStorageAt({ address: deployment.factory, slot: IMPLEMENTATION_SLOT, ...pinned }),
      client.getStorageAt({ address: TWYNE_PT_WRAPPER, slot: IMPLEMENTATION_SLOT, ...pinned }),
      ...codeTargets.map(([address]) => client.getCode({ address, ...pinned })),
    ])
  evidence.beacon = slotAddress(cvBeaconSlot)
  evidence.collateralVaultImplementation = deployment.collateralVaultImplementation
  if (
    !same(evidence.beacon ?? '', deployment.beacon) ||
    !same(slotAddress(factoryImplementationSlot) ?? '', deployment.factoryImplementation) ||
    !same(slotAddress(wrapperImplementationSlot) ?? '', deployment.wrapperImplementation) ||
    codes.some((code, i) => !code || same(code, '0x') || !same(keccak256(code), codeTargets[i][1]))
  )
    return { ...base, status: 'unsupported', reason: 'deployment_unattested' }

  const read = <T extends string>(address: Address, functionName: T, args?: readonly unknown[]) =>
    client.readContract({
      address,
      abi,
      functionName,
      ...(args ? { args } : {}),
      ...pinned,
    } as never)
  const [
    factory,
    registered,
    beacon,
    implementation,
    cvVersion,
    factoryVersion,
    asset,
    targetAsset,
    targetVault,
    underlyingAsset,
    aToken,
    intermediateVault,
    borrower,
  ] = await Promise.all([
    read(request.collateralVault, 'collateralVaultFactory'),
    read(deployment.factory, 'isCollateralVault', [request.collateralVault]),
    read(deployment.factory, 'collateralVaultBeacon', [TWYNE_AAVE_POOL]),
    read(deployment.beacon, 'implementation'),
    read(request.collateralVault, 'version'),
    read(deployment.factory, 'version'),
    read(request.collateralVault, 'asset'),
    read(request.collateralVault, 'targetAsset'),
    read(request.collateralVault, 'targetVault'),
    read(request.collateralVault, 'underlyingAsset'),
    read(request.collateralVault, 'aToken'),
    read(request.collateralVault, 'intermediateVault'),
    read(request.collateralVault, 'borrower'),
  ])
  evidence.factory = factory as Address
  evidence.asset = asset as Address
  evidence.targetAsset = targetAsset as Address
  evidence.targetVault = targetVault as Address
  evidence.intermediateVault = intermediateVault as Address
  evidence.aToken = aToken as Address
  evidence.collateralVaultVersion = validUint(cvVersion) ? cvVersion.toString() : null
  evidence.factoryVersion = validUint(factoryVersion) ? factoryVersion.toString() : null
  if (registered !== true) return { ...base, status: 'unsupported', reason: 'factory_unregistered' }
  // The deployed v3 implementation is Etherscan exact-match verified: inherited
  // redeemUnderlying burns wrapper shares and sends PT to the borrower receiver.
  // The factory source bundled with that verification reports version 5.
  if (cvVersion !== 3n || factoryVersion !== 5n)
    return { ...base, status: 'unsupported', reason: 'source_unattested' }
  if (
    !same(factory as string, deployment.factory) ||
    !same(beacon as string, deployment.beacon) ||
    !same(implementation as string, deployment.collateralVaultImplementation) ||
    !same(asset as string, TWYNE_PT_WRAPPER) ||
    !same(targetAsset as string, USDE) ||
    !same(targetVault as string, TWYNE_AAVE_POOL) ||
    !same(underlyingAsset as string, TWYNE_PT_ASSET) ||
    !same(aToken as string, PT_ATOKEN) ||
    !nonzeroAddress(intermediateVault) ||
    !nonzeroAddress(borrower)
  )
    return { ...base, status: 'unsupported', reason: 'identity_changed' }
  const borrowerBase = { ...base, borrower }
  const q = BigInt(request.requestedPtRaw)
  const [
    maxRelease,
    total,
    wrapperBalance,
    intermediateDebt,
    maxRepay,
    shares,
    externalLiquidated,
  ] = await Promise.all([
    read(request.collateralVault, 'maxRelease'),
    read(request.collateralVault, 'totalAssetsDepositedOrReserved'),
    read(TWYNE_PT_WRAPPER, 'balanceOf', [request.collateralVault]),
    read(intermediateVault, 'debtOf', [request.collateralVault]),
    read(request.collateralVault, 'maxRepay'),
    read(TWYNE_PT_WRAPPER, 'previewWithdraw', [q]),
    read(request.collateralVault, 'isExternallyLiquidated'),
  ])
  if (
    !validUint(maxRelease) ||
    !validUint(total) ||
    !validUint(wrapperBalance) ||
    !validUint(intermediateDebt) ||
    !validUint(maxRepay) ||
    !validUint(shares) ||
    typeof externalLiquidated !== 'boolean' ||
    shares === 0n ||
    maxRelease > total ||
    maxRelease !== (intermediateDebt < total ? intermediateDebt : total)
  )
    return { ...borrowerBase, status: 'unsupported', reason: 'identity_changed' }
  evidence.maxReleaseRaw = maxRelease.toString()
  evidence.totalAssetsDepositedOrReservedRaw = total.toString()
  evidence.wrapperBalanceRaw = wrapperBalance.toString()
  evidence.intermediateDebtRaw = intermediateDebt.toString()
  evidence.maxRepayRaw = maxRepay.toString()
  evidence.previewSharesRaw = shares.toString()
  if (externalLiquidated)
    return { ...borrowerBase, status: 'restricted', reason: 'externally_liquidated' }
  if (shares > wrapperBalance)
    return { ...borrowerBase, status: 'restricted', reason: 'position_insufficient' }
  if (shares > total - maxRelease)
    return { ...borrowerBase, status: 'restricted', reason: 'credit_reserved' }

  const data = encodeFunctionData({
    abi,
    functionName: 'redeemUnderlying',
    args: [shares, borrower],
  })
  try {
    const call = await client.call({
      to: request.collateralVault,
      data,
      account: borrower,
      ...pinned,
    })
    if (!call.data) throw new Error('twyne_borrower_exit_empty_simulation')
    const returned = decodeFunctionResult({
      abi,
      functionName: 'redeemUnderlying',
      data: call.data,
    })
    if (!validUint(returned)) throw new Error('twyne_borrower_exit_bad_simulation')
    evidence.returnedPtRaw = returned.toString()
    return returned >= q
      ? { ...borrowerBase, status: 'observed' }
      : { ...borrowerBase, status: 'restricted', reason: 'under_delivery' }
  } catch (error) {
    if (!isRevert(error)) throw error
    return { ...borrowerBase, status: 'restricted', reason: 'evm_revert' }
  }
}
