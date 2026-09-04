import { useQuery } from '@tanstack/react-query'
import { cdpAbi } from '@/contracts/abis/cdp'
import { assetKey } from '@/services/chain/liquidation'
import { buildApproveIfNeeded } from '@/services/chain/allowance'
import { getContractAddress, type Address } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import { useUserPositions } from '@/hooks/useCDP'
import { useAssetBySymbol } from '@/hooks/useAssets'

interface UseDepositTransactionProps {
    asset: {
        symbol: string
        denom: string
        decimal?: number
    }
    depositAmount: number
    positionIndex?: number
    enabled?: boolean
    onSuccess?: () => void
    /** Rendered consequence for the success toast (see positionDelta.ts). */
    successMessage?: string
}

/**
 * Deposit collateral CTA — EVM port. Migration counterpart: CosmWasm `deposit` with the
 * collateral attached as message funds. On EVM collateral is an ERC-20 pull, so this builds
 * a 2-step EvmCall[]: erc20.approve(cdp, amount) + cdp.deposit(positionId, owner, funds[])
 * (contracts/abis/cdp.ts). NOT atomic — two wallet signatures (services/chain/types.ts).
 *
 * TODO(evm-migration): the CosmWasm deposit carried affiliate_address / affiliate_label; the
 * EVM deposit(id, owner, funds[]) entrypoint has no affiliate params (affiliates are set via
 * cdp.setAffiliate separately), so affiliate tagging is dropped here.
 */
export const useDepositTransaction = ({
    asset,
    depositAmount,
    positionIndex = 0,
    enabled = true,
    onSuccess,
    successMessage,
}: UseDepositTransactionProps) => {
    const { address, chain, publicClient } = useWallet()
    const { data: positions } = useUserPositions()
    const collateralAsset = useAssetBySymbol(asset.symbol)

    const cdpAddr = chain ? getContractAddress(chain.id, 'cdp') : undefined
    // positionIndex points into the user's positions; past the end ⇒ new position (id 0).
    const positionId =
        positions && positions.length > positionIndex ? positions[positionIndex].positionId : 0n

    const { data: msgs } = useQuery<EvmCall[] | undefined>({
        queryKey: [
            'deposit_transaction',
            'evm',
            address ?? '',
            cdpAddr ?? '',
            asset.symbol,
            String(depositAmount),
            positionId.toString(),
        ],
        staleTime: 1000 * 60 * 5,
        queryFn: async () => {
            if (!address || !cdpAddr || !depositAmount || depositAmount <= 0 || !enabled) return undefined

            const decimals = asset.decimal ?? collateralAsset?.decimal ?? 18
            const amount = BigInt(shiftDigits(depositAmount, decimals).dp(0).toString())
            // token = ERC-20 address (Asset.base on EVM); denom = bytes32 asset key.
            const token = (collateralAsset?.base ?? asset.denom) as Address
            const funds = [{ denom: assetKey(asset.symbol), amount }]

            // Approve gated on the standing allowance (services/chain/allowance.ts).
            return [
                ...(await buildApproveIfNeeded(publicClient ?? null, {
                    token,
                    owner: address as Address,
                    spender: cdpAddr as Address,
                    amount,
                })),
                { address: cdpAddr, abi: cdpAbi, functionName: 'deposit', args: [positionId, address, funds] },
            ]
        },
        enabled: enabled && !!address && !!cdpAddr && depositAmount > 0,
    })

    const handleSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['vault summary'] })
        queryClient.invalidateQueries({ queryKey: ['positions'] })
        queryClient.invalidateQueries({ queryKey: ['balances'] })
        // Allowance read inside the msg builder changed with this tx — rebuild msgs.
        queryClient.invalidateQueries({ queryKey: ['deposit_transaction', 'evm'] })
        onSuccess?.()
    }

    return useSimulateAndBroadcast({
        msgs,
        queryKey: ['deposit', asset.symbol, String(depositAmount)],
        amount: String(depositAmount),
        enabled: enabled && !!msgs && msgs.length > 0,
        onSuccess: handleSuccess,
        successMessage,
    })
}
