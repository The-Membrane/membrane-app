import { useQuery } from '@tanstack/react-query'
import { erc20Abi } from 'viem'
import { cdpAbi } from '@/contracts/abis/cdp'
import { assetKey } from '@/services/chain/liquidation'
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
}: UseDepositTransactionProps) => {
    const { address, chain } = useWallet()
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
        queryFn: () => {
            if (!address || !cdpAddr || !depositAmount || depositAmount <= 0 || !enabled) return undefined

            const decimals = asset.decimal ?? collateralAsset?.decimal ?? 18
            const amount = BigInt(shiftDigits(depositAmount, decimals).dp(0).toString())
            // token = ERC-20 address (Asset.base on EVM); denom = bytes32 asset key.
            const token = (collateralAsset?.base ?? asset.denom) as Address
            const funds = [{ denom: assetKey(asset.symbol), amount }]

            return [
                { address: token, abi: erc20Abi, functionName: 'approve', args: [cdpAddr, amount] },
                { address: cdpAddr, abi: cdpAbi, functionName: 'deposit', args: [positionId, address, funds] },
            ]
        },
        enabled: enabled && !!address && !!cdpAddr && depositAmount > 0,
    })

    const handleSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['vault summary'] })
        queryClient.invalidateQueries({ queryKey: ['positions'] })
        queryClient.invalidateQueries({ queryKey: ['balances'] })
        onSuccess?.()
    }

    return useSimulateAndBroadcast({
        msgs,
        queryKey: ['deposit', asset.symbol, String(depositAmount)],
        amount: String(depositAmount),
        enabled: enabled && !!msgs && msgs.length > 0,
        onSuccess: handleSuccess,
    })
}
