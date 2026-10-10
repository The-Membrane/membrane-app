# Ditto Liquidation Warning Message -- Implementation Guide

## 1. Which Ditto Message Type(s) to Use and Why

Based on the established Ditto contract system defined in `/Users/EBmic/membrane-app/components/DittoSpeechBox/types/dittoContract.ts`, a collateral-near-liquidation warning should use **two message types at different severity tiers**:

### Primary: `ALERT` type with `danger` severity

This is the highest-priority combination in the system. According to `MESSAGE_TYPE_PRIORITY`, ALERT = 100 and `SEVERITY_PRIORITY` danger = 100, giving a combined priority score of **200** -- the maximum possible. This is appropriate because liquidation is a capital-loss event that demands immediate user attention.

**Why ALERT and not UPDATE or INSIGHT:**
- `ALERT` is designed for proactive, blocking situations (see `portfolio-high-risk` and `transmuter-no-capacity` as precedents in the existing contracts)
- `UPDATE` is for data-changed notifications shown as badges -- too passive for liquidation risk
- `INSIGHT` is for panel-only informational content shown when the user opens Ditto -- too passive for something time-critical
- The existing `portfolioContract.ts` already uses `ALERT` + `danger` for `portfolio-high-risk` when `worstRiskScore >= 85`, confirming this pattern

### Secondary: `ALERT` type with `warn` severity

A lower-urgency pre-warning when the user is approaching danger but not yet critical. This follows the two-tier pattern already established in `portfolioContract.ts` with `portfolio-risk-warning` (warn at 70%) and `portfolio-high-risk` (danger at 85%).

---

## 2. Exact Message Text

### Danger-level message (LTV >= 90% of liquidation LTV):

```
title: undefined  (body is self-explanatory per Ditto convention)
body:  "Collateral at {currentLTV}% LTV -- liquidation starts at {liquidationLTV}%. Repay or add collateral now"
```

### Warning-level message (LTV >= 75% of liquidation LTV):

```
title: undefined
body:  "LTV rising -- now at {currentLTV}% of {liquidationLTV}% max. Consider repaying or adding collateral"
```

### Rationale for wording:
- **Concise:** Both are 1-2 lines, consistent with the existing Ditto body length convention (the `DittoMessage` interface specifies "1-2 lines, max 3 for danger alerts")
- **Actionable:** Both tell the user *what to do* (repay or add collateral), not just what is wrong
- **Uses interpolation syntax:** `{currentLTV}` and `{liquidationLTV}` follow the existing `{factName}` template syntax used throughout the contracts (e.g., `{worstRiskScore}` in portfolioContract)
- **No emoji:** Consistent with the danger/warn severity styling doing the visual work, not emoji
- **Urgency gradient:** The danger message says "now" (imperative), the warning says "consider" (advisory)

---

## 3. Severity Level and Styling

### Danger tier (critical -- near liquidation)

| Property | Value | Reason |
|----------|-------|--------|
| `severity` | `'danger'` | Maps to red styling per `SEMANTIC_COLORS.danger` (`#ef4444`) |
| `showAs` | `'toast'` | Proactive, non-blocking notification that appears near Ditto without requiring user to open the panel. This is the same display surface used by `portfolio-high-risk` and `transmuter-no-capacity`. |
| `type` | `'ALERT'` | Highest priority message type |
| Icon color | `SEMANTIC_COLORS.danger` (`#ef4444`) | Red -- per `COLOR_USAGE_GUIDELINES.danger`: "Liquidation warnings, Critical health ratios" |
| Border accent | `rgba(239, 68, 68, 0.3)` (danger with alpha) | Follows the Ditto panel border pattern of accent color + transparency |

In the `StatusTab` rendering (where StatusCards are displayed), this would use:
- `iconColor="red.400"` on the StatusCard
- `highlightColor="red.400"` for the LTV percentage highlight

### Warning tier (elevated -- approaching danger)

| Property | Value | Reason |
|----------|-------|--------|
| `severity` | `'warn'` | Maps to yellow styling per `SEMANTIC_COLORS.warning` (`#fbbf24`) |
| `showAs` | `'toast'` | Still proactive since this is a time-sensitive financial alert |
| `type` | `'ALERT'` | Same type -- severity differentiates the urgency |
| Icon color | `SEMANTIC_COLORS.warning` (`#fbbf24`) | Yellow -- per `COLOR_USAGE_GUIDELINES.warning`: "Approaching supply caps, Caution states" |

