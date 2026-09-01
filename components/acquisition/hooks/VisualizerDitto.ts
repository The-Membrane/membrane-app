import { useMemo } from 'react'
import { useDittoPage } from '@/components/DittoSpeechBox/hooks/useDittoPage'
import { transmuterContract } from '@/contracts/transmuterContract'
import { VisualizerAllocation } from '../VisualizerPhysics'

interface UseVisualizerDittoParams {
    allocations: VisualizerAllocation[]
    address: string | undefined
    transmuterTVL: number | undefined
    cdtBalance: string | undefined
    usdcBalance: string | undefined
    claimsReady: boolean
}

/**
 * Ditto page integration for the acquisition visualizer. This is a
 * side-effecting hook: the `ditto` binding is intentionally unused, mirroring
 * the original inline integration in AcquisitionVisualizer.
 */
export const useVisualizerDitto = ({
    allocations,
    address,
    transmuterTVL,
    cdtBalance,
    usdcBalance,
    claimsReady,
}: UseVisualizerDittoParams) => {
    // =====================
    // DITTO INTEGRATION
    // =====================

    // Calculate user's lockdrop position
    const userLockdropPosition = useMemo(() => {
        const userAllocation = allocations.find(a => a.user === address)
        if (!userAllocation) return null
        return {
            amount: userAllocation.allocation || 0,
            lockDays: userAllocation.lockDays || 0,
            mbrnAllocation: userAllocation.allocation || 0,
        }
    }, [allocations, address])

    // Calculate swap capacities (simplified - would need actual transmuter data)
    const swapCapacity = useMemo(() => {
        const tvl = transmuterTVL || 0
        return {
            cdtToUsdc: tvl * 0.5, // Simplified estimate
            usdcToCdt: tvl * 0.5,
            utilization: 50, // Would need actual calculation
        }
    }, [transmuterTVL])

    // Ditto page integration
    const ditto = useDittoPage({
        contract: transmuterContract,
        facts: {
            // Capacity facts
            cdtToUsdcCapacity: swapCapacity.cdtToUsdc,
            usdcToCdtCapacity: swapCapacity.usdcToCdt,
            totalCapacity: transmuterTVL || 0,
            capacityUtilization: swapCapacity.utilization,

            // Swap facts
            swapAmount: 0, // Would be set when user inputs swap amount
            swapDirection: 'cdt-to-usdc',
            canSwap: swapCapacity.cdtToUsdc > 0,
            swapRate: 1.0, // Would need actual rate

            // Balance facts
            cdtBalance: parseFloat(cdtBalance || '0') / 1e6,
            usdcBalance: parseFloat(usdcBalance || '0') / 1e6,
            hasBalance: parseFloat(cdtBalance || '0') > 0 || parseFloat(usdcBalance || '0') > 0,

            // Lockdrop facts
            hasLockdrop: !!userLockdropPosition,
            lockdropAmount: userLockdropPosition?.amount || 0,
            lockdropMBRN: userLockdropPosition?.mbrnAllocation || 0,
            lockdropUnlockTime: userLockdropPosition ? `${userLockdropPosition.lockDays} days` : '',
            isLockdropClaimable: claimsReady,

            // Connection facts
            isConnected: !!address,
        },
        onShortcut: (shortcutId: string, action: string) => {
            switch (action) {
                case 'claimLockdrop':
                    // Would trigger lockdrop claim
                    break
                case 'setMaxSwap':
                    // Would set max swap amount
                    break
                case 'showLockdropDetails':
                    // Scroll to lockdrop section
                    document.querySelector('[data-section="lockdrop"]')?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center'
                    })
                    break
                case 'openLockdrop':
                    // Focus on deposit amount input
                    break
            }
        },
    })
}
