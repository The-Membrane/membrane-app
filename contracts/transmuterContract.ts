import { DittoPageContract } from '@/components/DittoSpeechBox/types/dittoContract'

/**
 * Ditto Page Contract: Transmuter
 * 
 * The Transmuter allows swapping between CDT and USDC with capacity limits.
 * Key concerns are swap capacity, rates, and lockdrop participation.
 */
export const transmuterContract: DittoPageContract = {
    pageId: 'transmuter',
    
    facts: {
        // Capacity facts
        cdtToUsdcCapacity: 'Available capacity for CDT→USDC swaps',
        usdcToCdtCapacity: 'Available capacity for USDC→CDT swaps',
        totalCapacity: 'Total transmuter capacity',
        capacityUtilization: 'Percentage of capacity in use',
        
        // Swap facts
        swapAmount: 'Amount user wants to swap',
        swapDirection: 'Direction: cdt-to-usdc or usdc-to-cdt',
        canSwap: 'Whether swap is possible',
        swapRate: 'Current swap rate',
        
        // Balance facts
        cdtBalance: 'User CDT balance',
        usdcBalance: 'User USDC balance',
        hasBalance: 'Whether user has balance to swap',
        
        // Lockdrop facts
        hasLockdrop: 'Whether user has lockdrop position',
        lockdropAmount: 'Amount locked in lockdrop',
        lockdropMBRN: 'MBRN allocation from lockdrop',
        lockdropUnlockTime: 'When lockdrop unlocks',
        isLockdropClaimable: 'Whether lockdrop can be claimed',
        
        // Connection facts
        isConnected: 'Whether wallet is connected',
    },
    
    thresholds: {
        lowCapacity: 10, // 10% capacity remaining
        criticalCapacity: 5, // 5% capacity remaining
        significantRateChange: 0.01, // 1% rate change
    },
    
    messages: [
        // =====================
        // ALERTs (Proactive)
        // =====================
        {
            id: 'transmuter-no-capacity',
            type: 'ALERT',
            severity: 'danger',
            body: 'Swap unavailable — {swapDirection} capacity exhausted',
            when: '(swapDirection == "cdt-to-usdc" && cdtToUsdcCapacity < swapAmount) || (swapDirection == "usdc-to-cdt" && usdcToCdtCapacity < swapAmount)',
            cooldownSec: 60,
            showAs: 'toast',
            blocks: ['swap'],
        },
        {
            id: 'transmuter-capacity-critical',
            type: 'ALERT',
            severity: 'warn',
            body: 'Only {capacityUtilization}% capacity left — large swaps may fail',
            when: 'capacityUtilization >= (100 - thresholds.criticalCapacity)',
            cooldownSec: 300,
            showAs: 'toast',
        },
        {
            id: 'transmuter-not-connected',
            type: 'ALERT',
            severity: 'info',
            body: 'Connect wallet to swap',
            when: '!isConnected',
            cooldownSec: 300,
            showAs: 'toast',
            blocks: ['swap'],
        },
        {
            id: 'transmuter-no-balance',
            type: 'ALERT',
            severity: 'info',
            body: 'Insufficient balance for this swap',
            when: 'isConnected && !hasBalance && swapAmount > 0',
            cooldownSec: 120,
            showAs: 'toast',
            blocks: ['swap'],
        },
        {
            id: 'transmuter-lockdrop-ready',
            type: 'ALERT',
            severity: 'info',
            body: 'Lockdrop MBRN ready to claim!',
            when: 'hasLockdrop && isLockdropClaimable',
            cooldownSec: 3600,
            showAs: 'toast',
        },
        
        // =====================
        // UPDATEs (Badge)
        // =====================
        {
            id: 'transmuter-capacity-restored',
            type: 'UPDATE',
            severity: 'info',
            body: 'Swap capacity restored — {totalCapacity} USDC available',
            when: 'totalCapacity_changed && totalCapacity_delta > 0',
            cooldownSec: 600,
            showAs: 'badge',
        },
        {
            id: 'transmuter-rate-changed',
            type: 'UPDATE',
            severity: 'info',
            body: 'Swap rate adjusted to {swapRate}',
            when: 'swapRate_changed && Math.abs(swapRate_delta) > thresholds.significantRateChange',
            cooldownSec: 600,
            showAs: 'badge',
        },
        {
            id: 'transmuter-lockdrop-updated',
            type: 'UPDATE',
            severity: 'info',
            body: 'Lockdrop allocation updated — {lockdropMBRN} MBRN',
            when: 'lockdropMBRN_changed && lockdropMBRN_delta > 0',
            cooldownSec: 3600,
            showAs: 'badge',
        },
        
        // =====================
        // INSIGHTs (Panel)
        // =====================
        {
            id: 'transmuter-capacity-status',
            type: 'INSIGHT',
            severity: 'info',
            body: 'CDT→USDC: {cdtToUsdcCapacity} available | USDC→CDT: {usdcToCdtCapacity} available',
            when: 'isConnected',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'transmuter-swap-preview',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Swapping {swapAmount} at {swapRate} rate',
            when: 'swapAmount > 0 && canSwap',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'transmuter-lockdrop-status',
            type: 'INSIGHT',
            severity: 'info',
            body: '{lockdropAmount} USDC locked → {lockdropMBRN} MBRN allocation',
            when: 'hasLockdrop',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'transmuter-lockdrop-countdown',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Lockdrop unlocks in {lockdropUnlockTime}',
            when: 'hasLockdrop && !isLockdropClaimable',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'transmuter-no-lockdrop',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Lock USDC in the lockdrop to earn MBRN',
            when: '!hasLockdrop && isConnected',
            cooldownSec: 0,
            showAs: 'panel',
        },
    ],
    
    shortcuts: [
        {
            id: 'transmuter-claim-lockdrop',
            label: 'Claim {lockdropMBRN} MBRN',
            when: 'hasLockdrop && isLockdropClaimable',
            action: 'claimLockdrop',
        },
        {
            id: 'transmuter-swap-max',
            label: 'Swap max available',
            when: 'hasBalance && canSwap',
            action: 'setMaxSwap',
        },
        {
            id: 'transmuter-view-lockdrop',
            label: 'View lockdrop details',
            when: 'hasLockdrop',
            action: 'showLockdropDetails',
        },
        {
            id: 'transmuter-join-lockdrop',
            label: 'Join lockdrop',
            when: '!hasLockdrop && isConnected && usdcBalance > 0',
            action: 'openLockdrop',
        },
    ],
}

export default transmuterContract









