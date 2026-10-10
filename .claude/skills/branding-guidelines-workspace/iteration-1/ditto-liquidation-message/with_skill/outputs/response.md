# Ditto Liquidation Warning Message -- Complete Implementation Guide

## 1. Message Type Selection and Rationale

This scenario requires **two** Ditto message types working in tandem, plus a supporting INSIGHT for users who open the panel:

### Primary: ALERT (type `'ALERT'`)

Liquidation proximity is a **safety/risk** concern -- the highest priority category in the Ditto system. Per the character guide, ALERTs are "proactive (auto-shown)" and display as toasts. This is the correct type because:

- The user may not be looking at the position when prices move against them.
- Ditto's role is to surface risk *before* it becomes a loss, not after.
- ALERTs are the only type allowed to interrupt passively (via toast) without user interaction.
- ALERTs have the highest priority score (`MESSAGE_TYPE_PRIORITY.ALERT = 100`), meaning they supersede any pending UPDATE or INSIGHT.

You need **two** ALERT tiers -- a warning (early) and a critical (urgent) -- because a single threshold either fires too early (annoying) or too late (useless).

### Secondary: INSIGHT (type `'INSIGHT'`)

When the user opens Ditto's panel while their position is in the warning zone, they should see contextual guidance. INSIGHTs are "interpretation of current state" messages shown on `panel` -- perfect for explaining *what to do* when the user is already engaged.

### Not applicable: UPDATE or SHORTCUT alone

UPDATE (badge) is too passive for imminent liquidation -- users might not click Ditto for hours. A SHORTCUT should accompany the INSIGHT (covered below), but it is not the message itself.

---

## 2. Exact Message Text

All messages follow the Ditto voice contract: calm, compact, implication-oriented, no greetings, no emojis, no jargon the UI does not already use.

### ALERT -- Warning tier (severity: `warn`)

```
Collateral at {currentLTV}% LTV -- liquidation starts at {liquidationLTV}%
```

**Why this wording:**
- Leads with the fact ("Collateral at X% LTV"), which the user can immediately parse.
- Follows with the implication ("liquidation starts at Y%"), giving them the boundary without needing to check the UI.
- Uses an em-dash for the characteristic Ditto cadence.
- One line. No fluff.

### ALERT -- Critical tier (severity: `danger`)

```
Liquidation imminent at {currentLTV}% LTV -- repay debt or add collateral now
```

**Why this wording:**
- "Imminent" conveys urgency without panic.
- Provides two concrete actions ("repay debt or add collateral"), satisfying the "what you can do" part of the Ditto message structure.
- Still two lines max (it reads as one visual line in a toast at typical widths).
- The word "now" adds time pressure without exclamation marks.

### INSIGHT -- Panel context (severity: `warn`)

```
Position {currentLTV - liquidationLTV}% from liquidation -- consider reducing debt or depositing more collateral
```

**Why this wording:**
- Gives a computed delta (the gap between current LTV and liquidation LTV), which is the number the user actually cares about.
- "Consider" is softer than "now" because this shows when the user is already engaged (they opened Ditto).
- Two lines maximum.

---

## 3. Severity, Styling, and Display Surface

### Warning tier

| Property | Value | Reasoning |
|----------|-------|-----------|
| **severity** | `'warn'` | Approaching limit, not yet critical |
| **accent color** | `#fbbf24` (SEMANTIC_COLORS.warning / yellow) | Standard warning state per brand system |
| **toast border** | `1px solid rgba(251, 191, 36, 0.4)` | Yellow glow at low opacity against dark bg |
| **toast shadow** | `0 0 12px rgba(251, 191, 36, 0.15)` | Subtle yellow glow, visible on `#091326` |
| **text color** | `rgb(229, 222, 223)` (SEMANTIC_COLORS.textPrimary) | Standard readable text |
| **display surface** | `'toast'` | Proactive, auto-shown near Ditto avatar |
| **auto-dismiss** | 5 seconds | Per Ditto anti-annoyance spec |

### Critical tier

| Property | Value | Reasoning |
|----------|-------|-----------|
| **severity** | `'danger'` | Critical/blocking, high risk |
| **accent color** | `#ef4444` (SEMANTIC_COLORS.danger / red) | Standard danger state per brand system |
| **toast border** | `1px solid rgba(239, 68, 68, 0.5)` | Red glow, slightly more opaque than warning |
| **toast shadow** | `0 0 16px rgba(239, 68, 68, 0.25)` | Stronger red glow for urgency |
| **text color** | `rgb(229, 222, 223)` (SEMANTIC_COLORS.textPrimary) | Same readable text (do NOT use red text) |
| **display surface** | `'toast'` | Proactive, auto-shown |
| **auto-dismiss** | 5 seconds | Standard, but this also triggers a badge so user can re-read |

### Insight (panel)

| Property | Value | Reasoning |
|----------|-------|-----------|
| **severity** | `'warn'` | Context matches warning state |
| **accent color** | `#fbbf24` | Consistent with warning tier |
| **display surface** | `'panel'` | Shown when user opens Ditto |

### Ditto Character Theme

