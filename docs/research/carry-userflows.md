# Carry-Trader Desires → Userflows — Audit and Repositioning Map

**Date:** 2026-09-06 · **Method:** full link/CTA graph of the app measured from source
(every NextLink/router.push/href, file:line-cited in the underlying scan), crossed
against the desire inventory our own research supports (route corpus, flows corpus,
worst-carry memo, Photo-Finish/GTM memories). **Premise (owner):** every page needs
marketing; a desire elicits the click; the click must land on a flow. A tool that
sits on no flow is invisible regardless of quality.

---

## 1. The flow graph as it actually is

```
ENTRY   /  ──307──►  Evidence (landing)
                       │
                       └── ZERO outbound links. The front door is a dead end.
                           SEO + og frame the borrower/liquidation story.

ISLAND A (carry analysis)          ISLAND B (carry decision)
  Strats ──?address──► Radar         Carry ──► Calculator · Simulator · Builder · Earn
  (works, both top-level nav)        Hero ──► /borrow    Ladder ──► /builder
  Radar: no outbound edges           reachable ONLY from the "Coming soon" dropdown
  Receipts: no outbound edges        no primary surface links into /carry — not one

  NO EDGE exists between Island A and Island B, in either direction.

DEAD ENDS (finish reading → nowhere to go but the nav bar):
  Evidence · Radar · Receipts · Defend · MembraneDashboard · Simulator (copy-link only)

SEO: carry tools (Radar/Strats/Receipts/Carry/Simulator/Builder) are ALL noindex;
the sitemap sells /borrow, /mint, /stake — the borrower funnel.
```

---

## 2. The desire inventory — what actually makes a carry trader click

Each desire, the marketing artifact that elicits it (all exist today), and where the
click SHOULD land:

| # | Desire (in their words) | Eliciting artifact (ours) | Should land on | Lands today |
|---|---|---|---|---|
| D1 | "Where's the best stable yield, really?" | route-table facts (11.53% thin vs 3.44% deep), crossing-chart screenshots | **/carry** (boards + crossing chart) | Evidence, then a dropdown hunt |
| D2 | "Can I actually get OUT of venue X?" | weather cards, saturation facts, alarm screenshots | **/radar** or a venue page | /radar ✓ (top-level) — but nothing routes there from the landing |
| D3 | "I saw a scary headline about X" | venue-log entries (Ethena 7d→1d), news rows | a **per-venue page** (dossier + log + news + alarms) | nowhere — that content is Carry §06–07, and no venue permalink exists |
| D4 | "I want to size in / lever up" | crossing chart, exit-size check, ladder | **/carry** hero → ladder → borrow | same dropdown burial |
| D5 | "I called it — look" | receipt cards, radar share cards | **/receipts**, /radar | ✓ top-level — but nothing INVITES the call (Radar never offers "think it holds? call it") |
| D6 | "What are the whales doing?" | strats screenshots ($710M dual-caution, $244M exposed) | **/strats** | ✓ top-level, → Radar works |

The asymmetry in one sentence: **the marketing sells D1–D6, all carry desires; the
front door and the SEO sell the borrower story; and the page serving D1/D4 — the
highest-volume desires — is filed under "Coming soon."**

## 3. Per-desire flow traces (and where each breaks)

**D1 yield-hunter** (the biggest inbound): tweet cites 11.53%-vs-3.44% → visitor
arrives at `/` → Evidence tells a liquidation-counterfactual story with no exit
links → the yield content they came for is 2 clicks away behind a menu that says
it doesn't exist yet. *Break: landing mismatch + burial.*

