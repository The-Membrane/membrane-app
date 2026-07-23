# Ditto Character & Voice Guide

## What Ditto Is

Ditto is a **state-aware interpreter + shortcut layer** — a companion character that helps users understand what's happening with their positions and why it matters. Ditto lives in a collapsible panel alongside the main UI.

## What Ditto Is NOT

- Not a second dashboard or metrics display (numbers belong in the UI)
- Not a tutorial narrator (that's what tooltips are for)
- Not a CTA replacement (never competes with the primary action button)
- Not a chatbot — Ditto speaks on its own terms based on state, not user prompts

## Voice

| Attribute | Rule |
|-----------|------|
| **Tone** | Calm, compact, slightly playful, never salesy |
| **Length** | Default 1 line; max 2 lines; only DANGER alerts can be 3 lines |
| **Structure** | "What changed / what it means / what you can do (optional)" |
| **Language** | Implication-oriented; no jargon unless the UI already uses it |

### Forbidden Phrases

Never use:
- Greetings ("Hello!", "Welcome back!")
- "FYI" or "Just so you know"
- "As an AI" or any self-referential meta-commentary
- Emojis (exception: legacy messages may have them, don't add new ones)
- Explanations of UI controls ("Click this button to...")
- Repetitions of numbers already visible in the viewport

### Good Examples

```
"Position at 87% risk — reduce loop or add collateral"
"APR dropped 2.3% since your last visit"
"Lock expires in 4 hours — claim now or it auto-extends"
"Transmuter capacity is low — swaps may partially fill"
```

### Bad Examples

```
"Welcome to Disco! Here you can deposit assets..."  ← tutorial narration
"Your current APR is 12.5%"  ← repeating a visible number
"Click the deposit button to make a deposit"  ← explaining UI controls
"FYI, your position has been updated"  ← fluff
```

## Message Types

Only 4 types are allowed:

| Type | Purpose | Trigger | Display |
|------|---------|---------|---------|
| **ALERT** | Safety/risk/blocked action | Proactive (auto-shown) | Toast |
| **UPDATE** | Meaningful state change | Proactive (badge appears) | Badge on avatar |
| **INSIGHT** | Interpretation of current state | User opens Ditto | Panel content |
| **SHORTCUT** | One-tap actions | User opens Ditto | Panel buttons |

Priority order: ALERT > UPDATE > INSIGHT > SHORTCUT

## Severity Levels

| Level | Styling | Use Case |
|-------|---------|----------|
| `danger` | Red accent | Critical/blocking issues, high risk |
| `warn` | Yellow/orange accent | Caution, attention needed |
| `info` | Cyan/blue accent | Neutral information |

## Anti-Annoyance Rules

- Max 1 proactive message per 90 seconds
- Same message cooldown: 10 minutes
- Toast auto-dismisses after 5 seconds
- Never speak on page load unless there's a genuine alert
- Never show more than one proactive message at a time
- Never interrupt while user is interacting (dragging, typing, signing a tx)

## Character Theming — LEGACY, pending Living Typeface redesign

**Status: open question.** The app's brand direction moved to Living Typeface (bone-on-black,
phosphor, hairlines, sharp corners, no glow) — see `../SKILL.md`. Ditto's visual treatment has **not**
been redesigned to match. The table below is the current, unchanged, cyberpunk-era implementation.
Do not extend this glow/purple/rounded-corner styling to new non-Ditto components, and do not invent a
new Living-Typeface Ditto design without design sign-off — this is explicitly an open question.

Each app section currently has a uniquely styled Ditto with its own glow and hat:

| Section | Image | Glow | Accent |
|---------|-------|------|--------|
| Default | `ditto.svg` | `rgba(105, 67, 255, 0.8)` | `#6943FF` |
| Manic | `ditto-manic.png` | `rgba(59, 229, 229, 0.8)` | `#3BE5E5` |
| Disco | `ditto-disco.png` | `rgba(147, 51, 234, 0.8)` | `#9333EA` |
| Transmuter | `ditto-transmuter.png` | `rgba(34, 211, 238, 0.8)` | `#22D3EE` |
| Portfolio | `ditto-portfolio.png` | `rgba(52, 211, 153, 0.8)` | `#34D399` |
| Acquisition | `ditto-lockhead.png` | `rgba(168, 85, 247, 0.8)` | `#A855F7` |

### Panel Styling (legacy)

- Background: `#15171E`
- Border: `1px solid rgba(166, 146, 255, 0.25)` (purple accent)
- Shadow: `0 8px 32px rgba(105, 67, 255, 0.15), 0 0 0 1px rgba(105, 67, 255, 0.1)`
- Border radius: `xl`

### Speech Bubble Styling (legacy)

- Background: `#23252B`
- Border glow: Purple accent matching section theme

## State Machine

Ditto has 6 states:

| State | Description |
|-------|-------------|
| `DORMANT` | Collapsed, no badge, no message |
| `IDLE` | Collapsed, can be opened |
| `BADGED` | Collapsed with notification badge |
| `OPEN` | Panel expanded (user clicked) |
| `PROACTIVE_TOAST` | Brief toast near Ditto |
| `LOCKED` | Suppressed while user is mid-action |

Key transitions:
- Any state → `LOCKED` when user starts interacting
- `LOCKED` → previous state when user goes idle (3s timeout)
- `IDLE` → `BADGED` when meaningful data changes
- `IDLE` → `PROACTIVE_TOAST` for risk alerts (with cooldown check)

## Page Contracts

Each page defines a contract in `contracts/{pageName}Contract.ts` that specifies:
- **Facts**: State values the page provides
- **Messages**: ALERT, UPDATE, INSIGHT messages with conditions
- **Shortcuts**: One-tap actions available in the panel
- **Thresholds**: Numeric boundaries for triggering messages

The full schema and contract creation guide is in `docs/DITTO_RULES.md`.

## Creating New Ditto Content

When writing Ditto messages for new features:

1. Start with ALERTs — what can go wrong?
2. Add UPDATEs — what changes are worth notifying about?
3. Write INSIGHTs — what does the current state *mean* for the user?
4. Consider SHORTCUTs — what one-tap actions would save time?

Always test by reading messages aloud. If it sounds like a notification from a banking app, make it more casual. If it sounds like a friend texting, dial it back slightly. The sweet spot is "knowledgeable colleague who happens to be concise."
