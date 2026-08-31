# The Veteran Surface — Retention UX Ruleset

**Status:** Binding for all recurring-use surfaces (dashboard, positions, boards, terminals).
**Relationship to the Badass User ruleset:** companion, not replacement. See §1.
**Evidence base:** DeFi Llama revenue leaders + pump.fun, fwa.fun, Fomo teardowns + expert-user
research (NN/g, Carroll, Talin/AIIDE, Bloomberg, Sierra). Research date: Aug 2026. Sources in §7.

---

## 1. How the two rulesets coexist

The Badass ruleset (Kathy Sierra) makes users expert. This ruleset serves the expert they become.
They govern different clocks:

| | Badass ruleset | This ruleset |
|---|---|---|
| Governs | first contact with each mechanic | every return visit after competence |
| Optimizes | competence, calibration, attribution | speed, density, cadence |
| Text | teaches with rendered consequences | approaches zero |
| Failure mode it prevents | users who never understand | users who leave from friction and noise |

**Precedence rules — apply in this order:**

1. Badass §11 prohibitions always win, on every surface, at every user age.
   No returns-based progression. No silent rescue. No unbacked confidence figure.
2. On a surface where the user meets a mechanic for the FIRST time, the Badass ruleset wins.
3. On the hot path of a returning user, THIS ruleset wins.
4. The bridge rule that joins them: **education must decay** (§4). Text that teaches on day 1
   is noise on day 60. The decay trigger is demonstrated competence — which is itself a
   Sierra rule: assume the user is on a path to mastery, and move knowledge from the head
   into the world.

---

## 2. What the revenue winners share

Consumer apps on the DeFi Llama revenue board (30d, Aug 2026): Hyperliquid $33.6M,
pump.fun $33.3M, Axiom Pro $13.9M; fomo $7.9M and GMGN $7.5M adjacent. Patterns that
held across all of them:

1. **Live numbers are the interface.** Prose is nearly absent from every winning trade surface.
   Hyperliquid's trade screen has zero marketing copy.
2. **The home surface is a feed, not a menu.** pump.fun's token grid, Axiom's Pulse scanner,
   GMGN's per-minute trending table, Fomo's social feed. The one menu-based app in the
   sample (Raydium) earns less.
3. **One number is the hero.** Polymarket leads with a probability. Phantom leads with a balance.
   Nothing leads with a paragraph.
4. **Action is 1–2 interactions from discovery.** Preset sizing chips replace forms.
   GMGN fires a buy from a hotkey without leaving the list.
5. **Safety data sits inline at the point of action.** Photon and GMGN put rug-check metrics
   next to the buy button, not in documentation.
6. **Other people's activity renders live.** Trades paint onto charts and fade in as
   notifications. Activity is ambient, not a separate page.
7. **The blockchain is invisible.** "Sign in," never "connect wallet." Fomo provisions the
   wallet behind a Google login and lists Apple Pay above crypto.
8. **Density splits by device, but nobody is sparse-and-slow.** Terminals go Bloomberg-dense;
   mobile strips settings. Both remove deliberation time.
9. **Fees quote as one number.** Fomo bundles execution, routing and service into a single
   figure. Itemization lives behind disclosure.
10. **Polish is optional; liveness is not.** pump.fun is deliberately raw and out-earns
    polished apps. Every winner invests in real-time data over visual refinement.

---

## 3. The rules

### Surface

- **V1. The daily surface leads with one live number** — the user's own state (throughput,
  headroom, next delivery), sized largest on screen. Everything else supports it.
- **V2. Recurring surfaces are feeds of events, not pages of sections.** Harvests, recalls,
  encounters, resolutions — reverse-chronological, self-updating. A returning user reads
  deltas, not layouts.