**D2 exit-anxiety**: weather card ("sUSDS served 7.2x its size") → wants to check
their own venue/size → /radar serves this perfectly IF they find the nav item —
no surface points at it, and after the verdict Radar offers no next step (no "see
the whole board", no "call it", no venue detail). *Break: no inbound route, dead
end outbound.*

**D3 event-driven** (spikes exactly when news breaks — the highest-intent visitor
we get): headline screenshot → wants "what does Membrane know about Ethena right
now" → there is NO page for a venue. Log/news/alarms live un-linkable inside
Carry sections. *Break: the content exists, the URL doesn't.*

**D4 sizer**: crossing chart screenshot → wants the interactive version → same
burial as D1; once found, the flow through hero → ladder → borrow/builder is
genuinely good (Island B's internal wiring is the best in the app). *Break: door.*

**D5 status-seeker**: scored receipt in the feed → /receipts works standalone ✓ —
but the moment of highest conversion (a Radar verdict on YOUR venue) never offers
the call. Receipts also dead-ends (a scored HIT should point at strats/carry: "now
see what the big books do"). *Break: no invitation at the hot moment.*

**D6 whale-watcher**: strats screenshot → /strats ✓ → row → Radar ✓. The one
complete flow. It ends at Radar's dead end like everything else.

## 4. Misfit table — tools off their flow

| Tool | Serves | Sits | Why off-flow | Reposition |
|---|---|---|---|---|
| **Carry page** | D1, D4 (the core desires) | "Coming soon" dropdown | zero inbound edges from primary surfaces | promote to top-level nav; make it D1's landing |
| **Evidence** | borrower trust story | `/` (the front door) | dead end + wrong desire for the carry marketing | keep as trust artifact; add a 3-door desire router (below) — *landing changes are owner-gated* |
| **Venue log + news + alarms** | D3 | unlinkable Carry sections | no venue permalink to market against headlines | new `/venue/[name]` page assembling dossier + log + news + alarms + weather card |
| **Radar** | D2 | top-level ✓ | dead-ends; never invites the receipt or the board | add outbound: "call it" → Receipts, "the board" → Carry, venue names → venue pages |
| **Receipts** | D5 | top-level ✓ | never offered at the hot moment; dead-ends | CTA on Radar verdicts; scored-receipt → Strats link |
| **Simulator/Defend/Dashboard** | borrower depth | top-level | dead-ends (lower priority — not carry flow) | next-step CTAs when touched |
| **SEO layer** | discovery | noindex on every carry tool | D1–D3 searches can't land here at all | owner decision: index Carry + venue pages (they're content-rich and provenance-stamped) |

## 5. The repositioning program (ranked, cheapest first)

1. **Bridge the islands** (pure additions, no removals, no owner gate):
   Radar → {call it → /receipts · the board → /carry · venue → /venue/x};
   Carry venue rows → {scan your exposure → /radar}; Receipts scored → /strats;
   Strats header → /carry. Kills four dead ends.
2. **Promote Carry out of "Coming soon"** to top-level nav (it is the product the
   marketing sells; a menu named Coming-soon is anti-marketing for a live page).
   Width: swap Calculator down into Carry's toolkit row (already linked there).
3. **Venue permalinks** `/venue/[name]`: dossier + log + news + alarms + latest
   weather numbers on one URL. This is the D3 landing and the single most
   marketable page type we can mint — every headline about a venue becomes our
   distribution moment.
4. **Evidence desire-router**: one strip under the ForecastGate — three doors
   ("check a venue's exit" → Radar · "find the spread" → Carry · "watch the big
   books" → Strats). Keeps Evidence as the trust story; stops it being a dead end.
   *Owner-gated (landing).*
5. **SEO flip for carry surfaces**: index /carry + venue pages; leave app-state
   tools (radar results) noindex. *Owner-gated (public posture).*

Rule for every future page, so this audit doesn't rot: **a page ships with (a) the
desire it serves named in one sentence, (b) the artifact that elicits the click,
and (c) its inbound and outbound edges wired.** No orphans, no dead ends.

## 6. Non-findings

- The Strats→Radar deep-link works as designed (`?address=` seeding verified).
- Island B's internal flow (Carry→Ladder→Builder→Borrow) is well-wired; the
  problem is the door, not the interior.
- No first-visit route gate exists on this branch — the old RouteGuard ("Rites")
  was deleted in the EVM migration; an inert `appState.intendedRoute` read in
  CyberpunkHome is its only vestige (cleanup candidate, not a flow blocker).
