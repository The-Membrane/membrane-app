# UNKNOWN-STATE CONVENTION

Companion to `STATE-MATRIX.md` (which states the problem) and `FINDINGS.md` (which
observed it running). This file is the **proposed answer** — a convention to react
to, not an essay. It is short on purpose.

Status: **proposal**. The two money-consequence rules (§4 R1, R2) are already
implemented because they are wrong regardless of styling. Everything visual in §3
is a suggestion the owner can restyle without reopening §4.

---

## 1. The principle

> **A value whose source has not verified must never render as a number, a health
> state, or a success.** It renders as an explicit unknown, and any action that
> depends on it is blocked or clearly marked estimated.

Three corollaries, in the order they get violated:

1. **Unknown ≠ zero.** `|| 0` and `?? 0` are only legal when zero is a *fact the
   source returned*. If the source did not answer, the value is `null`, not `0`.
2. **Unknown ≠ safe.** A fallback in a lending UI must never point toward
   reassurance. `health = 100`, green "0 at risk", and `$1.00` are all the same
   bug: absence of data rendered as good news.
3. **Unknown ≠ done.** A transaction whose receipt says `status: 'reverted'` is a
   failure, not a success with different copy.

---

## 2. The gap is on the READ path only

Worth stating plainly, because the app is not undisciplined — it is
*asymmetrically* disciplined.

The **write path already has a convention** and follows it consistently:
`isError` is consumed for tx simulation at `components/NeutronMint/DepositModal.tsx:74`
(disables the CTA) and `:119-120` (passes the error and its message down for
inline red copy), and identically at `components/NeutronMint/BorrowModalControls.tsx:199`.
`components/TxError.tsx` covers the legacy surfaces. A failed simulation is
visible, blocks the action, and explains itself.

The **read path has no convention at all.** Per STATE-MATRIX §2A, the `error`
column is uniformly ❌ across all 14 surfaces; `components/RPCStatus.tsx` is the
lone exception and it is infrastructure, not per-surface. So this document adds
nothing to writes. It is entirely about reads, and it should be read as
*extending the existing write-path discipline to reads*, not as a new idea.

---

## 3. The visual vocabulary — four states, defined once

Four states, four treatments. A component with only two branches (data / not-data)
is by definition missing at least two of these.

| state | means | renders as | colour | action that depends on it |
|---|---|---|---|---|
| **UNKNOWN** | source has not answered, or answered with an error | `—` in the value's own slot, same width, no unit, no `$`, no `%` | muted (`whiteAlpha.500`) — **never green, never red** | **blocked**, with the reason stated |
| **STALE** | source answered, but the answer is older than this surface tolerates | the last known value, dimmed, with a relative age (`2m ago`) | value keeps its colour at reduced opacity | allowed, marked *estimated* |
| **FAILED** | a *specific* read or write failed and can be retried | inline card in the section's own footprint, keeps the heading | error tone | blocked, with **Retry** |
| **EMPTY** | source answered successfully and there is genuinely nothing | one sentence: *what is missing · why · what to do next* | neutral | n/a — usually offers the action that fills it |

Three rules that make the table enforceable:

- **`—` is the sentinel.** One glyph, everywhere. Not `0`, not `N/A`, not `$0.00`,
  not `Coming Soon`. If a number cannot be computed, its slot shows `—` and keeps
  its layout box so the page does not reflow when it resolves.
- **Green must be earned.** A safe/success colour may only be applied to a
  *resolved, successful* query. Unknown is muted, never reassuring. (This alone
  fixes STATE-MATRIX U2 and U9.)
- **Never collapse pending, failed, and empty into one branch.** Use the query's
  own `isPending` / `isError` / `isSuccess` flags. Do not infer state from
  `array.length === 0` — that expression is true in all three.

### Loading is a fifth, subordinate state

PENDING renders as a skeleton in the value's box (never as prose that promises
progress — "Loading available collateral…" is a lie the moment the read fails).
PENDING is allowed to become UNKNOWN or FAILED on a timeout; it is never allowed
to be permanent.

---

## 4. The rules, ranked by consequence

**R1 — A reverted receipt is an error.** (money) If
`receipt.status !== 'success'`, throw. Never run success choreography — no
success toast, no `onSuccess()`, no modal close, no form reset. The user paid gas
and their position did not change; the UI must say so.

**R2 — A missing price blocks the action that spends it.** (money) A price of
`0`, `undefined`, or `NaN` is UNKNOWN, not `$1` and not `$0`. USD figures derived
from it render `—`, and the CTA that would transact at that price is disabled
with the reason stated. `$1` is the worst possible fallback in a CDP app: it is
peg-shaped, plausible, and unreviewable.

**R3 — Risk fallbacks point at risk, not away from it.** When health, LTV, or
liquidation-LTV inputs are unknown, `health` is `null` (rendered `—`, muted, ring
suppressed) — never `100`. If a design later prefers "fail loud" it may render
red; it may never render safe.

**R4 — Infrastructure failure invalidates the numbers underneath it.** An RPC
that cannot be reached means every value sourced from it is UNKNOWN. The health
probe must detect death in seconds, not a minute, and must offer a manual retry.

**R5 — Three branches minimum.** Any component rendering a query gets PENDING,
FAILED, and EMPTY as distinct branches, keyed off query flags.

**R6 — Product copy is not a fallback.** "Coming Soon", "No deposits found",
"Full", "0 at risk" are *claims*. They may only render from a resolved,
successful query.

---

## 5. Applying it — the shape of a fix

```ts
// before — unknown collapses into a confident number
const price  = pricesByDenom.get(denom) || 0
const health = liqLTV > 0 ? 100 - (ltv / liqLTV) * 100 : 100

// after — unknown is a value
const price: number | null  = resolved ? p : null
const health: number | null = liqLTV > 0 ? 100 - (ltv / liqLTV) * 100 : null
```

Then at the render site, `null` takes the `—` branch and any CTA guarded by that
value is disabled. The type change is what makes the rule enforceable: `number |
null` will not silently flow into `.toFixed()`.

---

## 6. Scope note

This convention governs the **read** path. It does not restyle the write path,
which already works (§2). It also does not attempt to settle STATE-MATRIX P1
(wallet gating), P5 (mock gating), P6 (empty-state voice) or P7 (over-max input)
— those are adjacent decisions with their own tradeoffs, and pretending one
document answers all of them would make it too big to react to.