- **V3. Density is a mode the user chooses, not a level we assign.** Ship a compact/pro
  toggle (Hyperliquid's model: simple is the recommended default, pro is named and opt-in).
  Never delete capability to simplify — conceal it (Bloomberg's rule).
- **V4. Numbers replace sentences wherever a habit exists.** A repeated explanatory sentence
  must become a labeled number, a preset chip, or a badge. "Your venues hand back about 37%"
  becomes `RECALL 37%` after the user has read it in prose once.

### Speed

- **V5. Primary action within 2 interactions of its trigger,** measured from the surface where
  the user decides. Presets carry sizing; the user sets them once.
- **V6. No confirmation dialogs on repeatable, bounded, reversible actions.** Claim, harvest,
  re-tune: one click. Irreversible or leveraged actions (borrow, withdraw, close) keep exactly
  one confirmation — never two — and the confirmation shows numbers, not prose.
- **V7. Returning users get no front door.** Deep links land inside the product, on the user's
  own position (fwa.fun's pattern). Marketing pages exist only for people who have never
  signed.
- **V8. "Sign in," not "connect wallet," wherever auth infrastructure allows.** Rails the user
  already trusts come first in every funding list.

### Text

- **V9. Three tiers of text, each with a home:**
  - **Hot path** (the action row, the gauge, the feed): no sentences, ever. Labels ≤ 3 words,
    numbers, badges.
  - **Warm** (first encounters with a mechanic): full Badass-ruleset teaching — and every
    warm sentence carries a decay trigger (§4).
  - **Cold** (provenance, contract detail, methodology): persistent but opt-in, behind
    info icons and "where these numbers come from" disclosures. Never inline.
- **V10. Risk text is one line, next to the number it qualifies** (fwa.fun's pattern), in the
  hot path at most a badge. Walls of caution read as wallpaper and train users to ignore all
  warnings, including the real one.
- **V11. What text survives is Simplified Technical English.** Short sentences, active voice,
  one meaning per word. No contract function names outside cold tier.

### Social and retention

- **V12. Leaderboards rank floors survived and net made — never gross returns, never on live
  surfaces.** (Inherited from Badass §11; restated because every revenue winner ships
  leaderboards and the pull to copy them raw is constant.)
- **V13. The shareable artifact is the recap card** (Ditto's weekly card), the analogue of the
  PnL share image. It celebrates realized events: deliveries, debt burned, floors held, calls
  resolved. It never shows unrealized P&L.
- **V14. Ambient activity is allowed when it is true and attributable** — real liquidations
  absorbed, real recalls covered, rendered as they happen. Manufactured urgency is not (§5).
- **V15. Notifications fire on the user's own events** — delivery landed, headroom thinning,
  call resolved, recap ready. Never on other people's wins. Fomo's whale-alert cadence is the
  documented failure: its own reviews report users losing money following promoted traders.
- **V16. Progress bars are honest finish lines:** vault caps, epoch boundaries, debt-to-zero,
  calls-to-unlock. The goal-gradient effect is legitimate when the finish line is real
  (pump.fun's graduation bar, minus the lottery underneath it).
- **V17. Any ranking we ship assumes it will be gamed** and carries its safeguard at design
  time (pump.fun's King of the Hill spawned an entire volume-bot economy).

### Alignment

- **V18. Fee-share makes users distributors.** A curator earning a disclosed cut of the fees
  their strategy generates is pump.fun's one cleanly transferable growth loop, and it is the
  Liquity lesson already in the roadmap.
- **V19. Structural safety renders in the UI as a first-class signal** — non-custodial proof,
  recall coverage, measurement dates — the way pump.fun leads with "no rug." Trust claims the
  user can check beat trust claims the user must read.
- **V20. Every page is demo-first (owner rule, Aug 2026).** A new page ships opening FULLY
  POPULATED with no wallet: wallet-scoped blocks run on demo-wallet fixtures behind a
  persistent "Demo — not yours" banner; protocol-scoped blocks (rates, routes, boards,
  capacity, leaderboards) are LIVE in both states and are never faked — demo mode must not
  lie about the market. Every CTA in demo is an intent-preserving connect: the confirm sheet
  keeps its exact rows, the button becomes "Connect wallet", and after connect the same
  sheet re-opens for the real signature. No empty states, no connect gates, anywhere.
  Prototype implementation: copy the shared demo layer (`prototypes/_demo-layer.html`;
  localStorage `membrane.wallet` is the mock connect seam where wagmi `useAccount` lands in
  production). Query real data wherever a source exists and stamp it source + fetch time;
  unmatched values keep their measured stamp.

---

## 4. The decay spec

Every warm-tier sentence must name its decay trigger at design time. The gate, from the
Talin skill-atom framework (AIIDE 2018), best evidence available:

```
show(text) = (feature is in view)
         AND (user has NOT succeeded unaided at this action N times)
         AND (user has NOT dismissed this text)
```

- **Per-mechanic, not global.** A user expert in borrowing may be new to Defend. Mastery is
  tracked per action type, not as one maturity score.
- **Behavior-gated, not time-gated.** Ten fumbles do not graduate a user; three unaided
  successes do. Default N=3 until we measure.
- **Dismissal is the floor, always present.** One click, permanent, per text block.
  (Livefront's coach-mark study: users abandon interfaces that force re-reading.)
- **Decayed text collapses to its number or badge (V4)** — it does not vanish. The info icon
  remains as the cold-tier home for the full explanation.
- **Restrict, don't hide, for genuinely new users:** Carroll's training-wheels studies —
  restricting early access to advanced features made users faster AND better at those
  features later. Locked floors and templates-first are already this pattern.

---

## 5. Do not copy

From the same winners, the mechanics that only work because the product is a casino,
or that are predatory anywhere:

- **Near-miss engineering.** Pump-retrace sequences that manufacture "almost won" re-engagement.
- **One-click execution on leveraged or irreversible actions.** Photon skips confirmations on
  memecoin buys; a borrow is not a memecoin buy (V6 keeps one confirmation).
- **Follow-the-leaderboard into leveraged positions.** Copy-trading a $20 memecoin loses $20.
  Copy-trading a levered borrow gets liquidated.
- **FOMO-framed notifications** on other people's activity (V15).
- **Attention directly moving price** (pump.fun livestream incentives produced self-harm
  content for token milestones).
- **A business model where most users are meant to lose.** Only ~42% of pump.fun's active
  wallets were ever profitable; 0.35% cleared $10k. A positive-sum yield product must never
  import sizing or gamification tuned for that curve.
- **Zero identity/risk gating as a growth tactic.** Subject of active federal litigation
  against pump.fun (allegations, unadjudicated — but not a bet we need).

---

## 6. Acceptance tests

A recurring-use surface ships only if it passes all of these, in addition to Badass §12:

1. **The day-60 test.** Screenshot the surface a daily user sees. Count full sentences in the
   hot path. The number is zero.
2. **The thumb test.** The primary action is reachable in ≤ 2 interactions from where the
   user decides to act.
3. **The silence test.** Strip every sentence from the page. It must still be legible from
   numbers, labels and badges alone. If it is not, the numbers are not carrying the interface.
4. **The decay test.** Every warm-tier sentence names its decay trigger and its collapsed
   form. Un-decayable prose is a design bug, not a copy problem.
5. **The pulse test.** Something on the surface is visibly live without user action. A static
   screenshot should be distinguishable from the running product.
6. **The §11 test, re-run at veteran density.** After decay strips the explanations, the
   surface still awards no progression on returns and shows no unbacked confidence figure.
   Compression must not delete honesty.
7. **The stranger test (V20).** Open the page in a fresh browser with no wallet. It must be
   fully populated, visibly marked demo on wallet-scoped blocks, live on protocol-scoped
   blocks, and its primary CTA must open the real confirm sheet with a Connect button —
   not a gate, not an empty state. Connecting must land you back in the same intent.

---

## 7. Current-product violations (named, so they get fixed)

- The dashboard mock's "How a floor works" paragraph and footer block: warm-tier text with no
  decay trigger. Assign triggers or collapse to badges.
- The builder's scenario `mech` paragraphs: correct as first-encounter teaching; must collapse
  to one-line + icon after a floor is cleared once.
- The intent cards' `leadn` sentences: replace with labeled numbers after first cycle
  (V4 — "A range, because it is next month's venue rates" becomes a `PROJECTED` badge).
- Landing page: correct as-is — it is a front door, and front doors are exempt (V7 governs
  returning users, who should never see it).

## Sources

DeFi Llama revenue/fees boards (Aug 2026) · pump.fun, Hyperliquid, Polymarket, GMGN direct
fetches · Axiom/Photon/Moonshot/Phantom teardowns (madeonsol, coinbureau, tpan.substack,
themasterly) · fwa.fun direct fetch + Cointelegraph/WEEX coverage · Fomo: Forbes, TechTimes,
CoinSpot, Messari · NN/g: progressive disclosure, recognition-over-recall, training wheels,
onboarding-vs-contextual · Talin (AIIDE 2018) · Bloomberg UX (official) · Sierra, *Badass:
Making Users Awesome*. Full URLs in the research transcripts, session aa9c2495, Aug 2026.
