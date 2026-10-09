# Config Cards: known gaps (2026-10-07, updated 2026-10-08)

This is the register of what the config cards do NOT do yet, after the final review round (round 8). The design is in [CONFIG-CARDS-DESIGN.md](CONFIG-CARDS-DESIGN.md).

**What gets fixed now and what goes here.** A confirmed bug that can make a dangerous change read calm, hide a red, or misstate chain data was fixed in round 8, and again in review round 9 (the review of the ruling #12–#14 work). Each one has a test that failed before the fix and passes now (`tests/unit/oracleRegistryConfigReview8.test.ts`, `tests/unit/oracleRegistryConfigReview9.test.ts`). Everything else is listed here: cosmetic issues, latent issues, and anything that needs an owner call. Each entry has an id, the lens that found it, where it lives, what it does to the card, a proposed fix, and why it was not fixed now.

Line numbers are as of 2026-10-07 in the `feat/oracle-registry` worktree.

## Confirmed bugs, registered (not fixed)

KG-1 and KG-2 were closed on 2026-10-08 (uncommitted at the time of writing); see "Closed 2026-10-08" below.

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
- **Partly addressed 2026-10-08:** the committees now have event replay (KG-1, closed). A committee member change is a row of its own and no longer depends on the grid. The count rows (`oracleMembers`, `numActiveCommitteeMembers`) and every other grid parameter can still vanish between runs as described above.
- **Correction (review round 9):** the weETH quorum row 2 → 3 at 25,626,145 that the round-9 re-run lost was NOT this gap. It was CB-1: the weETH and wstETH param keys collided, so weETH's grid read wstETH's constant quorum 5 (fixed; see "Fixed in review round 9").

## Closed 2026-10-08 (owner rulings, round 9)

Both fixes are uncommitted at the time of writing. Each one has tests that failed on the code before the change (`tests/unit/oracleRegistryConfigRulings1214.test.ts`).

### KG-1: a same-size oracle committee swap left no trace — CLOSED (owner ruling #13)

- **Was:** a committee was tracked only as a member COUNT on a 50,400-block grid (`params.mjs`, `paramTransitions`). On wstETH, all 9 HashConsensus members were replaced at block 26,054,464 (tx `0x2aac8dd0…`, a Dual Governance execution) at quorum 5. The card showed nothing.
- **Now:**
  - The collector scans the committee events as admin events (`abi.mjs`):
    - Lido HashConsensus `MemberAdded` / `MemberRemoved` (the totals after each change are in the data);
    - ether.fi EtherFiOracle `CommitteeMemberAdded` / `CommitteeMemberRemoved` / `CommitteeMemberUpdated` (signatures from the verified source).
  - It also scans Aragon Voting `ExecuteVote`, the delayed path before Dual Governance.
  - `adminReplay.ts` files one row per (committee, transaction), key `oracle/committee/<contract>`, with the members removed (`before`) and added (`after`). A same-size swap reads "9 members replaced (9 → 9 members, quorum 5)".
- **Judgement: by the path that made the change.**
  - Neutral when the committee's DECLARED delayed governance path made the change. As first built, any `CallExecuted`, `ProposalExecuted` or `ExecuteVote` from the path in the same transaction counted. Review round 9 (CB-2) made it per call (`adminReplay.ts`, `committeePathVia`):
    - the transaction was SENT to a declared path contract, and that contract's execution event comes after every member event (a Dual Governance `execute`, an Aragon `executeVote`); or
    - each member event is followed by a `CallExecuted` from a declared path timelock whose call targets the committee and names that member in its calldata (the ether.fi shape: a Safe calls the timelock).
    - An unread transaction recipient falls back to the second test. Anything else is red.
  - The declared path (`engine.ts`, `committeePaths`) is every delayed controller (timelock, Dual Governance, Aragon vote) in the head controller trees of the holders of a declared power over the committee. A committee with no declared power falls back to the subject's declared timelocks.
  - Red (AD-5) outside the declared path, and red when no path is declared (fail closed).
  - A change in the committee's deploy block is initialization.
- **STILL IN EFFECT:** a red member change stays in effect while a member it added is still in, or a member it removed is still out.
- **On chain (re-run 2026-10-08):**
  - wstETH: 7 member changes in the scan window (from block 17,600,000), all neutral. 4 went through an Aragon vote (`ExecuteVote`) and 3 through Dual Governance (`ProposalExecuted` from the EmergencyProtectedTimelock), the 2026 nine-member swap included.
  - weETH: the first member add in 2023 (block 18,537,396) was made directly, not through a timelock. It is red AD-5 and no longer in effect, because that member was removed through the timelock in 2024. Every later change went through the declared timelocks `0x9f26…0761` / `0xcd42…7d5a` and is neutral.

### KG-2: the red banner and the headline counted floor breaches in different units — CLOSED

- **Was:** the headline counted ROUTES (`floorBreachRoutes`). The banner counted every breaching SIDE: a route under the floor on both sides read "1 floor breach" in the headline and "2 FLOOR BREACHES IN FORCE NOW" in the banner.
- **Now:** the banner title comes from `breachBannerTitle` (`components/OracleRegistry/configViewModel.ts`). It counts routes like the headline, with the sides in brackets when they differ: "1 FLOOR BREACH (2 sides) IN FORCE NOW". The per-side lines stay under it.

## Fixed in review round 9 (2026-10-08)

The two refuters of the ruling #12–#14 work (on-chain lens and rules lens) confirmed six bugs. All six can make a dangerous change read calm, hide a red, or misstate chain data, so all six were fixed. Each row has a test in `tests/unit/oracleRegistryConfigReview9.test.ts`; 11 of its 15 tests fail with the fixes reverted (the other four are the CB-1 helper test, which needs the new helpers, and three controls). The fixes are uncommitted at the time of writing.

| Id | Lens | Where | Was | Fix |
| --- | --- | --- | --- | --- |
| CB-1 | on-chain | `scripts/oracle-registry/config/lib/params.mjs` (`scopedParamSpecs`, `paramsForSubject`); `collect-config.mjs` section 10 | The collector read every subject's params in one pass keyed by `key` alone. weETH and wstETH both declare `oracleQuorum` / `oracleMembers`, so weETH showed wstETH's 5 / 9 (on chain: 3 / 3), and weETH's real quorum change 2 → 3 at 25,626,145 vanished. WBTC and cbBTC share `paused` (latent: both false). | Keys are read as `<subject>::<key>`; each subject gets its own slice. weETH re-collected. |
| CB-2 | on-chain, rules | `lib/oracleRegistry/config/adminReplay.ts` (`committeePathVia`); collector: `txTo` + committee `CallExecuted` calldata | A committee member change was neutral when ANY path execution event was in the same transaction. A member add bundled with a timelock call to another contract read "through the declared delayed governance path". | Per call: the transaction sent to the path and executed after the change, or the first `CallExecuted` after each member event targets the committee and names the member. All 16 real rows still pass (checked on chain: the 7 wstETH transactions are sent to `0xce04` / `0x2e59`; the 8 ether.fi ones have a `CallExecuted` to `0x57aa` after each member event). The 2023 direct add stays red. |
| CB-3 | on-chain | `scripts/oracle-registry/config/lib/admin.mjs` `classify` (`MAX_OWNER_HOPS`) | Owner hops were capped by the overall depth (`depth < 2`). Under "ProxyAdmin owned by a timelock", the proposers sit at depth 2, so a proposer contract's owner was never read: one owned by an EOA ranked as a plain contract and AD-3 never fired. The MCMS cycle under the RBACTimelock counted the delay credit twice. | Owner hops are counted from the last proposer / executor hop; an ownership cycle is not followed (the MCMS ranks as a plain contract, credit once). Classification cache moved to `controllers-at-v4.json` (v3 entries without a timelock, an Agent or a cycle carry over). |
| R-1 | rules | `lib/oracleRegistry/config/rules.ts` `rankParts` (`aragon_voting`) | An Aragon Voting with a 0 s or unread vote time ranked as a token-holder vote, above every Safe. Safe 6/11 → it read UPGRADE; a power it held showed no breach and no read gap. A regression from ruling #12: before it, 0 / unread ranked as a plain contract. | 0 s or unread vote time = plain contract (fail closed), described as such, and a read gap at head ("vote time not read"). |
| R-2 | rules | `rules.ts` (`scheduledParts`, `delaySetters`); `admin.mjs` `canSetDelay` | A Chainlink RBACTimelock gates `updateDelay` with ADMIN_ROLE (measured on `0x4483…9449`: `updateDelay(0)` from a non-admin reverts "missing role"), not self-only as in OZ. An ADMIN holder still got the full delay credit, though it can cut the delay to 0, grant itself PROPOSER and EXECUTOR, and run a batch at once. Safe 6/11 → a 7-day RBACTimelock administered by that Safe read UPGRADE; Safe 6/11 behind a 3-day OZ timelock → it read UPGRADE (should be red). | The collector marks admin-role holders whose `updateDelay(0)` eth_call succeeds (another failure = fail closed) as `delaySetters`; they get no credit from that timelock. No timelock in the 8 subjects has one at head (probed). |
| R-3 | rules (on-chain: unsure) | `lib/oracleRegistry/config/value.ts` `compareValueAtRisk`, `valueAtRiskLabel`; `view.ts` `breachesOf` | A floor breach with one side of its value at risk unread sorted by the side that was read ("$1K … lower bound") behind a fully read $10M. Under ruling #9 the value is the larger side, so with a side unread it is not known. | A partial read sorts with the unread ones (after the fully unread, by its read side), labelled "value unread (…) · at least $1K (…)". |

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
| UQ-7 | rules | `adminReplay.ts` `ad5` (AD-5) | AD-5 accepts any `CallExecuted` from the timelock in the same transaction, without matching target or data. An unrelated timelocked op bundled with an out-of-band upgrade passes. The same weakness on committee rows was fixed in review round 9 (CB-2); upgrades still have it. | Reuse `committeePathVia`: the transaction sent to the timelock, or the first `CallExecuted` after the `Upgraded` event targeting the proxy (or its ProxyAdmin) with the implementation in its calldata. |
| UQ-8 | rules | `rules.ts:357`, `:358`, `:368` | REDEEMER_ROLE, COLLATERAL_MANAGER_ROLE and BLACKLIST_MANAGER_ROLE are recognised but not privileged. A grant of any of them to an EOA is neutral. | Owner call per role. Under ruling #11, COLLATERAL_MANAGER (it changes supported assets) looks admin-level. |
| UQ-9 | rules | `data/oracle-registry/config/lz-metadata.json` (DVN registry) | Whether the "eigenzero" DVN shares an operator with "layerzero-labs" is an off-chain fact the code does not check. | Owner call. If they are one operator, map both ids to one operator in the DVN registry. |
| UQ-10 | UI | `rules.ts:48` (BR-3), `rules.ts:72` (AD-6); `bridgeRules.ts:160-163` | The rule tooltips predate rulings 1 and 2. BR-3 is now red only at zero or below LayerZero's default. AD-6 treats adding a guard as an upgrade. weETH's two red BR-3 rows ("20 → 10", "64 → 10") do not name the default that makes them red. | Reword the two RULE_TEXT entries, and add "below the LayerZero default N" to the BR-3 note. |
| UQ-11 | UI | `subjects.json:672`, `:699` (USDe / sUSDe `bypassExclude`) | `addWhitelistedBenefactor` is declared restrict-only, but it widens who can mint. A queued call to it would read neutral, "declared restrict-only". No row shows it today. The power warning lists the declared selectors as raw hex. | Treat as a priority owner call: this one can make a widening read calm. Remove `addWhitelistedBenefactor` from `bypassExclude`, or give it its own rule. Name the selectors in the warning. |
| UQ-12 | UI | `view.ts:780` | The wstETH header shows "Upgrade INSTANT · no pending window". One of 19 upgrade powers drives it: the Linea bridge behind a 0-delay timelock. The minimum is shown by design, but the chip does not say which power it is. | Name the power that sets the minimum in the chip. |
| UQ-13 | UI | WBTC queue | 24 of WBTC's 25 pending rows are abandoned MultiSigWallet submissions from 2019 to 2024, mostly at 1/5 confirmations. The red one is 2019 tx 21. They never go stale. `claimOwnership()` (`0x4e71e0c8`) shows CALL NOT DECODED. | Age out multisig submissions after N months, or show them as "dormant" (owner sets N). Decode `claimOwnership`. |
| UQ-14 | UI | tab counts (`view.ts`) | The tab's red-flag total adds head-state breaches and red-in-effect rows for the same condition. cbBTC shows 9; for example, the blacklister EOA is counted twice. "N route sides unread" counts remote chains, and each unread remote is two sides. | De-duplicate by key, and count sides consistently. |
| UQ-15 | UI | wstETH CCIP rows at 23,843,863 | Remote-pool rows are titled "added" and show "— → 0x2dc9…", although the old pool is known (the note calls it a re-point). Chains show as raw CCIP chain selectors. | Title re-points as re-points, show the old pool, and name the chain selectors. |
| UQ-16 | UI | `docs/RISK_MANAGER_TOOLING_SPEC.md:9`; design doc line 158 | The old Kelp story is still in the docs. The route is described as "downgraded from 2-of-2" (open owner question #1), "a config-diff alert would have" caught it (overclaims against ruling 5), and the Safe Tx Service is called Kelp's only pending source (U4 corrected this in `subjects.json`). | Rewrite both to the ruling-5 framing: red for a year, alongside ~45% of comparable apps. |
| UQ-17 | on-chain, rules | `rules.ts` `rankParts` (`aragon_voting`); `admin.mjs` `aragonVotingOf` | A Voting with a READ vote time ranks as a token-holder vote (base 5), above every multisig, whatever the vote time and whoever holds the token: `aragonVotingOf` checks only the code fingerprint, so a self-deployed Aragon DAO whose token one key holds outranks a Safe 6-of-11. Ruling #12 says Dual Governance / Voting rank through "the declared proposer / executor set if known". (R-1 fixed only the 0 s / unread case.) | Owner call. Options: rank a Voting by its token's holder concentration (e.g. as an EOA when one address can pass a vote alone), or only declared Votings (Lido) rank as base 5 and any other ranks as a plain contract. |
| UQ-18 | on-chain | `rules.ts` `rankParts` | A delay lifts a fail-closed rank: a 7-day timelock whose only proposer is a timelock with an UNREAD proposer set ranks `[2, 0, 0, 604800]`, so plain contract → it reads as an UPGRADE. The read gap is reported. | Owner call: an unread scheduler anywhere in the tree caps the whole rank at `[2]` with no credit. |
| UQ-19 | on-chain | `engine.ts` `committeePaths` | The declared committee path admits ANY timelock with a delay above 0 and never ranks who proposes into it. A 60 s timelock, or a 10-day timelock an EOA proposes into, counts as the "declared delayed path". No instance today. | Admit only path controllers whose rank (ruling #12) is at least a multisig with delay credit; otherwise judge the member change as outside the path (red). |
| UQ-20 | on-chain | weETH `subjects.json` (EtherFiOracle powers) | EtherFiOracle `owner()` reverts: access goes through RoleRegistry `0x6224…7ce9` (owner: timelock `0x9f26`), and the 2025 member changes were executed by timelock `0xcd42`. The head state does not show the role `0xcd42` holds. The committee path falls back to the subject's declared timelocks, which still fails closed for a direct change. | Declare the RoleRegistry role over the committee as a power, so the path comes from its holders. |
| UQ-21 | on-chain | `engine.ts` `rejudgeRoleHoldersAtHead` | A red AD-4 grant to a timelock that an EOA proposed into at grant time becomes "NO LONGER IN EFFECT" when the head proposer read fails (an unread set ranks as a contract, above an EOA). The read gap is still listed. | Never end a red on an unread head rank: keep it in effect while the holder's head tree has an unread part. Priority owner call: it can make a red read as ended on a read failure. |
| UQ-22 | rules | `engine.ts` head-state AD-6 | AD-6 (a Safe module) is not carried through a timelock's proposers at head. A power held directly by a Safe with a module is AD-6; the same Safe proposing into a 0 s timelock is not. Live: the wstETH Linea L1 bridge upgrade power (`breaches: []`). Its proposer Safe `0xb8f5…0051` has module `0x784c…5436` (owner / avatar = the Safe, `txCooldown` 7,776,000 s = 90 d), enabled after block 22,623,238. The Safe is not in `safes`, so no history row was written. The 90-day cooldown makes it low risk in practice. | Walk AD-6 through `controllerTree` (proposers included), as the read gaps already do; add the proposer Safe to `safes`. |
| UQ-23 | rules | `admin.mjs` `roleGrantLogs` | The per-timelock RoleGranted read uses the shared state ring in 1M-block chunks. A chunk lost while others return drops a grant silently: `unread` is set only when no PROPOSER candidate is found at all. OZ TimelockController is not enumerable, so the only cross-check is the admin scan (`roleCands`). | Read on the keyed logs client in smaller chunks and mark the set unread when any chunk fails or a cross-check disagrees. |
| UQ-24 | rules | `rules.ts` `rankParts` (bypass) | Bypass holders are never ranked (predates round 9): EOA → a timelock whose unrestricted bypasser is that same EOA reads as an upgrade (`[2]`). The head AD-2 bypass breach still shows. DSPause ranks its `authority` as a controller, though DSAuth lets whoever the authority permits call (latent: no DSPause in any subject). | Rank an unrestricted bypass as its weakest bypasser (with no credit); rank a DSPause authority as the callers it permits, unread = plain contract. |