In `StatusTab`:
- `iconColor="yellow.400"`
- `highlightColor="yellow.400"` for the LTV percentage

### Display surfaces:

1. **Toast (primary):** Appears as a proactive floating message near the Ditto avatar. Auto-dismisses after `toastDurationMs` (5000ms default from `DEFAULT_DITTO_CONFIG`). For danger, consider extending to 8-10 seconds or making it persistent until dismissed.

2. **StatusTab card (secondary):** When the user opens Ditto's panel, this should also appear in the "Actions Available" section of the StatusTab as a `StatusCard` with a click handler that either navigates to the mint/borrow page or opens the RepayModal inline (following the pattern of the volatile window alert in `StatusTab.tsx`).

3. **Badge (tertiary):** While the toast is on cooldown but the condition persists, Ditto's avatar should show a red badge dot (using the `BADGED` activation state).

---

## 4. Code Snippet

### 4a. Page Contract Messages (add to a new or existing mint page contract)

```tsx
// In contracts/mintContract.ts (or add to portfolioContract.ts)

import { DittoPageContract } from '@/components/DittoSpeechBox/types/dittoContract'

export const mintContract: DittoPageContract = {
    pageId: 'mint',

    facts: {
        // Position health
        currentLTV: 'Current loan-to-value ratio as percentage',
        liquidationLTV: 'LTV threshold at which liquidation begins',
        borrowLTV: 'Maximum LTV for new borrowing',
        ltvRatio: 'currentLTV / liquidationLTV as percentage (0-100+)',
        collateralValue: 'Total collateral value in USD',
        debtAmount: 'Total debt amount in CDT',

        // Position existence
        hasPosition: 'Whether user has an active CDP position',
        hasDebt: 'Whether user has outstanding debt',

        // Connection
        isConnected: 'Whether wallet is connected',
    },

    thresholds: {
        ltvWarning: 75,    // 75% of liquidation LTV
        ltvDanger: 90,     // 90% of liquidation LTV
        ltvCritical: 95,   // 95% of liquidation LTV (imminent)
    },

    messages: [
        // =====================
        // LIQUIDATION ALERTs
        // =====================
        {
            id: 'mint-liquidation-imminent',
            type: 'ALERT',
            severity: 'danger',
            body: 'Collateral at {currentLTV}% LTV \u2014 liquidation starts at {liquidationLTV}%. Repay or add collateral now',
            when: 'hasDebt && ltvRatio >= thresholds.ltvDanger',
            cooldownSec: 120,   // Re-alert every 2 minutes while condition persists
            showAs: 'toast',
            blocks: ['mint', 'loop'],  // Block further borrowing while at risk
        },
        {
            id: 'mint-ltv-warning',
            type: 'ALERT',
            severity: 'warn',
            body: 'LTV rising \u2014 now at {currentLTV}% of {liquidationLTV}% max. Consider repaying or adding collateral',
            when: 'hasDebt && ltvRatio >= thresholds.ltvWarning && ltvRatio < thresholds.ltvDanger',
            cooldownSec: 600,   // Re-alert every 10 minutes
            showAs: 'toast',
        },

        // ... other mint page messages ...
    ],

    shortcuts: [
        {
            id: 'mint-repay-now',
            label: 'Repay debt',
            when: 'hasDebt && ltvRatio >= thresholds.ltvWarning',
            action: 'openRepayModal',
        },
        {
            id: 'mint-add-collateral',
            label: 'Add collateral',
            when: 'hasDebt && ltvRatio >= thresholds.ltvWarning',
            action: 'openDepositModal',
        },
    ],
}
```

### 4b. StatusTab Integration (add to the "Actions Available" section)

