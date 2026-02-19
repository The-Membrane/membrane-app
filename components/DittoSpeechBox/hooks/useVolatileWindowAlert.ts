import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import useWallet from '@/hooks/useWallet'
import useAppState from '@/persisted-state/useAppState'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { useChainRoute } from '@/hooks/useChainRoute'
import { getAssetByDenom } from '@/helpers/chain'
import { getUserPositions, getVolatilityWindow, useCDPClient, USE_MOCK_VOLATILITY } from '@/services/cdp'
import { shiftDigits } from '@/helpers/math'
import { BasketPositionsResponse } from '@/contracts/codegen/positions/Positions.types'

// Mock position data for testing without on-chain state
const MOCK_POSITION_INFO = {
    hasDebt: true,
    collateralDenoms: [
        'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2', // ATOM
        'uosmo', // OSMO
    ],
}

export const useVolatileWindowAlert = () => {
    const { chainName } = useChainRoute()
    const { address } = useWallet()
    const { appState } = useAppState()
    const { data: cosmWasmClient } = useCosmWasmClient(appState.rpcUrl)
    const { data: cdpClient } = useCDPClient(appState.rpcUrl)

    // Fetch user positions (route-unrestricted, separate query key from useCDP.ts)
    const { data: userPositions } = useQuery({
        queryKey: ['volatile_alert_positions', address, cdpClient, appState.rpcUrl],
        queryFn: async () => {
            if (!address || !cdpClient) return []
            return getUserPositions(address, cdpClient) as Promise<BasketPositionsResponse[]>
        },
        enabled: !USE_MOCK_VOLATILITY && !!address && !!cdpClient,
        staleTime: 1000 * 60 * 5,
    })

    // Derive position info: does user have debt + what collateral denoms
    const positionInfo = useMemo(() => {
        if (USE_MOCK_VOLATILITY) return MOCK_POSITION_INFO

        if (!userPositions || userPositions.length === 0) {
            return { hasDebt: false, collateralDenoms: [] as string[] }
        }

        const firstPosition = userPositions[0]?.positions?.[0]
        if (!firstPosition) {
            return { hasDebt: false, collateralDenoms: [] as string[] }
        }

        const debt = shiftDigits(firstPosition.credit_amount, -6).toNumber()
        const collateralDenoms = firstPosition.collateral_assets
            .map((cAsset) => {
                //@ts-ignore
                return cAsset.asset?.info?.native_token?.denom || cAsset.asset?.info?.denom
            })
            .filter(Boolean) as string[]

        return { hasDebt: debt > 0, collateralDenoms }
    }, [userPositions])

    // Query volatility window (only if user has debt and collateral)
    const { data: volatilityData } = useQuery({
        queryKey: ['volatility_window', positionInfo.collateralDenoms, appState.rpcUrl],
        queryFn: async () => {
            if (!cosmWasmClient || positionInfo.collateralDenoms.length === 0) return null
            return getVolatilityWindow(positionInfo.collateralDenoms, cosmWasmClient)
        },
        enabled: positionInfo.hasDebt && positionInfo.collateralDenoms.length > 0 && (USE_MOCK_VOLATILITY || !!cosmWasmClient),
        staleTime: 1000 * 60 * 2,
    })

    // Derive final alert state
    return useMemo(() => {
        if (!volatilityData || !positionInfo.hasDebt) {
            return {
                showAlert: false,
                volatileAssets: [] as string[],
                pointsAvailable: 0,
            }
        }

        const volatileAssets: string[] = []
        volatilityData.in_volatile_window.forEach((isVolatile, index) => {
            if (isVolatile) {
                const denom = positionInfo.collateralDenoms[index]
                const asset = getAssetByDenom(denom, chainName)
                volatileAssets.push(asset?.symbol || denom)
            }
        })

        return {
            showAlert: volatileAssets.length > 0,
            volatileAssets,
            pointsAvailable: 5, // Fixed: 5 MBRN management points per contract spec
        }
    }, [volatilityData, positionInfo, chainName])
}
