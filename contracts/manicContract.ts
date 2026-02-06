import { DittoPageContract } from '@/components/DittoSpeechBox/types/dittoContract'

/**
 * Ditto Page Contract: Manic Looping
 * 
 * The Manic page allows users to deposit USDC and loop their positions
 * for leveraged yield. Key concerns are capacity, risk, and APR optimization.
 */
export const manicContract: DittoPageContract = {
    pageId: 'manic',
    
    facts: {
        // Position facts
        hasDeposit: 'Whether user has USDC deposited',
        depositAmount: 'Amount deposited in USDC',
        collateralAmount: 'Total collateral in position',
        debtAmount: 'Total debt in position',
        
        // Loop facts
        currentLoop: 'Current loop multiplier (1-10)',
        targetLoop: 'Slider target multiplier',
        maxSafeLoop: 'Maximum safe loop level given current rates',
        loopDisabled: 'Whether loop action is disabled',
        
        // Capacity facts
        loopCapacity: 'Available loop capacity in transmuter (USDC)',
        capacityRequired: 'Capacity needed for target loop',
        capacityPercent: 'Percentage of capacity remaining',
        
        // APR facts
        baseAPR: 'Current base vault APR (%)',
        userAPR: 'User\'s current effective APR (%)',
        projectedAPR: 'APR at target loop level (%)',
        historicalAPR: 'Average historical APR (%)',
        
        // Risk facts
        riskScore: 'Position risk score 0-100',
        rateVolatility: 'Rate volatility metric (0-1)',
        
        // Transaction facts
        txStatus: 'Transaction status: pending | confirmed | failed | idle',
        
        // Connection facts
        isConnected: 'Whether wallet is connected',
        hasBalance: 'Whether user has USDC balance',
    },
    
    thresholds: {
        riskWarning: 70,
        riskDanger: 85,
        capacityWarning: 10, // 10% remaining
        capacityDanger: 5,   // 5% remaining
        aprSignificantChange: 0.5, // 0.5% change
        highLoopLevel: 3,
        stableVolatility: 0.1,
    },
    
    messages: [
        // =====================
        // ALERTs (Proactive)
        // =====================
        {
            id: 'manic-no-capacity',
            type: 'ALERT',
            severity: 'danger',
            body: 'Loop disabled — transmuter capacity exhausted',
            when: 'loopCapacity < capacityRequired && hasDeposit',
            cooldownSec: 60,
            showAs: 'toast',
            blocks: ['loop'],
        },
        {
            id: 'manic-capacity-critical',
            type: 'ALERT',
            severity: 'danger',
            body: 'Only {capacityPercent}% capacity left — loops may fail',
            when: 'capacityPercent <= thresholds.capacityDanger && capacityPercent > 0',
            cooldownSec: 300,
            showAs: 'toast',
        },
        {
            id: 'manic-risk-critical',
            type: 'ALERT',
            severity: 'danger',
            body: 'Position at {riskScore}% risk — reduce loop or add collateral',
            when: 'riskScore >= thresholds.riskDanger',
            cooldownSec: 300,
            showAs: 'toast',
        },
        {
            id: 'manic-risk-warning',
            type: 'ALERT',
            severity: 'warn',
            body: 'Risk elevated at {riskScore}% — monitor rates closely',
            when: 'riskScore >= thresholds.riskWarning && riskScore < thresholds.riskDanger',
            cooldownSec: 600,
            showAs: 'toast',
        },
        {
            id: 'manic-no-position',
            type: 'ALERT',
            severity: 'info',
            body: 'Deposit first to enable looping',
            when: '!hasDeposit && isConnected',
            cooldownSec: 120,
            showAs: 'toast',
            blocks: ['loop', 'withdraw'],
        },
        {
            id: 'manic-not-connected',
            type: 'ALERT',
            severity: 'info',
            body: 'Connect wallet to view your position',
            when: '!isConnected',
            cooldownSec: 300,
            showAs: 'toast',
            blocks: ['deposit', 'loop', 'withdraw'],
        },
        
        // =====================
        // UPDATEs (Badge)
        // =====================
        {
            id: 'manic-capacity-changed',
            type: 'UPDATE',
            severity: 'info',
            body: 'Loop capacity now {loopCapacity} USDC',
            when: 'loopCapacity_changed && loopCapacity > 0',
            cooldownSec: 600,
            showAs: 'badge',
        },
        {
            id: 'manic-apr-increased',
            type: 'UPDATE',
            severity: 'info',
            body: 'Base APR up to {baseAPR}% — good time to loop',
            when: 'baseAPR_changed && baseAPR_delta > thresholds.aprSignificantChange',
            cooldownSec: 600,
            showAs: 'badge',
        },
        {
            id: 'manic-apr-decreased',
            type: 'UPDATE',
            severity: 'warn',
            body: 'Base APR dropped to {baseAPR}%',
            when: 'baseAPR_changed && baseAPR_delta < -thresholds.aprSignificantChange',
            cooldownSec: 600,
            showAs: 'badge',
        },
        {
            id: 'manic-position-opened',
            type: 'UPDATE',
            severity: 'info',
            body: 'Position active — earning {userAPR}% APR',
            when: 'hasDeposit && !hasDeposit_changed',
            cooldownSec: 0, // Only show once when position opens
            showAs: 'badge',
        },
        
        // =====================
        // INSIGHTs (Panel)
        // =====================
        {
            id: 'manic-loop-interpretation',
            type: 'INSIGHT',
            severity: 'info',
            body: 'At {currentLoop}x you earn {userAPR}% — {targetLoop}x would yield {projectedAPR}%',
            when: 'hasDeposit && currentLoop != targetLoop',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'manic-current-earning',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Your {depositAmount} USDC is earning {userAPR}% at {currentLoop}x loop',
            when: 'hasDeposit && currentLoop == targetLoop',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'manic-risk-reward-warning',
            type: 'INSIGHT',
            severity: 'warn',
            body: 'Higher loops = higher APR but faster liquidation if rates spike',
            when: 'targetLoop > thresholds.highLoopLevel',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'manic-stable-note',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Position stable — rates consistent over past week',
            when: 'hasDeposit && rateVolatility < thresholds.stableVolatility',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'manic-volatile-warning',
            type: 'INSIGHT',
            severity: 'warn',
            body: 'Rate volatility elevated — consider lower loop level',
            when: 'hasDeposit && rateVolatility >= thresholds.stableVolatility',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'manic-apr-comparison',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Current APR {baseAPR}% vs historical avg {historicalAPR}%',
            when: 'baseAPR > 0 && historicalAPR > 0',
            cooldownSec: 0,
            showAs: 'panel',
        },
    ],
    
    shortcuts: [
        {
            id: 'manic-jump-position',
            label: 'Jump to my position',
            when: 'hasDeposit',
            action: 'scrollToPosition',
        },
        {
            id: 'manic-max-safe-loop',
            label: 'Set to max safe loop',
            when: 'hasDeposit && targetLoop < maxSafeLoop',
            action: 'setMaxSafeLoop',
        },
        {
            id: 'manic-explain-disabled',
            label: 'Why is loop disabled?',
            when: 'loopDisabled',
            action: 'explainDisabled',
        },
        {
            id: 'manic-view-rates',
            label: 'View historical rates',
            when: 'true',
            action: 'showRatesChart',
        },
    ],
}

export default manicContract