```tsx
// In components/DittoSpeechBox/tabs/StatusTab.tsx
// Add alongside the existing volatile window alert section

import { AlertTriangle, ShieldAlert } from 'lucide-react'
import { useLiquidationAlert } from '../hooks/useLiquidationAlert'

// Inside the StatusTab component:
const { showDangerAlert, showWarningAlert, currentLTV, liquidationLTV } = useLiquidationAlert()

// Then in the JSX, before or within the "Actions Available" section:

{/* Liquidation Danger Alert */}
{showDangerAlert && (
    <Box>
        <Text
            fontSize="xs"
            color="#F5F5F580"
            fontWeight="medium"
            mb={2}
            textTransform="uppercase"
            letterSpacing="wide"
        >
            Urgent
        </Text>
        <StatusCard
            icon={ShieldAlert}
            iconColor="red.400"
            title="Liquidation risk"
            subtitle={`LTV at ${currentLTV.toFixed(1)}% \u2014 liquidation at ${liquidationLTV.toFixed(1)}%. Repay or add collateral.`}
            subtitleHighlight={`${currentLTV.toFixed(1)}%`}
            highlightColor="red.400"
            onClick={() => setIsRepayModalOpen(true)}
        />
    </Box>
)}

{/* Liquidation Warning Alert */}
{!showDangerAlert && showWarningAlert && (
    <Box>
        <Text
            fontSize="xs"
            color="#F5F5F580"
            fontWeight="medium"
            mb={2}
            textTransform="uppercase"
            letterSpacing="wide"
        >
            Attention
        </Text>
        <StatusCard
            icon={AlertTriangle}
            iconColor="yellow.400"
            title="LTV rising"
            subtitle={`Now at ${currentLTV.toFixed(1)}% of ${liquidationLTV.toFixed(1)}% max. Consider repaying.`}
            subtitleHighlight={`${currentLTV.toFixed(1)}%`}
            highlightColor="yellow.400"
            onClick={() => setIsRepayModalOpen(true)}
        />
    </Box>
)}
```

### 4c. Hook for Liquidation Alert State

```tsx
// In components/DittoSpeechBox/hooks/useLiquidationAlert.ts

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import useWallet from '@/hooks/useWallet'
import useVaultSummary from '@/components/Mint/hooks/useVaultSummary'

const LTV_WARNING_RATIO = 0.75  // 75% of liquidation LTV
const LTV_DANGER_RATIO = 0.90   // 90% of liquidation LTV

export const useLiquidationAlert = () => {
    const { address } = useWallet()
    const { data: vaultSummary } = useVaultSummary({ positionNumber: 1 })

    return useMemo(() => {
        if (!address || !vaultSummary) {
            return {
                showDangerAlert: false,
                showWarningAlert: false,
                currentLTV: 0,
                liquidationLTV: 0,
                ltvRatio: 0,
            }
        }

        const currentLTV = vaultSummary.ltv || 0
        const liquidationLTV = vaultSummary.liqudationLTV || 0

        // No alert if no debt or no liquidation threshold
        if (currentLTV <= 0 || liquidationLTV <= 0) {
            return {
                showDangerAlert: false,
                showWarningAlert: false,
                currentLTV,
                liquidationLTV,
                ltvRatio: 0,
            }
        }

        const ltvRatio = currentLTV / liquidationLTV

        return {
            showDangerAlert: ltvRatio >= LTV_DANGER_RATIO,
            showWarningAlert: ltvRatio >= LTV_WARNING_RATIO,
            currentLTV,
            liquidationLTV,
            ltvRatio,
        }
    }, [address, vaultSummary])
}
```

### 4d. Global Alert Integration (add to `dittoMessages.ts`)

```tsx
// Add to the globalAlerts array in config/dittoMessages.ts

export const globalAlerts: DittoMessage[] = [
    // ... existing alerts ...

    {
        id: 'global-liquidation-danger',
        type: 'ALERT',
        severity: 'danger',
        body: 'Position near liquidation \u2014 repay debt or add collateral immediately',
        when: 'hasDebt && ltvRatio >= 90',
        cooldownSec: 120,
        showAs: 'toast',
        blocks: ['mint', 'loop'],
    },
    {
        id: 'global-liquidation-warning',
        type: 'ALERT',
        severity: 'warn',
        body: 'LTV elevated \u2014 monitor your position or consider repaying',
        when: 'hasDebt && ltvRatio >= 75 && ltvRatio < 90',
        cooldownSec: 600,
        showAs: 'toast',
    },
]
```

---

## 5. Threshold and Trigger Conditions

### LTV Ratio Calculation

The "LTV ratio" used for thresholds is the user's **current LTV as a percentage of their liquidation LTV**, not the raw LTV itself. This is crucial because different collateral compositions have different liquidation LTVs.

```
ltvRatio = (currentLTV / liquidationLTV) * 100
```

