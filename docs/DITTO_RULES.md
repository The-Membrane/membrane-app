# Ditto Rules & Standards

> **Canonical reference for Ditto's behavior across the app.**
> This document defines Ditto's purpose, voice, state machine, and page contract schema.

---

## Section A: Global Charter

### Purpose

Ditto is a **state-aware interpreter + shortcut layer** that:

- Explains **why something matters** for this user
- Explains **why an action is blocked/disabled**
- Surfaces **state change notifications** (rare, high-signal)
- Offers **optional shortcuts** (only on user intent)

### What Ditto IS NOT

- ❌ A second UI / dashboard
- ❌ A tutorial narrator
- ❌ A CTA replacement
- ❌ A metrics display (numbers belong in the UI)

### Voice Guidelines

| Attribute | Rule |
|-----------|------|
| **Tone** | Calm, compact, slightly playful, never salesy |
| **Length** | Default 1 line; max 2 lines; only DANGER alerts can be 3 lines |
| **Structure** | "What changed / what it means / what you can do (optional)" |
| **Language** | Implication-oriented; no jargon unless the UI already uses it |
| **Forbidden** | No greetings, no "FYI", no "as an AI", no emojis |

### Hard Rules Checklist

Ditto must **NEVER**:

- [ ] Repeat numbers already visible in the current viewport (unless adding meaning like delta/trend/risk)
- [ ] Explain UI controls ("this slider does X") — that belongs to tooltips/docs
- [ ] Interrupt a user mid-action (dragging slider, typing, signing tx)
- [ ] Cover or compete with the primary CTA
- [ ] Speak on page load unless there's an alert-worthy condition
- [ ] Show more than one proactive message at a time

---

## Section B: Message Types & Priority

### Allowed Message Types (Only 4)

| Type | Description | Trigger | Display |
|------|-------------|---------|---------|
| **ALERT** | Safety/risk/blocked action; highest priority | Proactive | Toast |
| **UPDATE** | Meaningful state change since last check | Proactive | Badge |
| **INSIGHT** | Interpretation of current state | User opens Ditto | Panel |
| **SHORTCUT** | One-tap actions | User opens Ditto | Panel |

### Priority Ladder

```
ALERT > UPDATE > (user-opened) INSIGHT > (user-opened) SHORTCUT
```

### Severity Levels

| Severity | Use Case | Styling |
|----------|----------|---------|
| `danger` | Critical/blocking issues, high risk | Red accent |
| `warn` | Caution/attention needed | Yellow/orange accent |
| `info` | Neutral information | Cyan/blue accent |

### Display Surfaces

| Surface | Behavior |
|---------|----------|
| `toast` | Non-blocking message near Ditto, auto-dismisses after 5s |
| `badge` | Dot/number indicator on Ditto avatar |
| `panel` | Shown inside Ditto when user opens it |

---

## Section C: Global State Machine

### States

| State | Description |
|-------|-------------|
| `DORMANT` | Collapsed, no badge, no message |
| `IDLE` | Collapsed, can be opened, no proactive message |
| `BADGED` | Collapsed with badge indicating something new |
| `OPEN` | Expanded panel (user opened) |
| `PROACTIVE_TOAST` | Brief toast near Ditto (non-blocking) |
| `LOCKED` | Temporarily suppressed (user mid-action) |

### Events

| Event | Trigger |
|-------|---------|
| `PAGE_ENTER` | User navigates to a new page |
| `USER_OPEN` | User clicks on Ditto |
| `USER_CLOSE` | User closes Ditto panel |
| `USER_INTERACTING` | User is dragging, typing, or signing |
| `USER_IDLE` | No interaction for N seconds |
| `DATA_CHANGED` | Market/user/position state changed |
| `RISK_THRESHOLD_CROSSED` | Risk metric exceeded threshold |
| `ACTION_BLOCKED` | User tries disabled action |
| `TX_PENDING` | Transaction submitted |
| `TX_CONFIRMED` | Transaction confirmed |
| `TX_FAILED` | Transaction failed |
| `DISMISS` | User dismisses message |

### Transition Table

| From State | Event | To State | Guard |
|------------|-------|----------|-------|
| `*` | `USER_INTERACTING` | `LOCKED` | — |
| `LOCKED` | `USER_IDLE` | `IDLE` or `BADGED` | Return to prior state |
| `DORMANT` | `PAGE_ENTER` | `IDLE` | — |
| `IDLE` | `USER_OPEN` | `OPEN` | — |
| `IDLE` | `DATA_CHANGED` | `BADGED` | If significant change |
| `IDLE` | `RISK_THRESHOLD_CROSSED` | `PROACTIVE_TOAST` | Not in cooldown |
| `IDLE` | `ACTION_BLOCKED` | `PROACTIVE_TOAST` | Not in cooldown |
| `BADGED` | `USER_OPEN` | `OPEN` | — |
| `OPEN` | `USER_CLOSE` | `IDLE` | — |
| `PROACTIVE_TOAST` | `DISMISS` | `IDLE` | — |
| `PROACTIVE_TOAST` | (auto) | `BADGED` | If still relevant |

### Guards

All proactive emissions must pass:

1. Not in `LOCKED` state
2. Not within cooldown window
3. Not a duplicate of last shown message (unless severity increased)

---

## Section D: Page Contract Schema

### TypeScript Interface