The liquidation warning applies to the **Mint/CDP page** (NeutronMint). This page does not yet have a dedicated Ditto theme, so it should use the **default** theme:

- Image: `ditto.svg`
- Glow: `rgba(105, 67, 255, 0.8)`
- Accent: `#6943FF`

The toast itself uses the severity-driven accent (yellow or red), not the character glow. The character glow only applies to the panel border and avatar.

---

## 4. Code Snippet -- DittoMessage Objects

This would be added to a new page contract file at `contracts/mintContract.ts`, following the established pattern from `manicContract.ts` and `portfolioContract.ts`.

```typescript
import { DittoPageContract } from '@/components/DittoSpeechBox/types/dittoContract'

export const mintContract: DittoPageContract = {
    pageId: 'mint',

    facts: {
        // Position facts
        hasPosition: 'Whether user has a CDP position with collateral',
        currentLTV: 'Current loan-to-value ratio (%)',
        liquidationLTV: 'LTV threshold where liquidation begins (%)',
        borrowLTV: 'Maximum borrow LTV allowed (%)',
        collateralValue: 'Total collateral value in USD',
        debtValue: 'Total debt value in USD',
        ltvGap: 'Percentage gap between current LTV and liquidation LTV',

        // Price facts
        largestCollateralSymbol: 'Symbol of the largest collateral asset',
        largestCollateral24hChange: '24h price change of largest collateral asset (%)',

        // Connection
        isConnected: 'Whether wallet is connected',

        // Transaction
        txStatus: 'Transaction status: pending | confirmed | failed | idle',
    },

    thresholds: {
        ltvWarning: 75,       // Warning at 75% of liquidation LTV
        ltvCritical: 90,      // Critical at 90% of liquidation LTV
        ltvGapDanger: 5,      // Less than 5% gap to liquidation
    },

    messages: [
        // =====================
        // ALERTs (Proactive)
        // =====================
        {
            id: 'mint-liquidation-critical',
            type: 'ALERT',
            severity: 'danger',
            body: 'Liquidation imminent at {currentLTV}% LTV \u2014 repay debt or add collateral now',
            when: 'hasPosition && currentLTV >= (liquidationLTV * thresholds.ltvCritical / 100)',
            cooldownSec: 300,
            showAs: 'toast',
        },
        {
            id: 'mint-liquidation-warning',
            type: 'ALERT',
            severity: 'warn',
            body: 'Collateral at {currentLTV}% LTV \u2014 liquidation starts at {liquidationLTV}%',
            when: 'hasPosition && currentLTV >= (liquidationLTV * thresholds.ltvWarning / 100) && currentLTV < (liquidationLTV * thresholds.ltvCritical / 100)',
            cooldownSec: 600,
            showAs: 'toast',
        },

        // =====================
        // INSIGHTs (Panel)
        // =====================
        {
            id: 'mint-liquidation-insight',
            type: 'INSIGHT',
            severity: 'warn',
            body: 'Position {ltvGap}% from liquidation \u2014 consider reducing debt or depositing more collateral',
            when: 'hasPosition && currentLTV >= (liquidationLTV * thresholds.ltvWarning / 100)',
            cooldownSec: 0,
            showAs: 'panel',
        },
        {
            id: 'mint-position-healthy',
            type: 'INSIGHT',
            severity: 'info',
            body: 'Position healthy at {currentLTV}% LTV \u2014 {ltvGap}% buffer to liquidation',
            when: 'hasPosition && currentLTV < (liquidationLTV * thresholds.ltvWarning / 100)',
            cooldownSec: 0,
            showAs: 'panel',
        },
    ],

    shortcuts: [
        {
            id: 'mint-add-collateral',
            label: 'Add collateral',
            when: 'hasPosition && currentLTV >= (liquidationLTV * thresholds.ltvWarning / 100)',
            action: 'openDepositModal',
        },
        {
            id: 'mint-repay-debt',
            label: 'Repay debt',
            when: 'hasPosition && currentLTV >= (liquidationLTV * thresholds.ltvWarning / 100)',
            action: 'openRepayModal',
        },
    ],
}

export default mintContract
```

### Priority Scores (automatic via `getMessagePriority`)

| Message | Type Score | Severity Score | Total |
|---------|-----------|----------------|-------|
| `mint-liquidation-critical` | 100 (ALERT) | 100 (danger) | **200** (highest possible) |
| `mint-liquidation-warning` | 100 (ALERT) | 50 (warn) | **150** |
| `mint-liquidation-insight` | 50 (INSIGHT) | 50 (warn) | **100** |
| `mint-position-healthy` | 50 (INSIGHT) | 25 (info) | **75** |

The critical alert scores 200 -- the maximum in the system -- meaning it will always take precedence over every other Ditto message.

---

## 5. Threshold and Trigger Conditions

### How the thresholds work

Membrane CDPs have a `liquidationLTV` (e.g., 80%) that varies by collateral basket composition. Rather than hard-coding an LTV number, the warning thresholds are expressed as **percentages of the liquidation LTV**:

