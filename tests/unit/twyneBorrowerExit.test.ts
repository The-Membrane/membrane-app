import { describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, type Address } from 'viem'

import {
  readTwyneBorrowerExit,
  type TwyneBorrowerDeployment,
  type TwyneBorrowerExitClient,
  type TwyneBorrowerExitRequest,
} from '../../lib/carry/twyneBorrowerExit'
import {
  TWYNE_AAVE_POOL,
  TWYNE_PT_ASSET,
  TWYNE_PT_ROUTE,
  TWYNE_PT_WRAPPER,
} from '../../lib/carry/twynePtExit'

const CV = '0x1111111111111111111111111111111111111111' as Address
const BORROWER = '0x2222222222222222222222222222222222222222' as Address
const FACTORY = '0x3333333333333333333333333333333333333333' as Address
const FACTORY_IMPL = '0x4444444444444444444444444444444444444444' as Address
const BEACON = '0x5555555555555555555555555555555555555555' as Address
const CV_IMPL = '0x6666666666666666666666666666666666666666' as Address
const WRAPPER_IMPL = '0x7777777777777777777777777777777777777777' as Address
const INTERMEDIATE = '0x8888888888888888888888888888888888888888' as Address
const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3' as Address
const ATOKEN = '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545' as Address
const BLOCK_HASH = `0x${'a'.repeat(64)}` as const
const BLOCK = { number: 10n, hash: BLOCK_HASH, timestamp: 1_790_000_000n }
const CODE = '0x6000'
const CODE_HASH = keccak256(CODE)
const ABI = parseAbi(['function redeemUnderlying(uint256,address) returns (uint256)'])
const deployment: TwyneBorrowerDeployment = {
  factory: FACTORY,
  factoryProxyCodeHash: CODE_HASH,
  factoryImplementation: FACTORY_IMPL,
  factoryImplementationCodeHash: CODE_HASH,
  collateralVaultProxyCodeHash: CODE_HASH,
  beacon: BEACON,
  beaconCodeHash: CODE_HASH,
  collateralVaultImplementation: CV_IMPL,
  collateralVaultImplementationCodeHash: CODE_HASH,
  wrapperProxyCodeHash: CODE_HASH,
  wrapperImplementation: WRAPPER_IMPL,
  wrapperImplementationCodeHash: CODE_HASH,
}
const request: TwyneBorrowerExitRequest = {
  routeKey: TWYNE_PT_ROUTE,
  collateralVault: CV,
  requestedPtRaw: '100',
}
const slot = (address: Address) => `0x${address.slice(2).padStart(64, '0')}` as const

function fixture(
  options: {
    registered?: boolean
    asset?: Address
    borrower?: Address
    maxRelease?: bigint
    total?: bigint
    wrapperBalance?: bigint
    intermediateDebt?: bigint
    shares?: bigint
    returned?: bigint
    revert?: boolean
    version?: bigint
    code?: string
    blockMismatch?: boolean
  } = {},
) {
  const reads: Array<{
    address: Address
    functionName: string
    args?: readonly unknown[]
    blockHash?: string
  }> = []
  const calls: Array<{ to: Address; account: Address; blockHash?: string; data: string }> = []
  const getCode: Array<{ address: Address; blockHash?: string }> = []
  const getStorageAt: Array<{ address: Address; blockHash?: string }> = []
  const client = {
    getChainId: async () => 1,
    getBlock: async (args: { blockTag?: string }) =>
      args.blockTag === 'finalized'
        ? BLOCK
        : { ...BLOCK, hash: options.blockMismatch ? `0x${'b'.repeat(64)}` : BLOCK_HASH },
    getCode: async (args: { address: Address; blockHash?: string }) => {
      getCode.push(args)
      return options.code ?? CODE
    },
    getStorageAt: async (args: { address: Address; blockHash?: string }) => {
      getStorageAt.push(args)
      if (args.address.toLowerCase() === CV.toLowerCase()) return slot(BEACON)
      if (args.address.toLowerCase() === FACTORY.toLowerCase()) return slot(FACTORY_IMPL)
      if (args.address.toLowerCase() === TWYNE_PT_WRAPPER.toLowerCase()) return slot(WRAPPER_IMPL)
      throw new Error('unexpected storage target')
    },
    readContract: async (args: {
      address: Address
      functionName: string
      args?: readonly unknown[]
      blockHash?: string
    }) => {
      reads.push(args)
      const values: Record<string, unknown> = {
        collateralVaultFactory: FACTORY,
        isCollateralVault: options.registered ?? true,
        collateralVaultBeacon: BEACON,
        implementation: CV_IMPL,
        asset: options.asset ?? TWYNE_PT_WRAPPER,
        targetAsset: USDE,
        targetVault: TWYNE_AAVE_POOL,
        underlyingAsset: TWYNE_PT_ASSET,
        aToken: ATOKEN,
        intermediateVault: INTERMEDIATE,
        borrower: options.borrower ?? BORROWER,
        maxRelease: options.maxRelease ?? 20n,
        totalAssetsDepositedOrReserved: options.total ?? 200n,
        balanceOf: options.wrapperBalance ?? 200n,
        debtOf: options.intermediateDebt ?? 20n,
        maxRepay: 10n,
        previewWithdraw: options.shares ?? 100n,
        isExternallyLiquidated: false,
      }
      if (args.functionName === 'version')
        return args.address === FACTORY ? 5n : (options.version ?? 3n)
      if (!(args.functionName in values)) throw new Error(`unknown read ${args.functionName}`)
      return values[args.functionName]
    },
    call: async (args: { to: Address; account: Address; data: string; blockHash?: string }) => {
      calls.push(args)
      if (options.revert) throw new Error('execution reverted')
      return {
        data: encodeFunctionResult({
          abi: ABI,
          functionName: 'redeemUnderlying',
          result: options.returned ?? 100n,
        }),
      }
    },
  } as unknown as TwyneBorrowerExitClient
  return { client, reads, calls, getCode, getStorageAt }
}

