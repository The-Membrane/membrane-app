import { DittoPageContract } from '@/components/DittoSpeechBox/types/dittoContract'

/**
 * Ditto Page Contract: Disco
 * 
 * The Disco page allows users to stake MBRN to back LTV tiers and earn
 * CDT revenue. Key concerns are deposit management, lock periods, and rewards.
 */
export const discoContract: DittoPageContract = {
    pageId: 'disco',
    
    facts: {
        // Deposit facts
        hasDeposits: 'Whether user has MBRN deposits',
        totalMBRN: 'Total MBRN deposited',
        depositCount: 'Number of deposit positions',
        
        // Rewards facts
        pendingRewards: 'Pending CDT rewards claimable',
        isClaimable: 'Whether rewards can be claimed',
        lastClaimTime: 'Timestamp of last claim',
        
        // Lock facts
        lockDuration: 'Current lock duration in days',
        lockExpiry: 'Lock expiry timestamp',
        isLockExpired: 'Whether lock has expired',
        canExtendLock: 'Whether lock can be extended',
        
        // Boost facts
        boostMultiplier: 'Current boost multiplier',
        maxBoostMultiplier: 'Maximum achievable boost',
        boostProgress: 'Progress towards max boost (0-100)',
        
        // LTV tier facts
        backedTiers: 'Number of LTV tiers user is backing',
        totalTiers: 'Total available LTV tiers',
        tierHealth: 'Health of backed tiers (0-100)',
        
        // Protocol facts
        protocolRevenue: 'Total protocol CDT revenue',
        userShare: 'User\'s share of revenue (%)',
        
        // Connection facts
        isConnected: 'Whether wallet is connected',
        hasMBRNBalance: 'Whether user has MBRN in wallet',
    },
    
    thresholds: {
        lowBoost: 1.5,
        highBoost: 3.0,
        claimableMinimum: 0.01, // Minimum CDT worth claiming
        lockExpiryWarningDays: 7,
        tierHealthWarning: 70,
        tierHealthDanger: 50,
    },
    
    messages: [
        // =====================
        // ALERTs (Proactive)
        // =====================
        {
            id: 'disco-lock-expiring',
            type: 'ALERT',
            severity: 'warn',
            body: 'Lock expires in {lockExpiry} days — extend to keep boost',
            when: 'hasDeposits && lockExpiry < thresholds.lockExpiryWarningDays * 86400000',
            cooldownSec: 86400, // Once per day
            showAs: 'toast',
        },
        {
            id: 'disco-lock-expired',
            type: 'ALERT',
            severity: 'danger',
            body: 'Lock expired — boost multiplier reset to 1x',
            when: 'hasDeposits && isLockExpired',
            cooldownSec: 300,
            showAs: 'toast',
            blocks: ['extendLock'],
        },
        {
            id: 'disco-tier-health-danger',
            type: 'ALERT',
            severity: 'danger',
            body: 'Backed tiers at {tierHealth}% health — potential losses',
            when: 'hasDeposits && tierHealth <= thresholds.tierHealthDanger',
            cooldownSec: 300,
            showAs: 'toast',
        },
        {
            id: 'disco-tier-health-warning',
            type: 'ALERT',
            severity: 'warn',
            body: 'Tier health dropped to {tierHealth}%',
            when: 'hasDeposits && tierHealth <= thresholds.tierHealthWarning && tierHealth > thresholds.tierHealthDanger',
            cooldownSec: 600,
            showAs: 'toast',
        },
        {
            id: 'disco-not-connected',
            type: 'ALERT',
            severity: 'info',
            body: 'Connect wallet to view deposits',
            when: '!isConnected',
            cooldownSec: 300,
            showAs: 'toast',
            blocks: ['deposit', 'withdraw', 'claim'],
        },
        
        // =====================
        // UPDATEs (Badge)
        // =====================
        {
            id: 'disco-rewards-ready',
            type: 'UPDATE',
            severity: 'info',
            body: '{pendingRewards} CDT ready to claim',
            when: 'pendingRewards >= thresholds.claimableMinimum && isClaimable',
            cooldownSec: 3600, // Once per hour
            showAs: 'badge',
        },
        {
            id: 'disco-boost-increased',
            type: 'UPDATE',
            severity: 'info',
            body: 'Boost multiplier now {boostMultiplier}x',
            when: 'boostMultiplier_changed && boostMultiplier_delta > 0',
            cooldownSec: 600,
            showAs: 'badge',
        },
        {
            id: 'disco-revenue-distributed',
            type: 'UPDATE',
            severity: 'info',
            body: 'New revenue distributed — check your rewards',
            when: 'pendingRewards_changed && pendingRewards_delta > 0',
            cooldownSec: 3600,
            showAs: 'badge',
        },
        
        // =====================
        // INSIGHTs (Panel)
        // =====================
        {
            id: 'disco-boost-interpretation',
            type: 'INSIGHT',
            severity: 'info',
            body: 'At {boostMultiplier}x boost, you earn {userShare}% of revenue',
            when: 'hasDeposits && boostMultiplier > 1',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'disco-no-boost',
            type: 'INSIGHT',
            severity: 'warn',
            body: 'No lock = no boost — extend lock to multiply earnings',
            when: 'hasDeposits && boostMultiplier <= 1',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'disco-boost-potential',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Lock longer to reach {maxBoostMultiplier}x boost ({boostProgress}% there)',
            when: 'hasDeposits && boostMultiplier < maxBoostMultiplier',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'disco-tier-coverage',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Backing {backedTiers} of {totalTiers} LTV tiers',
            when: 'hasDeposits && backedTiers > 0',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'disco-first-deposit-cta',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Deposit MBRN to earn CDT revenue from protocol fees',
            when: '!hasDeposits && isConnected && hasMBRNBalance',
            cooldownSec: 0,
            showAs: 'panel',
        },
    ],
    
    shortcuts: [
        {
            id: 'disco-claim-rewards',
            label: 'Claim {pendingRewards} CDT',
            when: 'isClaimable && pendingRewards >= thresholds.claimableMinimum',
            action: 'claimRewards',
        },
        {
            id: 'disco-extend-lock',
            label: 'Extend lock for more boost',
            when: 'hasDeposits && canExtendLock',
            action: 'extendLock',
        },
        {
            id: 'disco-view-tiers',
            label: 'View LTV tier breakdown',
            when: 'hasDeposits',
            action: 'showTierBreakdown',
        },
        {
            id: 'disco-deposit',
            label: 'Deposit MBRN',
            when: 'isConnected && hasMBRNBalance',
            action: 'openDeposit',
        },
    ],
}

export default discoContract