| Threshold | Formula | Example (liquidationLTV = 80%) |
|-----------|---------|-------------------------------|
| Warning fires | `currentLTV >= liquidationLTV * 0.75` | `currentLTV >= 60%` |
| Critical fires | `currentLTV >= liquidationLTV * 0.90` | `currentLTV >= 72%` |
| Liquidation | `currentLTV >= liquidationLTV` | `currentLTV >= 80%` |

This approach is resilient to different collateral types having different liquidation LTVs.

### Trigger events

The messages should re-evaluate on:

1. **`DATA_CHANGED`** -- When on-chain position data refreshes (price oracle updates, debt accrual).
2. **`PAGE_ENTER`** -- When user navigates to the Mint page or Portfolio page.
3. **`RISK_THRESHOLD_CROSSED`** -- Specifically, when `currentLTV` crosses either the warning or critical boundary.

The `when` condition expression handles this automatically -- the Ditto evaluation engine re-checks conditions on every fact update.

### Computing `ltvGap`

The `ltvGap` fact should be computed in the page's fact provider hook:

```typescript
const ltvGap = useMemo(() => {
    if (!liquidationLTV || !currentLTV) return 0
    return Math.max(0, Math.round((liquidationLTV - currentLTV) * 10) / 10)
}, [liquidationLTV, currentLTV])
```

This gives a clean decimal like "8.2" that interpolates into the message body.

---

## 6. Anti-Annoyance Rules

### Cooldown configuration

| Message | cooldownSec | Reasoning |
|---------|------------|-----------|
| `mint-liquidation-critical` | 300 (5 min) | Critical risk justifies more frequent alerts, but not spammy |
| `mint-liquidation-warning` | 600 (10 min) | Matches the system default `sameMessageCooldownSec` |
| `mint-liquidation-insight` | 0 | Panel content, only shown when user opens Ditto |
| `mint-position-healthy` | 0 | Panel content, always available |

### When NOT to show the message

Per the Ditto character guide's anti-annoyance rules, the liquidation messages must be suppressed in these situations:

1. **User is mid-transaction (`LOCKED` state):** If the user is already signing a repay or deposit transaction, do NOT interrupt with a toast. The state machine handles this -- any state transitions to `LOCKED` when `USER_INTERACTING` fires, and returns to previous state after 3 seconds of idle.

2. **User is typing in an input field:** The `LOCKED` state should also engage when the user has focus in the deposit amount or repay amount inputs. Showing a "liquidation imminent" toast while someone is actively typing a collateral amount is counterproductive.

3. **Within 90 seconds of another proactive message:** The global `proactiveWindowSec: 90` in `DEFAULT_DITTO_CONFIG` ensures max 1 proactive message per 90 seconds. If a capacity warning or APR update already fired, the liquidation alert queues behind it. Exception: since the critical alert has a priority score of 200, it should preempt lower-priority queued messages if implemented.

4. **Same message already shown within cooldown:** The per-message cooldown prevents repetition. The critical alert (300s) can fire again after 5 minutes if the situation persists. The warning (600s) waits 10 minutes.

5. **Position has already been liquidated:** If `currentLTV >= liquidationLTV` (i.e., liquidation has already triggered on-chain), the warning messages become stale. Consider adding a separate `mint-liquidated` ALERT of type `danger` for this case instead, and excluding it from the warning/critical conditions:
   ```
   when: 'hasPosition && currentLTV >= liquidationLTV'
   body: 'Position liquidated \u2014 check remaining collateral'
   ```

6. **No position exists:** The `hasPosition` guard in every `when` clause prevents false alerts for users who have not opened a CDP.

7. **Wallet not connected:** The `hasPosition` fact should be `false` when disconnected, so the guard inherently handles this case.

### Escalation behavior

If the same message *would* fire again but cooldown is active, and the severity has *increased* (e.g., warning upgraded to critical because LTV crossed the critical threshold), the cooldown should be bypassed. This is handled by the Ditto state machine spec: "Same message cooldown unless severity increases." The critical alert has a different `id` than the warning alert, so it is treated as a separate message with its own cooldown -- meaning crossing from warning to critical will always fire immediately regardless of the warning's cooldown state.

---

## Summary

| Aspect | Decision |
|--------|----------|
| **Message types** | 2 ALERTs (warning + critical) + 1 INSIGHT + 2 SHORTCUTs |
| **Severity levels** | `warn` (yellow, `#fbbf24`) and `danger` (red, `#ef4444`) |
| **Display surface** | Toast for ALERTs, Panel for INSIGHT |
| **Voice** | Compact, implication-oriented, actionable, no fluff |
| **Thresholds** | 75% and 90% of `liquidationLTV` (adapts per collateral basket) |
| **Cooldowns** | 5 min (critical), 10 min (warning), 0 (panel insights) |
| **Suppression** | Mid-tx, mid-input, within 90s of another proactive, already liquidated |
| **Ditto theme** | Default (purple glow); toast uses severity accent color |
| **Priority score** | 200 (critical) / 150 (warning) -- highest in the system |
| **Contract file** | `contracts/mintContract.ts` following established pattern |