const now = (Number(BLOCK.timestamp) + 60) * 1000

describe('Twyne borrower PT first-leg assay', () => {
  it('rejects wrong chain and mismatched finalized identity before contract reads', async () => {
    const { client, reads } = fixture({ blockMismatch: true })
    await expect(readTwyneBorrowerExit(client, request, deployment, now)).rejects.toThrow(
      'twyne_borrower_exit_block_changed',
    )
    expect(reads).toHaveLength(0)
    await expect(
      readTwyneBorrowerExit(
        { ...client, getChainId: async () => 8453 } as TwyneBorrowerExitClient,
        request,
        deployment,
        now,
      ),
    ).rejects.toThrow('twyne_borrower_exit_chain_mismatch')
  })

  it('requires attested deployed code and current version before borrower simulation', async () => {
    const changedCode = fixture({ code: '0x6001' })
    const changed = await readTwyneBorrowerExit(changedCode.client, request, deployment, now)
    expect(changed).toMatchObject({ status: 'unsupported', reason: 'deployment_unattested' })
    expect(changedCode.calls).toHaveLength(0)
    const changedVersion = fixture({ version: 2n })
    const version = await readTwyneBorrowerExit(changedVersion.client, request, deployment, now)
    expect(version).toMatchObject({ status: 'unsupported', reason: 'source_unattested' })
    expect(changedVersion.calls).toHaveLength(0)
  })

  it('rejects an unregistered or wrong-route collateral vault', async () => {
    const unregistered = fixture({ registered: false })
    expect(
      await readTwyneBorrowerExit(unregistered.client, request, deployment, now),
    ).toMatchObject({
      status: 'unsupported',
      reason: 'factory_unregistered',
    })
    const wrongAsset = fixture({ asset: TWYNE_PT_ASSET })
    expect(await readTwyneBorrowerExit(wrongAsset.client, request, deployment, now)).toMatchObject({
      status: 'unsupported',
      reason: 'identity_changed',
    })
    expect(unregistered.calls).toHaveLength(0)
    expect(wrongAsset.calls).toHaveLength(0)
  })

  it('separates reserved credit and position insufficiency from EVM revert', async () => {
    const credit = fixture({ maxRelease: 150n, intermediateDebt: 150n })
    expect(await readTwyneBorrowerExit(credit.client, request, deployment, now)).toMatchObject({
      status: 'restricted',
      reason: 'credit_reserved',
    })
    const position = fixture({ wrapperBalance: 90n })
    expect(await readTwyneBorrowerExit(position.client, request, deployment, now)).toMatchObject({
      status: 'restricted',
      reason: 'position_insufficient',
    })
    const evc = fixture({ revert: true })
    expect(await readTwyneBorrowerExit(evc.client, request, deployment, now)).toMatchObject({
      status: 'restricted',
      reason: 'evm_revert',
    })
    expect(credit.calls).toHaveLength(0)
    expect(position.calls).toHaveLength(0)
    expect(evc.calls).toHaveLength(1)
  })

  it('reports under-delivery; successful call is only a simulated PT first leg', async () => {
    const short = fixture({ returned: 99n })
    expect(await readTwyneBorrowerExit(short.client, request, deployment, now)).toMatchObject({
      status: 'restricted',
      reason: 'under_delivery',
      evidence: { returnedPtRaw: '99' },
    })
    const success = fixture({ returned: 100n })
    const result = await readTwyneBorrowerExit(success.client, request, deployment, now)
    expect(result).toMatchObject({
      status: 'observed',
      borrower: BORROWER,
      evidence: {
        source: 'ethereum_finalized_eip1898_eth_call',
        borrowerKeyControl: 'unassessed',
        finalUsdePayout: 'unassessed',
        receiver: 'borrower',
        previewSharesRaw: '100',
        returnedPtRaw: '100',
      },
    })
    expect(success.calls[0]).toMatchObject({ to: CV, account: BORROWER, blockHash: BLOCK_HASH })
    expect(decodeFunctionData({ abi: ABI, data: success.calls[0].data as `0x${string}` })).toEqual({
      functionName: 'redeemUnderlying',
      args: [100n, BORROWER],
    })
    expect(
      [...success.reads, ...success.getCode, ...success.getStorageAt].every(
        (read) => read.blockHash === BLOCK_HASH,
      ),
    ).toBe(true)
  })

  it('retains contract-borrower control caveat even when eth_call succeeds', async () => {
    const contractBorrower = fixture({ borrower: CV })
    const result = await readTwyneBorrowerExit(contractBorrower.client, request, deployment, now)
    expect(result.status).toBe('observed')
    expect(result.evidence.borrowerKeyControl).toBe('unassessed')
    expect(result.evidence.finalUsdePayout).toBe('unassessed')
  })
})
