import { DittoPageContract } from '@/components/DittoSpeechBox/types/dittoContract'

/**
 * Ditto Page Contract: Portfolio
 * 
 * The Portfolio page shows an overview of all user positions across products.
 * Key concerns are position health, pending rewards, and alerts from all products.
 */
export const portfolioContract: DittoPageContract = {
    pageId: 'portfolio',
    
    facts: {
        // Aggregate facts
        totalValue: 'Total portfolio value in USD',
        totalEarnings: 'Total earnings across all products',
        dailyEarnings: 'Earnings in last 24 hours',
        
        // Manic position
        hasManicPosition: 'Whether user has Manic position',
        manicTVL: 'Manic position TVL in USDC',
        manicAPR: 'Current Manic APR (%)',
        manicRiskScore: 'Manic position risk (0-100)',
        
        // Disco position
        hasDiscoPosition: 'Whether user has Disco deposits',
        discoMBRN: 'Total MBRN in Disco',
        discoRewards: 'Pending Disco CDT rewards',
        discoBoost: 'Disco boost multiplier',
        
        // Transmuter position
        hasTransmuterLockdrop: 'Whether user has lockdrop position',
        lockdropValue: 'Lockdrop USDC value',
        lockdropMBRN: 'Lockdrop MBRN allocation',
        
        // Aggregate rewards
        totalPendingRewards: 'Total claimable rewards (all products)',
        hasClaimableRewards: 'Whether any rewards are claimable',
        
        // Health indicators
        worstRiskScore: 'Highest risk score across positions',
        needsAttention: 'Whether any position needs attention',
        
        // Time-based
        lastVisit: 'Timestamp of last portfolio visit',
        daysSinceLastVisit: 'Days since last visit',
        
        // Connection
        isConnected: 'Whether wallet is connected',
        hasAnyPosition: 'Whether user has any position',
    },
    
    thresholds: {
        riskWarning: 70,
        riskDanger: 85,
        significantEarningsChange: 10, // $10 change
        inactivityDays: 7,
        minimumClaimable: 0.1, // Minimum worth claiming
    },
    
    messages: [
        // =====================
        // ALERTs (Proactive)
        // =====================
        {
            id: 'portfolio-high-risk',
            type: 'ALERT',
            severity: 'danger',
            body: 'Position at {worstRiskScore}% risk — check Manic page',
            when: 'worstRiskScore >= thresholds.riskDanger',
            cooldownSec: 300,
            showAs: 'toast',
        },
        {
            id: 'portfolio-risk-warning',
            type: 'ALERT',
            severity: 'warn',
            body: 'Risk elevated at {worstRiskScore}% — monitor closely',
            when: 'worstRiskScore >= thresholds.riskWarning && worstRiskScore < thresholds.riskDanger',
            cooldownSec: 600,
            showAs: 'toast',
        },
        {
            id: 'portfolio-not-connected',
            type: 'ALERT',
            severity: 'info',
            body: 'Connect wallet to view portfolio',
            when: '!isConnected',
            cooldownSec: 300,
            showAs: 'toast',
        },
        {
            id: 'portfolio-needs-attention',
            type: 'ALERT',
            severity: 'warn',
            body: 'One or more positions need attention',
            when: 'needsAttention && isConnected',
            cooldownSec: 600,
            showAs: 'toast',
        },
        
        // =====================
        // UPDATEs (Badge)
        // =====================
        {
            id: 'portfolio-rewards-accumulated',
            type: 'UPDATE',
            severity: 'info',
            body: '{totalPendingRewards} rewards ready to claim',
            when: 'hasClaimableRewards && totalPendingRewards >= thresholds.minimumClaimable',
            cooldownSec: 3600,
            showAs: 'badge',
        },
        {
            id: 'portfolio-earnings-milestone',
            type: 'UPDATE',
            severity: 'info',
            body: 'Earned {dailyEarnings} in the last 24 hours',
            when: 'dailyEarnings_changed && dailyEarnings > thresholds.significantEarningsChange',
            cooldownSec: 86400, // Once per day
            showAs: 'badge',
        },
        {
            id: 'portfolio-value-increased',
            type: 'UPDATE',
            severity: 'info',
            body: 'Portfolio value up — now {totalValue}',
            when: 'totalValue_changed && totalValue_delta > 0',
            cooldownSec: 3600,
            showAs: 'badge',
        },
        {
            id: 'portfolio-welcome-back',
            type: 'UPDATE',
            severity: 'info',
            body: 'Welcome back! {daysSinceLastVisit} days since last visit',
            when: 'daysSinceLastVisit >= thresholds.inactivityDays',
            cooldownSec: 86400,
            showAs: 'badge',
        },
        
        // =====================
        // INSIGHTs (Panel)
        // =====================
        {
            id: 'portfolio-summary',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Portfolio: {totalValue} total | {totalEarnings} earned',
            when: 'hasAnyPosition',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'portfolio-manic-summary',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Manic: {manicTVL} USDC at {manicAPR}% APR',
            when: 'hasManicPosition',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'portfolio-disco-summary',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Disco: {discoMBRN} MBRN at {discoBoost}x boost | {discoRewards} CDT pending',
            when: 'hasDiscoPosition',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'portfolio-lockdrop-summary',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Lockdrop: {lockdropValue} USDC → {lockdropMBRN} MBRN',
            when: 'hasTransmuterLockdrop',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'portfolio-no-positions',
            type: 'INSIGHT',
            severity: 'info',
            body: 'No active positions — explore Manic or Disco to start earning',
            when: 'isConnected && !hasAnyPosition',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'portfolio-risk-summary',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Overall portfolio risk: {worstRiskScore}%',
            when: 'hasAnyPosition && worstRiskScore > 0',
            cooldownSec: 0,
            showAs: 'panel',
        },
    ],
    
    shortcuts: [
        {
            id: 'portfolio-claim-all',
            label: 'Claim all rewards ({totalPendingRewards})',
            when: 'hasClaimableRewards && totalPendingRewards >= thresholds.minimumClaimable',
            action: 'claimAllRewards',
        },
        {
            id: 'portfolio-view-manic',
            label: 'View Manic position',
            when: 'hasManicPosition',
            action: 'navigateToManic',
        },
        {
            id: 'portfolio-view-disco',
            label: 'View Disco deposits',
            when: 'hasDiscoPosition',
            action: 'navigateToDisco',
        },
        {
            id: 'portfolio-start-earning',
            label: 'Start earning with Manic',
            when: '!hasAnyPosition && isConnected',
            action: 'navigateToManic',
        },
    ],
}

export default portfolioContract








