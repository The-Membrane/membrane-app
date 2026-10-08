# Config Cards: known gaps (2026-10-07)

This is the register of what the config cards do NOT do yet, after the final review round (round 8). The design is in [CONFIG-CARDS-DESIGN.md](CONFIG-CARDS-DESIGN.md).

**What gets fixed now and what goes here.** A confirmed bug that can make a dangerous change read calm, hide a red, or misstate chain data was fixed in round 8. Each one has a test that failed before the fix and passes now (`tests/unit/oracleRegistryConfigReview8.test.ts`). Everything else is listed here: cosmetic issues, latent issues, and anything that needs an owner call. Each entry has an id, the lens that found it, where it lives, what it does to the card, a proposed fix, and why it was not fixed now.

Line numbers are as of 2026-10-07 in the `feat/oracle-registry` worktree.

## Confirmed bugs, registered (not fixed)

### KG-1: a same-size oracle committee swap leaves no trace

- **Lens:** on-chain (round-4 refutation, CONFIRMED #2).
- **Where:**
  - `data/oracle-registry/config/subjects.json:2035-2040`: wstETH `oracleMembers` on the HashConsensus `0xd624…b288` is `count: true`.
  - `scripts/oracle-registry/config/lib/params.mjs:58` and `:106` (`paramTransitions`): only the list's length is compared, on the 50,400-block grid.
  - `subjects.json:574-578`: weETH's EtherFiOracle `numActiveCommitteeMembers` is a count too.
- **Impact:**
  - On wstETH, all 9 HashConsensus members were replaced at block 26,054,464 (tx `0x2aac8dd0…6a9e`, a Dual Governance execution). The quorum stayed at 5.
  - The card shows nothing for this. The committee that reports the stETH share rate can change hands, and the history stays silent as long as the size stays the same.
  - weETH's EtherFiOracle committee has the same gap. Not demonstrated on chain.
  - The 2026-10 instance went through the 8-day Dual Governance path. It would most likely have read neutral, so no red is hidden today. The gap is that the change is not shown at all.
- **Proposed fix:**
  - Replay the committee's own events as admin events: `MemberAdded` / `MemberRemoved` (HashConsensus), and EtherFiOracle's committee-member events.
  - Judge a member-set change by the path that made it: neutral through the declared delayed path, red outside it.
  - Alternatively, add a set-valued parameter kind (the sorted member list), so that `paramTransitions` sees a swap at the same size.
- **Why deferred:** the reviewer marked "is member identity in scope?" as an owner call. The fix also needs new collector event topics and a rule for member changes, which is design work.

### KG-2: the red banner and the headline count floor breaches in different units

- **Lens:** UI (round-4 refutation, CONFIRMED #1).
- **Where:**
  - Headline: `lib/oracleRegistry/config/view.ts:414` counts ROUTES (`floorBreachRoutes`).
  - Banner: `components/OracleRegistry/ConfigCard.tsx:63` and `:233-236` count every breaching SIDE (`breachesOf`, `view.ts:370`).
  - A two-sided NTT breach adds one BR-2 at `engine.ts` (the head item) and one from `nttRemoteLines`.
- **Impact:** a route that breaches the floor on both sides reads "1 floor breach" in the headline and "2 FLOOR BREACHES IN FORCE NOW" in the banner. Both are red, so no red is hidden. No subject has a floor breach at head today.
- **Proposed fix:** count the banner with `floorBreachRoutes(items)`, and keep the per-side lines under it, e.g. "1 FLOOR BREACH (2 sides)".
- **Why deferred:** cosmetic. The two numbers disagree, but both are red.

### KG-3: a parameter change reverted within one grid step can vanish between runs

- **Lens:** found while re-collecting the data in round 8. Same root cause as KG-1.
- **Where:** `scripts/oracle-registry/config/lib/params.mjs:106-118`. `paramTransitions` reads every declared getter on a 50,400-block grid that starts at `head − paramDays × 7,200`, and bisects only between grid points whose values differ.
- **Impact:**
  - A change that is undone before the next grid point (about 7 days) is invisible.
  - The grid moves with the head block, so whether such a change shows depends on the run. The card can lose a row it showed before.
  - Observed on weETH. The EtherFiOracle committee went 3 → 5 at 25,626,145 (a red MR-3 row; see UQ-2) and 5 → 3 at 25,633,016, 6,871 blocks apart.
  - Both rows were on the card at head 26,144,054. They are gone at head 26,145,153 (the round-8 re-run), because the new grid has no point between them.
- **Proposed fix:**
  - Replay the setter's own events where the contract emits them (the KG-1 fix covers the committees).
  - Anchor the grid at absolute multiples of the step, so that runs agree.
  - Carry transitions found by earlier runs forward, so a row never disappears.
- **Why deferred:** the reviewers did not raise this. The real fix is event replay, which is the same design work as KG-1.

## Fixed in round 8 (for reference)

Every row below has a failing-then-passing test in `tests/unit/oracleRegistryConfigReview8.test.ts`.

| Id | Lens | Fix |
| --- | --- | --- |
| R1 | rules | The call inside `upgradeToAndCall(impl, data)` and `upgradeAndCall(proxy, impl, data)` is judged as a call on the proxy (`queue.ts`, upgrade case of `judgeOne`). |
| R2 | rules | An unread NTT peer counts as possibly live: the floor is judged and the read is a read gap. An unread Ethereum NTT owner, or an unread or unclassified canonical-bridge proxy admin, is a read gap. `readNtt` sweeps every EVM chain Wormhole maps, so a false-empty `PeerUpdated` scan cannot empty `peers`. |
| R3 | rules | Queued NTT `setThreshold`, `setTransceiver`, `removeTransceiver`, the four-argument `setPeer`, transceiver `setWormholePeer` / `setAxelarChainId`, the NTT one-argument `upgrade(address)` and the Safe 1.1.1 `changeMasterCopy` are decoded and judged. |
| R4 | rules | A CCIP chain removed and re-added with its rate limiter off is red CC-2, in history and in the queue (`ccipLastLimiterOn`). |
| R5 | rules | CC-3 uses `isEoaControlled`, in history and in the queue. |
| R6 | rules | A CCIP remote pool rolled back to an older pool is a re-point: it is compared with the pools the chain had LAST (`lastServed` in the replay; `ccipRemotePoolsReplay` / `ccipLastRemotePools` in the queue). |
| R7 | rules | A Safe whose module read failed gets `modulesUnread`, not `modules: []`. It ranks as a plain contract, is a read gap, and is not diffed between runs. |
| R8 | rules | BR-1 on an NTT transceiver removal or threshold change compares the effective verifier count, not only the raw threshold. |
| U2 | UI | With the head-state file missing, the headline still names "red in effect" and "red queued", and its tone is red (`headlineTone`). |
| U3 | UI | A red grant that an established bot pattern would not clear leads with its anomaly and carries the ANOMALY tag. It no longer says "no established pattern yet". |
| O1 | on-chain | Role holders are re-judged at head (`rejudgeRoleHoldersAtHead`). In one direction, a red grant whose grantee is now strictly stronger, and would not make the grant red, is no longer in effect. In the other, a calm grant whose holder is now EOA-controlled and weaker is a red AD-4 row. The collector classifies at head every current role holder that had code when it was granted. |

## Unsure items (not confirmed): open owner calls

The reviewers marked these items UNSURE, so nothing was changed. They are listed so that none of them is lost.

| Id | Lens | Where | Question / impact | Proposed handling |
| --- | --- | --- | --- | --- |
| UQ-1 | on-chain | `queue.ts` `safeProposalChanges` (`armed` at ~2130) | A fully signed Safe proposal is marked "executable now" without checking the Safe's on-chain nonce. rsETH `0xcbcd` nonce 2041 is shown armed while the Safe is at nonce 2039. Today this is true only because 2039 and 2040 are signed too. | Read `nonce()` at head. Mark a proposal "armed" only when every nonce from the Safe's current nonce up to it is fully signed. Otherwise mark it "signed, waiting on nonce N". |
| UQ-2 | on-chain | `rules.ts:1087` (`quorum_members`) | At weETH block 25,626,145 the quorum went 2 → 3 and the committee went 3 → 5 in the same block. The members row is red MR-3, although the comment says the rule applies "at a fixed quorum". The quorum/members ratio did fall (0.667 → 0.6). After the round-8 re-run the row is no longer on the card (KG-3). | Owner call: judge on the ratio, or only at a fixed quorum. |
| UQ-3 | rules | `engine.ts` `nttRemoteLines` | A remote NTT peer for Ethereum that is not this manager is only a warning. The remote transceivers' peers back to Ethereum are not compared. Under the strict BR-6 ruling this is arguably red. | Owner call. If red: BR-6 head breach on a mismatched `peerBack`, and read the remote transceivers' Ethereum peers. |
| UQ-4 | rules | `adminReplay.ts` (Aragon rows) | A grant to `ANY_ENTITY` (`0xff…ff`) is classified as an EOA. RESUME_ROLE, PAUSE_ROLE and the enabler roles granted to "anyone" read neutral, labelled EOA. No instance exists in the data. | Treat `ANY_ENTITY` as "anyone": red on every role except the open-execution conventions. |
| UQ-5 | rules | NTT limits not tracked; `classifyCcip('rate_limiter')` | NTT inbound and outbound limits are not tracked. A CCIP capacity raised to effectively unlimited while `isEnabled` stays true is not caught. | Track NTT `OutboundLimitUpdated` / `InboundLimitUpdated`. Treat a capacity raise beyond N× the bridged value as CC-2. Owner sets N. |
| UQ-6 | rules | `adminReplay.ts:1050`, `:1080` | Activating Dual Governance emergency mode is neutral in history. A head breach exists (`engine.ts`, AD-2 when emergency mode is active). `ProposerExecutorSet` is neutral, including a proposer re-assigned to the admin executor. | Owner call on both. |
| UQ-7 | rules | `adminReplay.ts:1236-1262` (AD-5) | AD-5 accepts any `CallExecuted` from the timelock in the same transaction, without matching target or data. An unrelated timelocked op bundled with an out-of-band upgrade passes. | Match the `CallExecuted` target and data against the upgrade. |
| UQ-8 | rules | `rules.ts:357`, `:358`, `:368` | REDEEMER_ROLE, COLLATERAL_MANAGER_ROLE and BLACKLIST_MANAGER_ROLE are recognised but not privileged. A grant of any of them to an EOA is neutral. | Owner call per role. Under ruling #11, COLLATERAL_MANAGER (it changes supported assets) looks admin-level. |
| UQ-9 | rules | `data/oracle-registry/config/lz-metadata.json` (DVN registry) | Whether the "eigenzero" DVN shares an operator with "layerzero-labs" is an off-chain fact the code does not check. | Owner call. If they are one operator, map both ids to one operator in the DVN registry. |
| UQ-10 | UI | `rules.ts:48` (BR-3), `rules.ts:72` (AD-6); `bridgeRules.ts:160-163` | The rule tooltips predate rulings 1 and 2. BR-3 is now red only at zero or below LayerZero's default. AD-6 treats adding a guard as an upgrade. weETH's two red BR-3 rows ("20 → 10", "64 → 10") do not name the default that makes them red. | Reword the two RULE_TEXT entries, and add "below the LayerZero default N" to the BR-3 note. |
| UQ-11 | UI | `subjects.json:672`, `:699` (USDe / sUSDe `bypassExclude`) | `addWhitelistedBenefactor` is declared restrict-only, but it widens who can mint. A queued call to it would read neutral, "declared restrict-only". No row shows it today. The power warning lists the declared selectors as raw hex. | Treat as a priority owner call: this one can make a widening read calm. Remove `addWhitelistedBenefactor` from `bypassExclude`, or give it its own rule. Name the selectors in the warning. |
| UQ-12 | UI | `view.ts:780` | The wstETH header shows "Upgrade INSTANT · no pending window". One of 19 upgrade powers drives it: the Linea bridge behind a 0-delay timelock. The minimum is shown by design, but the chip does not say which power it is. | Name the power that sets the minimum in the chip. |
| UQ-13 | UI | WBTC queue | 24 of WBTC's 25 pending rows are abandoned MultiSigWallet submissions from 2019 to 2024, mostly at 1/5 confirmations. The red one is 2019 tx 21. They never go stale. `claimOwnership()` (`0x4e71e0c8`) shows CALL NOT DECODED. | Age out multisig submissions after N months, or show them as "dormant" (owner sets N). Decode `claimOwnership`. |
| UQ-14 | UI | tab counts (`view.ts`) | The tab's red-flag total adds head-state breaches and red-in-effect rows for the same condition. cbBTC shows 9; for example, the blacklister EOA is counted twice. "N route sides unread" counts remote chains, and each unread remote is two sides. | De-duplicate by key, and count sides consistently. |
| UQ-15 | UI | wstETH CCIP rows at 23,843,863 | Remote-pool rows are titled "added" and show "— → 0x2dc9…", although the old pool is known (the note calls it a re-point). Chains show as raw CCIP chain selectors. | Title re-points as re-points, show the old pool, and name the chain selectors. |
| UQ-16 | UI | `docs/RISK_MANAGER_TOOLING_SPEC.md:9`; design doc line 158 | The old Kelp story is still in the docs. The route is described as "downgraded from 2-of-2" (open owner question #1), "a config-diff alert would have" caught it (overclaims against ruling 5), and the Safe Tx Service is called Kelp's only pending source (U4 corrected this in `subjects.json`). | Rewrite both to the ruling-5 framing: red for a year, alongside ~45% of comparable apps. |