```typescript
type DittoSeverity = "info" | "warn" | "danger"
type DittoMessageType = "ALERT" | "UPDATE" | "INSIGHT" | "SHORTCUT"
type DittoShowAs = "toast" | "badge" | "panel"

interface DittoMessage {
  id: string                  // Stable key for cooldown/dedupe
  type: DittoMessageType
  severity: DittoSeverity
  title?: string              // Optional, keep short
  body: string                // 1-2 lines (3 max for ALERT danger)
  when: string                // Boolean expression over page facts
  cooldownSec: number         // Per-message cooldown
  showAs: DittoShowAs         // Preferred surface
  blocks?: string[]           // Actions this explains (optional)
}

interface DittoShortcut {
  id: string
  label: string               // Short verb phrase
  when: string                // Availability condition
  action: string              // App action identifier
}

interface DittoPageContract {
  pageId: string
  facts: Record<string, string>    // name -> description
  messages: DittoMessage[]
  shortcuts: DittoShortcut[]
  thresholds?: Record<string, number>
}
```

### How to Create a New Page Contract

1. **Define Facts**: List all state values the page can provide
2. **Define Thresholds**: Set numeric boundaries for conditions
3. **Create Messages**: At minimum:
   - 2-3 ALERTs (blocked actions, risk warnings)
   - 1-2 UPDATEs (significant state changes)
   - 2-3 INSIGHTs (interpretations shown in panel)
4. **Create Shortcuts**: Optional one-tap actions
5. **Export Contract**: Place in `contracts/{pageName}Contract.ts`

### Condition Expression Syntax

The `when` field uses a simple expression syntax:

```javascript
// Simple facts
"hasDeposit"                          // truthy check
"!hasDeposit"                         // falsy check

// Comparisons
"riskScore >= 85"                     // numeric comparison
"loopCapacity < capacityRequired"     // cross-fact comparison

// Thresholds
"riskScore >= thresholds.riskDanger"  // reference threshold

// Compound
"hasDeposit && currentLoop != targetLoop"

// Change detection (for UPDATEs)
"baseAPR.changed && Math.abs(baseAPR.delta) > 0.5"
```

### Body Interpolation

Use `{factName}` to insert values:

```javascript
body: "Position at {riskScore}% risk — reduce loop or add collateral"
```

---

## Section E: Anti-Annoyance Rules

### Frequency Limits

| Rule | Value | Configurable |
|------|-------|--------------|
| Max proactive messages per page | 1 per 90 seconds | Yes |
| Same message cooldown | 10 minutes | Yes |
| Toast auto-dismiss | 5 seconds | Yes |
| Idle timeout (LOCKED → prior) | 3 seconds | Yes |

### Cooldown Bypass

A message can bypass cooldown if:
- Its severity has **increased** since last shown
- User explicitly requested it (clicked "Why disabled?")

### Duplicate Detection

Messages are considered duplicates if:
- Same `id`
- Shown within cooldown window
- Severity has not increased

---

## Section F: LLM Prompt Template

Use this prompt to generate page contracts:

```
You are designing "Ditto", a companion system for a DeFi app. Your output must 
standardize Ditto across the entire app and be reusable by other engineers and LLMs.

GLOBAL CHARTER (must follow):
- Ditto is state-aware interpretation + shortcut layer, not a second dashboard, 
  not a tutorial narrator, not a CTA replacement.
- Ditto explains "why" (implication, meaning, blocking reasons), not "how" 
  (mechanics/UI controls).
- Ditto message types allowed: ALERT, UPDATE, INSIGHT, SHORTCUT. No other types.
- Priority: ALERT > UPDATE > (user-opened) INSIGHT > (user-opened) SHORTCUT.
- Proactive message rules: never on page load unless alert-worthy; max 1 proactive 
  per 90s; no repeats within 10 minutes unless severity increased; never interrupt 
  while user is interacting (dragging/typing/tx signing).
- Never repeat visible stats unless adding meaning (delta/trend/risk). 
  Never compete with primary CTA.

VOICE:
- Calm, compact, slightly playful, never salesy.
- Default 1 line, max 2 lines (3 only for danger alerts).
- No greetings, no fluff.

TASK:
Generate a DittoPageContract for the "{PAGE_NAME}" page with:

Facts available:
{LIST_OF_FACTS}

Required messages:
- At least 3 ALERTs (blocked actions, risk thresholds, insufficient capacity)
- At least 2 UPDATEs (state changes) shown as BADGE by default
- At least 3 INSIGHTs (interpretations of state)

Required shortcuts:
- At least 2 shortcuts relevant to the page

OUTPUT FORMAT:
Provide a TypeScript export following the DittoPageContract interface.
```

### Example Usage

```
TASK:
Generate a DittoPageContract for the "Disco" page with:

Facts available:
- hasDeposits: boolean
- totalMBRN: number
- pendingRewards: number
- lockDuration: number
- boostMultiplier: number
- lockExpiry: timestamp
- isClaimable: boolean
```

---

## Quick Reference Card

### Do's

✅ Explain why an action is blocked
✅ Surface meaningful state changes
✅ Provide shortcuts on user request
✅ Use LOCKED state during interactions
✅ Respect cooldown windows

### Don'ts

❌ Repeat visible stats
❌ Explain how UI works
❌ Interrupt mid-action
❌ Compete with CTAs
❌ Show messages on page load (unless critical)
❌ Show multiple proactive messages

---

## Page Contract Locations

| Page | Contract File |
|------|---------------|
| Manic | `contracts/manicContract.ts` |
| Disco | `contracts/discoContract.ts` |
| Transmuter | `contracts/transmuterContract.ts` |
| Portfolio | `contracts/portfolioContract.ts` |

---

*Last updated: January 2026*