Where:
- `currentLTV` comes from `vaultSummary.ltv` (computed by `calculateVaultSummary` in `/Users/EBmic/membrane-app/services/cdp.ts`)
- `liquidationLTV` comes from `vaultSummary.liqudationLTV` (note: the existing codebase uses the typo `liqudationLTV` -- maintain this for compatibility)

### Threshold Tiers

| Tier | ltvRatio | Severity | Cooldown | Display | Blocks Actions |
|------|----------|----------|----------|---------|----------------|
| Safe | < 75% | None | -- | -- | No |
| Warning | 75-89% | `warn` | 600s (10 min) | Toast | No |
| Danger | 90-94% | `danger` | 120s (2 min) | Toast | Yes (`mint`, `loop`) |
| Critical | >= 95% | `danger` | 60s (1 min) | Toast (persistent) | Yes (`mint`, `loop`, `swap`) |

### Why these specific thresholds:

- **75% warning:** Gives the user meaningful advance notice. At 75% of liquidation LTV, there is still a 25% buffer before liquidation. This matches the `riskWarning: 70` threshold already in `portfolioContract.ts` (similar concept).
- **90% danger:** At this point, a 10% adverse price move could trigger liquidation. This matches the `riskDanger: 85` pattern in portfolioContract but is tighter because liquidation has direct financial consequences.
- **95% critical (optional escalation):** For extremely close calls, reduce cooldown to 60 seconds and consider making the toast persistent (not auto-dismissing).

### Trigger Events

The message should be re-evaluated on:
1. `DATA_CHANGED` -- when oracle prices update (every 30s based on the existing `refetchInterval` in query configs)
2. `TX_CONFIRMED` -- after any mint/borrow/deposit/withdraw transaction that changes the LTV
3. `PAGE_ENTER` -- when user navigates to the mint page or portfolio page

These events are already defined in the `DittoEvent` type in the contract system.

---

## 6. When NOT to Show the Message

### Do not show the liquidation warning when:

1. **User has no position / no debt:**
   - `when` condition requires `hasDebt` to be true
   - If `currentLTV <= 0` or `liquidationLTV <= 0`, no alert

2. **Wallet is not connected:**
   - Cannot determine LTV without on-chain position data
   - The existing `global-wallet-disconnected` alert takes priority

3. **User is mid-transaction (LOCKED state):**
   - Per the Ditto activation state machine, when the user is in `LOCKED` state (actively submitting a repay or deposit transaction), suppress proactive toasts
   - The `blocks` field prevents the system from showing both a liquidation warning AND processing a mint action simultaneously

4. **Message is on cooldown:**
   - The `cooldownSec` values prevent alert fatigue
   - Warning: 10-minute cooldown between re-displays
   - Danger: 2-minute cooldown (shorter because it is urgent)
   - Per `DEFAULT_DITTO_CONFIG.sameMessageCooldownSec`, the same message will not repeat within its cooldown window "unless severity increases" -- so if a user goes from warning to danger, the danger alert fires immediately even if the warning was just shown

5. **User just completed a repay/deposit:**
   - After a `TX_CONFIRMED` event for repay or deposit, the LTV will naturally decrease
   - Show the `txAcknowledgement` for the repay/deposit instead
   - Re-evaluate after the acknowledgment dismisses

6. **Data is stale or loading:**
   - If `vaultSummary` is undefined or loading, do not show
   - Do not show based on cached/stale data if the query is in error state

7. **LTV is decreasing (trending safe):**
   - Optional: If you track LTV delta (as the contract system supports with `_changed` and `_delta` suffixes), consider suppressing the warning if LTV is actively decreasing (e.g., collateral price is recovering). This prevents an alert that would be resolved by the time the user acts on it.

8. **Mock data mode in development:**
   - The `NeutronMint` component has `USE_MOCK_DATA` for development. The alert hook should respect this and either suppress or clearly indicate mock state.

---

## Summary

The liquidation warning uses the established Ditto contract system's highest-priority combination (`ALERT` + `danger`) with a two-tier approach (warn at 75%, danger at 90% of liquidation LTV). It displays as a proactive toast near Ditto and as a StatusCard in the panel, uses `SEMANTIC_COLORS.danger` (red) and `SEMANTIC_COLORS.warning` (yellow) for styling, and follows all existing patterns from `portfolioContract.ts`, `transmuterContract.ts`, and the `StatusTab.tsx` component. The message is suppressed when there is no debt, no wallet, the user is mid-transaction, or the alert is on cooldown.
