# Config Cards — Design (v1, 2026-10-05)

> **Status:** design for the oracle registry's config cards (owner spec `docs/RISK_MANAGER_TOOLING_SPEC.md`, build order #1–#2). Inputs: three fact-checked research reports (LayerZero/other bridges, admin/timelock/proxy, mint/redeem + pending/proposed) and a critique, appended below. **The critique's fixes are binding on implementation.**
>
> **Kelp finding (parent-verified on-chain 2026-10-05):** rsETH OFTAdapter `0x85d456B2…` Ethereum receive config for Unichain (eid 30320) via `EndpointV2.getConfig(adapter, ReceiveUln302, 30320, 2)`:
> - Block 24,907,000, just before the 2026-04-18 exploit: `(confirmations 42, requiredDVNCount 1, optional 0, [0x589dEDbD…])`. That is **1-of-1**.
> - Block 24,990,000, after the fix: **4-of-4**.
>
> The exploited route was **created** at 1-of-1 (2025-04-02); it was never downgraded. The 2-of-2 → 1-of-1 drops happened on OTHER routes in 2024. So diff-only alerts are insufficient. Cards need an **absolute floor** (any live route with fewer than 2 effective, distinct known operators is RED, including at creation), and diffs must run on **effective** config, where overriding an inherited 2-of-2 default with 1-of-1 is a downgrade.


## Design

# Config Cards: design v1

This design builds on `feat/oracle-registry` @92ebaa87. All facts come from the verified on-chain reads of 2026-10-05.

**The spec's Kelp story is wrong, and the owner needs to sign off on the correction.** The exploited route (eid 30320, Unichain→Ethereum) was set up as 1-of-1 when it was created on 2025-04-02. It was never 2-of-2. The explicit 2-of-2→1-of-1 downgrade happened on Mode and Blast on 2024-03-21. At least eight more routes silently lost an inherited 2-of-2 default. So the rules compare the **effective** config, not just the explicit settings, and they also enforce an **absolute floor**.

## 1. Data model (`lib/oracleRegistry/configTypes.ts`)
```ts
export type Dimension = 'bridge' | 'oracle' | 'admin' | 'mint_redeem'
export type ControllerKind = 'immutable' | 'oz_timelock' | 'ds_pause' | 'aragon_dg' | 'safe'
  | 'legacy_multisig' | 'contract' | 'eoa' | 'eoa_7702'
export type Controller = { kind: ControllerKind; address: Address; threshold?: number; signers?: number; delaySec?: number }
export type GovChannel = { kind: 'snapshot'; space: string } | { kind: 'discourse'; base: string }
  | { kind: 'sky_spell' | 'lido_dg' } | { kind: 'safe_queue' | 'oz_timelock' | 'legacy_multisig'; address: Address }
export type ConfigContract = { role: string; dimension: Dimension; chainId: number; address: Address
  label: string; deployBlock: number; oracleEntryIds?: string[] }        // joins catalog.json
export type ConfigSubject = {
  key: string; oracleAssetKey: string | null                              // null ⇒ config-only tab
  class: 'lrt' | 'bridged' | 'pt' | 'custodial'
  contracts: ConfigContract[]; govChannels: GovChannel[]                  // [] ⇒ NO-GOV-CHANNEL
  capSentinels: Record<string, { zero: 'closed' | 'unlimited' }> }
export type DvnConfig = { required: Address[]; optional: Address[]; optionalThreshold: number
  confirmations: string; source: 'override' | 'default' | 'mixed'; blocked: boolean }
export type ConfigValue = string | number | boolean | null | Address[] | DvnConfig | Controller
export type ConfigItem = {
  subject: string; dimension: Dimension; key: string                     // 'bridge/lz/1/<oapp>/30320/receive'
  route?: { localChainId: number; remoteEid?: number; direction?: 'send' | 'receive' }
  value: ConfigValue; display: string
  source: { chainId: number; address: Address; getter: string; block: number }
  floor?: { ok: boolean; ruleId: string } }
export type ChangeState = 'pending' | 'proposed' | 'historical'
export type Severity = 'downgrade' | 'upgrade' | 'neutral'
export type ConfigChange = {
  id: string                                  // `${chainId}:${tx}:${logIndex}` | `${queue}:${opId}:${i}`
  subject: string; dimension: Dimension; key: string
  before?: ConfigValue; after?: ConfigValue
  state: ChangeState
  stage?: 'forum' | 'snapshot' | 'safe_queued' | 'scheduled' | 'armed' | 'executed'
  severity: Severity; floorBreach: boolean   // red ⇔ downgrade || floorBreach
  ruleIds: string[]; tags: ('large_raise' | 'rotation' | 'run_risk' | 'deprecated_dvn')[]
  unannounced: boolean | null                 // null ⇒ no gov channel
  announcement?: { url: string; matchedOn: string[] }
  chainId: number; block?: number; ts?: number; tx?: Hex; actor?: Address; eta?: number
  queue?: { kind: 'oz_timelock' | 'safe' | 'ds_pause' | 'legacy_multisig'; address: Address; opId: string }
  links: { tx?: string; governance?: string; card: string } }
```
The oracle dimension reuses the existing `ChangeItem`s from `changes.json` and `detectChangeSeries`. No second collector is needed.

## 2. Downgrade rules (red in any state)

**E (effective verifier count)** = required DVNs + optional DVN threshold.
- A field value of 255 counts as 0.
- A 0 in an override field inherits the default from `getUlnConfig(0, eid)`.
- A route whose default DVN is the dead DVN is blocked.

**Bridge**
- **BR-1:** E drops on any (oapp, eid, direction). This includes an override replacing a default, and a `DefaultUlnConfigsSet` that lowers E for routes inheriting it.
- **BR-2 (floor):** a live route (peer ≠ 0, not on BlockedMessageLib) has E < 2. It is checked when the route is created and on every head read. The same floor applies to NTT `getThreshold()` < 2.
- **BR-3:** block confirmations go down **to zero (incl. the uint64-max NIL) or below LayerZero's own default for that pathway** (owner ruling 2026-10-06). A drop that stays at or above the default is noted, not red. When the default could not be read, the drop is red and says so (fail closed). **Floor (review round 6):** a LIVE route at zero confirmations (incl. NIL) is red at creation, after any change and as a head-state breach, like BR-2.
- **BR-4:** a DVN has no code on the local chain. A `deprecated` DVN only gets a tag.
- **BR-5:** a library is not one of SendUln302, ReceiveUln302, BlockedMessageLib or ReadLib1002. Moving to BlockedMessageLib is neutral.
- **BR-6:** a peer moves from one nonzero address to another. **Strict (owner ruling 2026-10-06): every re-point is red**, also on a route that is closed at the time (the new counterparty is trusted the moment it reopens), and also through a zeroed peer (A → 0 → B, review round 5: the replay, the queue and the remote side between runs keep the last non-zero peer). Zeroing a peer is neutral, and so is swapping a DVN without changing the count. The CCIP twin (CC-1, default 2026-10-06): a second remote pool for an already-served chain is red, and so is a new remote pool after the old one was removed (a re-point); pending `addRemotePool` calls are judged against the pools the chain accepts at head (unread ⇒ red).
- **BR-8 (AMBER, owner ruling 2026-10-06, round 2 #6):** a wider DVN set at the same effective threshold (e.g. 4-of-4 → 2 required + 2-of-3 optional, or one more optional DVN at an unchanged optional threshold) is tagged `WIDER DVN SET`, not red. An unknown added DVN stays red under BR-7.

**Admin.** Controller rank, strongest first: immutable > a BROADLY HELD token vote (Aragon Voting that more than 10 of its largest holders are needed to pass alone) > Safe or multisig (by threshold, then signer count) > contract > EOA = 7702 EOA. **Owner ruling 2026-10-08 (UQ-17):** a token vote ranks by HOLDER CONCENTRATION — one holder that can pass a vote alone ranks the vote as that holder (an EOA, or the holder's own rank), k ≤ 10 holders as a k-of-k multisig, unread holder data as a plain contract (a read gap); see "Round 10" below. Review round 10: the vote ranks as the WEAKEST set of k holders that passes (not only the top k); a holder not classified, or a holder list that does not settle that set, is a read gap; address(0) and the precompile range cannot vote. **Owner ruling 2026-10-09 (UQ-25):** "passes alone" is judged against the AVERAGE OPPOSITION of the trailing year — D, the mean nay stake of every vote started in the 365 days before the classification block (a vote with no nays counts as 0); no vote in the window = D 0 (fail closed, said on the card); unread vote history = a read gap; see "Round 11" below. **Owner ruling 2026-10-08 (#12):** a TIMELOCK ranks as its WEAKEST PROPOSER, then its delay credit. The delay credit is 0 below 24 h (86,400 s) and the delay itself at or above it; a delay never rescues a weak proposer. Who can propose:
- an OZ timelock / RBACTimelock: the PROPOSER_ROLE holders, and the holders of the role that administers it (TIMELOCK_ADMIN / DEFAULT_ADMIN / ADMIN), since they can grant it; an unrestricted bypass ranks as its weakest bypasser, with no credit (UQ-24);
- a DSPause: its owner, and the callers its DSAuth authority permits (not enumerable today: a non-zero authority ranks the pause as a plain contract, a read gap — UQ-24);
- a Dual Governance timelock: its declared proposers (`getProposers()`).

An unread proposer set ranks as a plain contract and is a read gap (fail closed). A read gap anywhere in a controller's tree caps its rank at a plain contract, and no delay above it adds credit (UQ-18). Details and the required cases are in "Owner rulings 2026-10-08" below.
- **AD-1:** a multisig's threshold drops; a signer is added at an unchanged threshold; or signers are added so that the ADDED signers alone meet the new threshold (review round 5: a 2-of-3 → 3-of-10 lets any three of the seven new signers act without an old one). A raised threshold with fewer new signers than it (3-of-5 → 4-of-7) is an upgrade. Review round 6: owners SWAPPED in count as added (a 3-of-5 with three owners swapped is red; so is a 2-of-4 → 3-of-4 with three swaps), in replay, in queued `swapOwner` / `replaceOwner` batches (cumulative over the op) and between runs (the owner set is compared, not only its size).
- **AD-2:** a timelock or DSPause delay is shortened, or a timelock is removed from the authority path. Review round 6: that includes a function put on a timelock's no-delay whitelist (`FunctionWhitelisted`, a queued `addToWhitelist`) when it reaches a declared power (unmatched ⇒ fail closed; removal is an upgrade), and — as a head-state breach, the twin of a Safe module — a power whose delay a read timelock bypass skips.
- **AD-3:** an owner, admin, LZ delegate or role-admin drops in rank. The WBTC Controller going from 8-of-13 to 6-of-10 is red. EOA→EOA is neutral and tagged `rotation`. **Owner ruling 2026-10-06 (round 2, #7):** a FIRST owner set from address(0) more than `OWNER_INIT_WINDOW_BLOCKS` = 7,200 blocks after the contract's deploy block is red (its `initialize()` could have been front-run); within 7,200 blocks it is neutral initialization. An unknown deploy block fails closed (red, says why).
- **AD-4:** DEFAULT_ADMIN, PROPOSER, EXECUTOR, CANCELLER, TIMELOCK_ADMIN, MINTER, MANAGER or an upgrader role (every admin-level role, below) is granted to an EOA, a 7702 EOA, a contract an EOA controls (review round 6) or a new address. A role that administers another role is privileged whatever its name (round 6). Granting EXECUTOR to address(0) is standard open execution and stays neutral.
  - **Operational bot grants (owner rulings 2026-10-06, #4; numbers accepted and revised in round 2, #8 / #10 / #11).** A grant that would be red under AD-4 / MR-2 is AMBER `OPERATIONAL` instead when it follows the protocol's established bot pattern, and stays RED (tagged `ANOMALY`, with the reason) otherwise. Constants in `rules.ts`:
    - *pattern* (`OPERATIONAL_PATTERN_MIN_GRANTS` = 3): at least 3 earlier grants of the same role on the same contract to wallets with no code;
    - *anomaly*: the grantee has code (a contract, a Safe, a 7702 EOA) or was not classified; the role is admin-level or administers another role (a `RoleAdminChanged` target); the role is not recognised; a BURST; or a RATE spike.
    - *admin-level* (`ADMIN_LEVEL_ROLES`, always red): DEFAULT_ADMIN, TIMELOCK_ADMIN, PROPOSER, EXECUTOR, CANCELLER, UPGRADER, the RBACTimelock's ADMIN_ROLE and BYPASSER_ROLE, Ethena's WHITELISTED_EXECUTOR_ROLE, and — ruling #11 — **any role that can change config, oracles, supported assets or limits**: MANAGER / MANAGER_ROLE (rsETH's LRTConfig MANAGER sets deposit limits, supported assets and price oracles, so its grant at block 18,813,732 reads red).
    - *unrecognised roles are PRIVILEGED* (ruling #8): a role hash the collector cannot name, or a name with no known powers (GUARDIAN), is judged like a privileged role — a grant to a wallet is red AD-4 — and is never operational. `ROLE_NAMES` lists the recognised roles (also in the collector's naming table, tested).
    - *BURST* (ruling #10, revised): a one-day batch (`GRANT_BURST_WINDOW_BLOCKS` = 7,200 blocks, this grant included) is red only if it is LARGER than the largest earlier one-day batch of that role on that contract (the trailing-window count at any earlier grant whose window ends before this one starts). With no earlier batch, the fallback is more than `GRANT_BURST_MAX` = 3 in the day. So Ethena's first 20-key MINTER batch is red past its third key, and every later 20-key rotation reads amber `OPERATIONAL`.
    - *RATE*: the trailing `GRANT_RATE_WINDOW_BLOCKS` = 216,000-block (≈ 30-day) count is more than `GRANT_RATE_SPIKE_FACTOR` = 2× the largest count of any earlier window that ends before the current one starts (no earlier window ⇒ no rate baseline).
    - Pending and proposed grants are judged the same way, against the executed grant history, as if they ran at the head block.
    - The rsETH deposit-pool MINTER grant on LRTConfig stays red: its grantee is a contract.
- **AD-5:** an `Upgraded` or `AdminChanged` event has no `CallExecuted` from the subject's timelock in the same tx. **Owner ruling 2026-10-08 (#13):** the same for an oracle committee's member set. A member change with no `CallExecuted` / `ProposalExecuted` / `ExecuteVote` from the committee's declared delayed governance path in its transaction is red; one through that path is neutral.
- **AD-6:** a Safe module is enabled, or the guard is set to 0. **Owner ruling 2026-10-06:** adding a guard where none existed is an UPGRADE; removing or replacing one is red (in event history the previous guard is the last one the events set — `ChangedGuard` carries only the new one). A Safe whose slot-0 singleton moves (incl. to a non-canonical one, after which it ranks as a plain contract) is red.
- **AD-7 (state rule):** TIMELOCK_ADMIN_ROLE is held by anything other than the timelock itself.
- **AD-8:** an armed op would break a rule. This includes an upgrade scheduled before the current implementation was installed, which would be a stale rollback.

The card headline shows the **effective delay**: the shortest delay over all paths to each power.

**Mint/redeem**
- **MR-1:** the pauser is removed and not replaced.
- **MR-2:** a rate provider, minter or price oracle moves to an EOA, a 7702 EOA or a no-code address, or a new minter appears.
- **MR-3:** a rate bound is loosened. That covers:
  - pricePercentageLimit, acceptableRebaseAprInBps or a sanity limit being raised;
  - the SP-BEAM step or max being widened, or its tau shortened;
  - a quorum or quorum/members ratio being lowered.
- **MR-4:** a cap is set to the subject's "unlimited" sentinel, or (review round 6) to type(uint256).max / type(uint128).max.
  - A raise of 2× or more only gets the `large_raise` tag, so Ethena's routine 10M→20M raise does not go red.
  - A Kelp limit of 0 means closed, so it is neutral.
- **MR-5:** a whitelist gate is removed. A shorter cooldown is tagged `run_risk`.

**Oracle** (using the existing `ChangeKind`) is red on any of these: heartbeat up, deviation up, TWAP window down, source moved to an EOA or no-code address, fallback removed, Chronicle `bar` down, CAPO growth up.

**Unannounced.** A change counts as announced if, in the 30 days before it was queued, Snapshot, Discourse or the spell `description()` has either one strong match (an address or the exact value) or two medium matches (a contract or function name). Only config-class events are scored. Kelp, Pendle, Strata, Coinbase and BiT Global have no governance channel, so they are marked NO-GOV-CHANNEL with `unannounced: null`.

## 3. Collectors
Reuse the `collect.mjs` plumbing: `getLogsAdaptive`, `retry`, `pool`, `guardProcessErrors`, 10k-block spans and concurrency 2. Full-range scans run only on the keyed Ankr endpoint.

**History depth:**
- Bridge and admin go back to each contract's `deployBlock`, because Kelp's critical changes date from 2024.
- Mint/redeem goes back 365 days.
- Oracle `--gov-days` is raised to 365.

Runs resume incrementally from `cursors.json`.

| Dim | Head getters | Events |
|---|---|---|
| LZ | `peers`, `owner`, `delegates`, `getSend/ReceiveLibrary`, `getConfig(…,2)`, `getUlnConfig(0,eid)`, DVN `signerSize`/`quorum`, `eth_getCode` | `PeerSet`; `UlnConfigSet`/`DefaultUlnConfigsSet` from the **libraries** (oapp/eid are not indexed, so scan ~13k per library and filter); Endpoint `DelegateSet`, `*LibrarySet`; DVN `UpdateSigner` `0x863d338c…`, `UpdateQuorum` (constructor-set signers emit no event, so seed them from the getters) |
| CCIP | `getPool`, pool `owner`, rebalancer, remote pools | `OwnershipTransferred`. CCIP 2.0 CCV/RMN comes later. |
| admin | EIP-1967 slots (zeppelinos slots for FiatToken), Safe threshold/owners/modules/guard, `getMinDelay`, `hasRole`, recursive `owner()`; code starting `0xef0100` means a 7702 EOA | `Upgraded`, `AdminChanged`, `OwnershipTransferred`, admin-class `RoleGranted/Revoked`, `MinDelayChange`, Safe owner/threshold/guard/module events |
| mint/redeem | The verified per-asset getters; poll Ethena `globalConfig()` because it emits no event | The verified per-asset events |

DVN names and `deprecated` flags come from the LZ metadata API, cached daily. The only L2 in v1 is rsETH on Arbitrum. Unichain is used only for the backtest, via Blockscout in 1000-row pages.

```
data/oracle-registry/config/
  subjects.json   cursors.json   lz-metadata.json
  events/<chainId>/<emitter>.jsonl   (gitignored cache)
  state/<subject>.json    changes/<subject>.json    queues/<subject>.json (step 2)
  backtest/kelp-rseth.expected.json
```

**Step 2a: pending changes, read on-chain.** For each `CallScheduled`, read `getTimestamp(id)`:

| Value | State |
|---|---|
| > now | pending |
| 2…now | **armed** (executable now) |
| 1 | executed |
| 0 | cancelled |

Then:
- Decode the calldata. `scheduleBatch` emits one log per call.
- Diff any EndpointV2 `setConfig` against the live config, and carry the `eta` onto the change.
- Also read the Sky spell `eta`/`done`, Lido Dual Governance proposals, and WBTC whitelist `Submission`s on `0x4dbb…`.

**Step 2b: proposed changes, read off-chain.**
- **Sources:**
  - Safe Tx Service. It needs an API key, since unauthenticated use is capped at 5,000 requests per 30 days. It is the only pending source for Kelp, because Kelp's Safes act without a timelock.
  - Snapshot.
  - Discourse.
- **Linking:** match a Safe transaction to its timelock op by recomputing `hashOperation`.
- **Also watch:** ether.fi's 2-day Operating Timelock `0xcD425f44…`.

## 4. v1 subjects (6)
| Subject | Covers | Why |
|---|---|---|
| rsETH | LRT, LZ+CCIP | The reference case. Effective delay is 0: the 6-of-11 Safe can grant MINTER instantly, and a 3-of-6 Safe holds the DVN config. |
| weETH | LRT, 20 routes | 36 armed ops, including a stale 2024-03 LiquidityPool upgrade to `0xd27a57bb…` that can still be executed today. The L1SyncPool delegate is a 4-of-7 Safe. |
| USDe (sUSDe shares the owner) | bridged, 25 routes | Live pending changes: 2 `scheduleBatch` ops, ETA 2026-10-06 08:36 and 08:41 UTC. |
| WBTC | bridged, LZ plus a Chainlink-run CCIP pool | A historical red: 8-of-13 → 6-of-10 on 2025-03-28. |
| cbBTC | custodial, all EOAs | Zero delay. Owner, admin, masterMinter and pauser were all rotated between 2026-09-29 and 2026-10-02. |
| PT-srUSDe | PT | AD-7 fires (a 3-of-5 Safe holds TIMELOCK_ADMIN), and srUSDe has an armed `setProvider` op anyone can execute. The subject is keyed on the SY so it survives the 2026-10-22 expiry. |

Added since: sUSDe, and wstETH (2026-10-07, the 8th subject: see "wstETH, the 8th subject" at the end). Deferred: sUSDS.

## 5. Kelp backtest
`scripts/oracle-registry/config/backtest-kelp.mjs` runs from a committed fixture.

What it scans:
- **Ethereum, blocks 19,166,120 → 24,908,284** (the last block before the exploit):
  - `PeerSet` and `OwnershipTransferred` on adapter `0x85d456B2…`;
  - `UlnConfigSet` and `DefaultUlnConfigsSet` on SendUln302 `0xbB2Ea70C…` and ReceiveUln302 `0xc02Ab410…`, filtered to the adapter;
  - `DelegateSet` on Endpoint `0x1a44…728c`.
- **Unichain:** `UlnConfigSet` for the eid-30320 peer, near block 12,785,388.
- **Point reads:** `getConfig` must return 1-of-1 at both block 24,907,000 and block 24,908,284.

| Date | Block / tx | Route | Expected |
|---|---|---|---|
| 2024-03 | 19,446,017 | Manta: optional DVN `0xa09db514…` has no code | red BR-4 |
| 2024-03-21 | 19,480,800 `0xf64d02e5…` | Mode, Blast: 2-of-2 → 1-of-1 | red BR-1, BR-2 |
| 2024-04-01 | 19,559,426 `0x21e967c9…` | Arbitrum, Optimism: a 1-of-1 override replaces an inherited 2-of-2 | red BR-1 |
| 2024–26 | 19,512,610; 19,662,870; 21,695,295; 23,167,809; 23,375,859; 24,140,229 | Base, Linea, Bera, Avalanche, Plasma, Mantle: same pattern | red BR-1 |
| 2025-03-14 | 22,046,465 | Movement set to 2-of-2 | not red |
| 2025-04-02 | 22,179,964 `0x2d48d933…` | **eid 30320 created at 1-of-1** (it had been blocked on the dead-DVN default) | red BR-2, on both chains |

**Honest framing (owner ruling 2026-10-06).** The card would have shown Kelp's exploited route red for about a year before the exploit — 381 days, from its creation under the floor on 2025-04-02 — but it would also have shown about 45% of comparable apps red: 825 of 1,835 OApps that override their receive config had at least one live route under the floor at block 24,908,284 (Kelp ranked #4 by number of such routes). The floor is a broad flag, not a discriminator.

**SEVERITY RANK (owner rulings #5 and round 2 #9, built).** Floor breaches are ranked by the value at risk behind the route: the larger of the Ethereum adapter's locked balance and the remote chain's bridged supply, priced in USD with the registry consensus (times an on-chain rate when the token is not a catalog asset: rsETH = ETH consensus × `LRTOracle.rsETHPrice()`). The card shows it on every floor-breach row and in the red banner, and sorts by it, worst first (`lib/oracleRegistry/config/value.ts`). At block 24,908,284 the exploited route carried **$295M**: 116,723.5 rsETH locked in the adapter × $2,527 (ETH consensus $2,362.90 at that block, from an archive snapshot of the registry, `backtest/registry-at-eval.json`); the Unichain peer's supply was 49.3 rsETH. Across the 825 floor-breaching OApps, Kelp ranks **#1 of the 8 that the registry can price**; 817 could not be priced (a token the registry does not price — the registry covers ten assets — or a native OFT with nothing locked on Ethereum), and remote supplies are not read for the base rate. So the rank puts Kelp first where it can be computed, but it is computed for 1% of the apps: the registry's asset coverage, not the rule, is the limit. **Owner ruling 2026-10-08 (#14):** a floor breach whose value at risk was NOT READ sorts FIRST on the card, labelled "value unread" (fail closed: an unread value could be the largest). On a card listing all 825, the 817 unpriced breaches would therefore be listed ahead of Kelp. The framing says so. `kelp-rseth.expected.json` carries this framing as computed text (`framing`).

The backtest passes when all of these hold:
- At least one red change on eid 30320 is dated before 2026-04-18 17:35:35 UTC.
- The head state at block 24,908,284 lists eid 30320 as a floor breach.
- Movement has no red DVN changes. Its 2025-03-21 peer re-point (block 22,094,020) is red under the strict BR-6, and that is correct; it is listed apart (`peerRepointsRed`), not gating.
- `unannounced` is null throughout.

After the exploit, the timeline should also show:
- 2026-04-23: a move to 4-of-4 (upgrade).
- 2026-06-15: 22 peers zeroed.
- 2026-09-08: a DVN swap on Arbitrum (neutral).

## 6. UI
- **Placement:** a sub-tablist with **Oracles | Config** tabs on `/[chain]/oracles`. It reuses the `AssetTabs` roving-tabindex pattern and deep-links as `?asset=rseth&view=config#<changeId>`. Config gets its own tab because the oracle panel is already long.
- **rsETH** gets a config-only tab.
- **Asset tabs** show a red count of downgrades and floor breaches.
- **Card layout:**
  - **Header:** effective delay per power, floor breaches, and a NO-GOV-CHANNEL chip where relevant.
  - **Four dimension blocks:** bridge is a route table with one row per chain×eid×direction, showing E, the DVN operators and the owner/delegate.
  - **Timeline:** Pending first, then Proposed, then Historical.
- **Colours:**
  - **Pending:** a `warning` amber border plus a "PENDING · ETA" label. It is a border, not a fill, so it does not clash with the gold outlier colour.
  - **Proposed:** blue. This needs a new token because `info` is teal.
  - **Historical:** `textTertiary` grey.
  - **Downgrade:** a 3px `danger` border plus a DOWNGRADE chip, in any state.
  - **Unannounced:** an outlined UNANNOUNCED chip.
  - The state is always also written as text.
- **Links:** each change links to its tx, its governance post or queue entry, and its rule IDs. `etherscanTx` only covers Ethereum, so add an explorer helper keyed by chain.

## 7. Telegram
There are two existing bots:
- **Operator digest:** `scripts/lib/notify.mjs` (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, plain text), called by `scripts/check-venue-alarms.mjs`.
- **Address-alert bot:** `scripts/lib/telegramBot.mjs` plus `components/Radar/telegramLogic.ts`, with subscriptions stored in Neon.

v1 adds `scripts/oracle-registry/config-alerts.mjs`:
- It accepts only `--dry-run`; anything else exits with code 2.
- It selects red changes in any state, plus all pending and all unannounced changes.
- It dedupes on `${id}:${state}`.
- A pure `formatConfigAlertLine` formats each line in the style of `formatAlarmLine`, for example: `[RED · PENDING] weETH admin: stale LiquidityPool upgrade (AD-8) · ARMED · <tx> · membrane.money/ethereum/oracles?asset=weeth&view=config#<id>`.
- Output goes to stdout and to `config/alerts-dryrun.jsonl`.
- `fetch` is injected, and a test asserts it is never called.

Later, alerts are delivered through `notify(…, { format })`, and the bot gets a `/watch <asset>` command.

## 8. Tasks (in order, each with tests)
1. `configTypes.ts` plus `subjects.json`, with a validating loader tested the same way as `oracleRegistryCatalog.test.ts`.
2. A pure `configRules.ts` (`effectiveUln`, E, `controllerRank`, `classify`, floor checks), with one positive and one negative test per rule ID. Required cases:
   - USDe DVN swap → neutral
   - Ethena 10M→20M → not red
   - Kelp limit 0 → not red
   - WBTC 8/13 → 6/10 → red
   - cbBTC EOA→EOA → neutral
3. Shared plumbing, plus the LZ, admin and mint/redeem readers, with mocked-RPC tests.
4. The change builder (values carried forward between snapshots) and the oracle mapping.
5. The Kelp fixture and a backtest test that asserts everything in §5.
6. `configServer` and `configView`, plus `/api/oracles/[asset]?view=config`.
7. The UI, with viewModel tests for the state colours and the red overlay, then a browser check at 375px.
8. Step 2a queues. Tests:
   - The USDe batches, read before their ETA, give 84 `setConfig` calls containing one DVN swap (neutral, pending).
   - The weETH 2024-03 op is red under AD-8.
9. Step 2b: the Safe, Snapshot and Discourse sources, plus the unannounced matcher.
10. Step 3: the dry-run alerts.

## 9. Open questions
1. Should the spec and marketing copy be corrected to read: "Kelp explicitly configured a single LZ Labs DVN on the exploited route; it had downgraded two other routes from 2-of-2 to 1-of-1 in March 2024."? Note that Kelp disputes that LayerZero warned it.
2. For Proposed, do we add a blue token or use the existing teal?
3. Should stale armed ops (weETH has 36) show as amber "armed"?
4. Should granting EXECUTOR to address(0) be red? Kelp does this by design.
5. Should `large_raise` be red instead of a tag?
6. CCIP 2.0 verifier sets have not been researched. Note that the rsETH pool's rebalancer can withdraw locked rsETH.
7. Which L2s and RPC keys should v1 cover?
8. Who pays for the Safe API key, and which data is free versus paid?
9. Should alerts go to the operator chat or to curators?
10. Should rsETH be added to `catalog.json`?

## Critique (binding fixes)

**Verdict: breakable.** The design marks the actual attack as neutral, and the downgrades it misses fall into four groups.

**Bridge**
1. **BR-6 marks the attack itself neutral.** An attacker swaps two reputable DVNs for two DVNs they deployed themselves. The count stays the same and BR-4 passes because the new DVNs have code.
   - Fix: count E as distinct *known operators*, using LZ metadata as of that block.
   - An unknown DVN, or two DVNs from one operator, is red (new rule BR-7).
   - The DVN `quorum`/signer data is already collected but has no rule. A quorum drop, or a signer added at the same quorum, should be red.
2. **The E arithmetic is wrong in three places.**
   - "Explicitly zero confirmations" is stored as `type(uint64).max`, not 255. A naive compare reads it as an increase, so BR-3 misses it.
   - Adding an optional DVN while the threshold stays the same gives an attacker more DVNs to choose from, but E does not change. Make it red.
   - Dedupe across required and optional before counting.
   - Take merged values from the library's `getUlnConfig(oapp,eid)`. Use your own merge only for replay, and cross-check it against head.
3. **Configs on the other chains are unread.** A forged L1→L2 message mints rsETH on the L2. A legitimate L2→L1 message then drains the Ethereum lockbox, while the Ethereum side shows E=2. Reading `getConfig` on each peer chain takes a few `eth_call`s and no log scans, so do it for every route in v1. Otherwise show "REMOTE UNREAD".
4. **Library rules have gaps.**
   - During `receiveLibraryTimeout` the old library still verifies messages. Effective E is the minimum over both libraries.
   - `DefaultReceiveLibrarySet` silently drops an OApp's override, because configs are stored per library. Key the effective config by (oapp, eid, lib).
   - BR-5's hard-coded list will wrongly flag the next ULN version. Take the list from LZ's deployment metadata.
5. **Snapshot diffs miss flash flips.** Example: set 1-of-1, commit a forged message, revert. Build changes from the event sequence, and make A→B→A within N blocks red (`flash`).

**Admin**
- AD-1 points the wrong way. Removing a signer at a fixed threshold is not a downgrade. *Adding* one while keeping the threshold widens the attack surface, so flag that instead.
- A Safe's rank must be the minimum of its threshold rank and each module controller's rank.
- Diff these Safe fields at head on every run, since a delegatecall can change them without emitting an event:
  - a guard that is replaced, not only one set to zero;
  - the Safe 1.5 module guard;
  - the fallback handler;
  - the slot-0 singleton.
- AD-7: OpenZeppelin v5 timelocks have no TIMELOCK_ADMIN_ROLE, so also check DEFAULT_ADMIN_ROLE.
- An upgrade through the timelock is never flagged, yet a logic change can matter as much as a config change.
  - Mark every `Upgraded` and `BeaconUpgraded` amber LOGIC CHANGE, with a source-diff link. The beacon emits the event, not the proxy.
  - Make it red if the new implementation is unverified.
- **Dependencies:** a rate provider, oracle, DVN or minter that is a proxy becomes an implicit subject. Effective delay is the minimum over that whole graph.
- **Armed ops:** only count an op as ARMED if its predecessor is done and an `eth_call` of `execute()` from an executor succeeds. This removes false reds among weETH's 36 armed ops.
- **Q4:** EXECUTOR = address(0) is standard open execution, so neutral.
- **CCIP:** add TokenAdminRegistry `PoolSet` and administrator transfers, remote pool/chain additions, a rate limiter being disabled, and `RebalancerSet`.

**False UNANNOUNCED flags**
- Cap raises, DVN signer rotations and keeper ops never get forum posts.
- Ethena and Kelp announce on X and Discord, which the matcher does not read.
- Score only changes made through a governance-controlled path. Label operator-key changes OPERATIONAL instead.
- A medium match such as "setConfig" will mark almost any change as announced. Require the exact value. A matched post that names a different value should be red DIFFERS-FROM-ANNOUNCED.

**Data that isn't public or free**
- Safe Tx Service only shows proposals submitted through its API, so an empty queue does not mean none are pending.
- Etherscan source verification needs a key.
- LZ `deprecated` flags and DVN names reflect today, which leaks hindsight into the backtest.

**The Kelp backtest is circular**
- The subject, contracts, blocks and BR-2's E<2 threshold were all chosen from the outcome.
- `unannounced: null` is hard-coded, so that check passes trivially.
- Call it a regression test. To make it a detection test:
  - freeze the rules;
  - discover OApps generically from the Endpoint;
  - at block 24,908,284, run against at least 20 non-exploited OApps;
  - report how many live routes have E<2 and where Kelp ranks;
  - use metadata only as of that block.

**UI states that look calm**
- A floor breach with no recent change event needs a persistent red banner and an alert, not just a header count.
- A grey historical downgrade that is still in force looks resolved. Add STILL IN EFFECT.
- A collector that failed or went stale shows an empty timeline. Show "as of block N, age" and a STALE marker.
- `unannounced: null` gives Kelp fewer chips than governed assets. NO-GOV-CHANNEL needs the same visual weight.
- When a pending change is also a downgrade, the red border wins over amber.
- Show "0s" delay as INSTANT. For zero-delay Safe controllers, show "pending changes not observable".
- Seed the alert dedupe before the first run, or the 36 armed ops will flood it.

## Review fixes (2026-10-06)

Three adversarial reviews (on-chain, rules, UI) found states that read calmer than the chain. The
fixes below are in the engine, collector and UI, each with a test.

**Reads fail closed.**
- A failed `getConfig`, library or `peers()` read is UNREAD (amber). A route is "blocked (no_dvn)" only when the library itself reverted.
- On a remote chain:
  - a failed direction read is REMOTE UNREAD for that side;
  - a failed peer read assumes the route is live.
- A timelock `getTimestamp` that cannot be read keeps the op listed with the `state_unread` tag, instead of "cancelled".
- A ready op whose execute could not be simulated counts as armed and gets the `not_simulated` tag. This covers a salt that was not recovered and an RPC error that is not a revert.
- Pre-4.9 OZ timelocks emit no `CallSalt`. The salt is now recovered from the scheduling transaction's calldata.

**Bridge.**
- A route is closed only when no library can verify. The old library in its receive grace period still counts, and a library outside the allowlist verifies at E = 0 (BR-5 + BR-2).
- A route that reopens is compared with the config it last ran with, so a downgrade written while it was blocked is BR-1.
- BR-9 now also flags any weaker step inside a transaction that the transaction undid (a peer A → B → A, confirmations set to NIL and back).
- Pending and proposed calls are judged in order against a working copy of head. A batch that reopens a route and then weakens it is red. So is a pending `setPeer` that reopens a route under the floor.
- Remote routes are diffed from run to run, as a `bracketed` change.

**Admin.**
- Controllers are classified from their code.
  - A timelock needs the OZ (or RBACTimelock) dispatch table.
  - A Safe needs a canonical singleton in storage slot 0.
  - A timelock bypass is read and lowers the effective delay to INSTANT for what it reaches: Ethena `executeWhitelisted` per whitelisted (target, selector), and RBACTimelock `bypasserExecuteBatch` for everything.
- In the controller rank, a timelock with no delay or with an unrestricted bypass counts as a plain contract. A contract that defers to an owner ranks strictly below that owner. (Superseded on 2026-10-08 by ruling #12: a timelock ranks as its weakest proposer, and a delay under 24 h adds nothing. An unrestricted bypass still caps it at a plain contract.)
- Multisig changes are replayed from the events of each transaction on top of an exact archive read. They never fall back to the head classification.
- A Safe threshold or owner change with no event is diffed from run to run.
- An owner set from address(0) counts as initialization only:
  - in the deploy block, or
  - as the first owner of a contract still running the code it was deployed with.
- The first MINTER grant after deployment is a new minter (MR-2).
- Proposed Safe self-calls are decoded:
  - threshold and owner changes (AD-1);
  - modules, guards and the fallback handler (AD-6).
- A pending grant is judged against the role's current holders.

**AD-9 (changed meaning).**
- AD-9 is red when an implementation, a rate provider or an oracle source is replaced by code whose source is not verified on Sourcify or Blockscout, or whose verification could not be read.
- A verified replacement is an amber LOGIC CHANGE.
- Etherscan is not checked: there is no key.

**Other.**
- OR-1 is wired to the oracle collector's governance events: a source moved to an EOA, and CAPO growth or heartbeat bounds loosened.
- A getter change found by polling keeps each intermediate value, with its own block and transaction.
- STILL IN EFFECT lasts until a later upgrade, a closure, or a later change that moves the value away (for example, a role revoked from the account a red grant added).

**UI.**
- A subject with no collector output says "not collected" instead of zeros and "no red flags".
- Red stale ops count as open red flags, and their group opens.
- Permalinks have accessible names, and unread reasons are visible text.
- Small red and grey text uses tokens with at least 4.5:1 contrast in dark mode.

## Review fixes, round 3 (2026-10-06)

A third adversarial review (on-chain, rules, UI) of the round-2 fixes. Every item below has a test in `tests/unit/oracleRegistryConfigRulings.test.ts` that failed on the code before the fix.

**Owner rulings implemented.** BR-3 (zero or below LZ's default), AD-6 (guard added = upgrade; removed or replaced = red), BR-6 strict (Kelp backtest criterion: "Movement has no red DVN changes"), operational vs anomalous bot grants (AD-4 above), and the honest Kelp framing (§5).

**Engine.**
- Only the subject's own Safes are diffed run to run (declared, power graph incl. deferral chains, timelock-admin holders, queue Safes, OApp owners / delegates). One app's Safe change no longer appears on every card.
- A Safe whose slot-0 singleton was swapped, so that it no longer classifies as a Safe, is red AD-6 (the collector keeps a non-canonical singleton on the contract it returns, and the snapshot keeps tracking it).
- A timelock bypass lowers a power's delay only through the functions that exercise it: an LZ delegate acts on the endpoint's config functions; any other power counts every whitelisted function on the contract acted on (fail closed) except the subject's `bypassExclude` list (pure restrictions, or another power's functions). Non-reaching whitelisted functions are listed with "outside this power, its delay is kept".
- An Ethena whitelist that cannot be read ranks the timelock as a plain contract with no delay for that run (owner ruling), and the card says so ("whitelist UNREAD").
- A power holder the collector could not classify is kept with no delay, never dropped.
- The remote side is evaluated while either Ethereum direction is live. A remote route unread in one run keeps its last read (with the block it was read at), so a downgrade across an unread run is still bracketed.
- STILL IN EFFECT: a same-rank rotation carries a red forward instead of ending it; a later change ends a red only when it moves the value away (the replaced value is the event's `before` or, for slot keys, the last value set); role and minter keys are sets (a removed minter ends its red, an allowance change does not).

**Admin / mint replay.** An unread previous holder never makes a move to an EOA an upgrade (red; non-EOA successors are neutral with a note). A privileged grant to an unclassified account is red. `RoleAdminChanged` is judged (AD-3 on who can grant the role). The first `MinterConfigured` after deployment is a new minter (MR-2). FiatToken role changes with the previous holder unread are judged against null; the CCIP token administrator is judged against the last one the events set. DVN signer rows are replayed from `UpdateQuorum` / `UpdateSigner` on an exact read at block − 1 (a quorum lowered and restored in one transaction is red DV-1 `flash`; an unread state before is red).

**Queue.** An unread predecessor fails closed (`armed_unverified`, never stale). An op whose `getTimestamp` is unread is judged as armed (AD-8, stale rollback) while its stage stays "scheduled". Calls routed through `executeWhitelisted`, `executeWhitelistedBatch` or `bypasserExecuteBatch` are unwrapped and judged (noted "timelock BYPASS: executes with no delay"). A pending `updateDelay` with the current delay unread is red AD-2. The collector now reads `owner()` of every subject contract, so a queued `transferOwnership` is judged against the current owner.

**UI.** The tab never says "no red flags" for stale output or unread route sides (`?n` and `░` marks, spoken). With no collector output the block counts and the timeline count line say "not collected"; with change files but no head state, the headline states the queue counts and says breaches are unknown. Small text in the config components uses AA tokens only (a source scan test enforces it). The no-pending-window tooltip names the timelock bypass, and a NO-GOV-CHANNEL card no longer lists Snapshot / forum as "not ingested".

**Deferred in round 3, resolved in round 4 (below).** A wider DVN set at the same threshold; an owner set from address(0) long after deployment; unrecognised roles as privileged; a second CCIP remote pool for the same chain; source verification fail-closed and lookup-failed vs not-verified; DVN operator grouping (Mantle entities, issuer-run DVNs); the severity-rank metric; whether a no-delay owner contract (BitGo WalletSimple) or a legacy MultiSigWallet has an observable pending window.

## Round 4 (2026-10-07): round-2 owner rulings #6–#11 and the defaults

Every item has a test in `tests/unit/oracleRegistryConfigRound2.test.ts` that failed on the code before the change (25 failed, 4 regression guards held), and passes now.

**Rulings.**
- #6 BR-8 is AMBER (`WIDER DVN SET`): a wider DVN set at the same effective threshold. An unknown added DVN stays red (BR-7).
- #7 AD-3: a first owner set from address(0) more than 7,200 blocks after deployment is red; within it, initialization.
- #8 / #10 / #11 bot grants: the pattern, the revised burst (a batch larger than the largest earlier one-day batch; no history ⇒ more than 3 per day), the rate spike, admin-level config roles, and unrecognised roles judged privileged (see AD-4 above). Two existing tests were revised to the owner's new numbers (the old burst test, the old red BR-8 test).
- #9 severity rank: `value.ts` + the collector reads (adapter `token()` / `balanceOf`, remote `totalSupply()`, registry consensus from `snapshots/latest.json`, the subject's `valuation` in `subjects.json`), the engine attaches `valueAtRisk` to every route item, the card sorts floor breaches by it. Kelp numbers in §5.

**Defaults the owner did not object to.**
- CCIP: a second remote pool for an already-served chain is red (CC-1, strict like BR-6); the collector reads `getRemotePools` for pending calls.
- Source verification stays fail-closed, but a FAILED lookup is tagged `VERIFICATION LOOKUP FAILED`, distinct from `NOT VERIFIED` (checked).
- Mantle's DVNs (mantle01–03, mantle-bank, mantlecross) are one operator.
- Issuer-run DVNs (fbtc, usdt0, ondo) count as independent and are labelled `issuer-run` in every display.
- The tab never says "no red flags" over partial data: besides unread route sides and stale output, any read that can hide a red flag (an unresolved power holder, a Safe Tx Service or multisig queue not read) is a read gap (`?n reads failed`).
- An unreadable Ethena whitelist ranks the timelock as a plain contract with no delay (already in round 3; tested there).
- BR-3 with the LayerZero default unread stays red with a note (already in round 3; tested there).
- A legacy Gnosis MultiSigWallet (WBTC's Controller and Members owners): its submitted-but-unexecuted transactions are PENDING (`PENDING · 2/6 CONFIRMED`; a fully confirmed one whose execution failed is ARMED), read with `getTransactionIds` / `transactions` / `getConfirmationCount`. Its power is "pending observable" only when its submissions were read.
- A no-delay owner contract (BitGo WalletSimple, an unclassified holder) shows "no pending window · INSTANT"; so does a timelock with no delay.

## Review fixes, round 5 (2026-10-07)

A fourth adversarial review (on-chain, rules, UI) of round 4. Every item has a test in `tests/unit/oracleRegistryConfigReview5.test.ts` that failed on the code before the fix (42 of 51 failed; the 9 that held are controls), and passes now.

**On-chain.**
- A power-graph controller that is not a declared subject contract (a shared timelock found through a holder path) is charged only from the first block an event on another contract named it as a holder (owner, admin, role grantee, CCIP administrator, LZ delegate). Its own earlier events are replayed for state but not filed. No such event ⇒ its whole history stays (fail closed). WBTC no longer carries the CCIP RBACTimelock's 2023–24 history (23 rows, 2 of them red delay cuts): the first event naming it as a WBTC holder is the CCIP pool's ownership transfer at block 21,890,003; WBTC's red count drops from 15 to 13.
- Safe guard, module-guard and fallback-handler rows carry the value they replaced (the last one the events set, else the exact archive read at block − 1), never "?".

**Bridge.**
- BR-6 holds through a zeroed peer (A → 0 → B) in the replay, in pending `setPeer` calls and on the remote side between runs (`remoteLastPeer` in the state file).
- The old receive library in its grace period is compared in full: a weaker config written to it (confirmations to NIL, DVNs) is a change, and BR-3 uses the fewest confirmations over every library that can verify.
- The remote receive library's grace period is read and kept (its expiry judged on the remote block read just before; unknown ⇒ active). A grace library, local or remote, whose config could not be read leaves the side UNREAD instead of dropping it.

**Admin / mint.**
- AD-6: a guard replaced when the old one predates the scan reads red (the archive read at block − 1); with no read and a Safe older than the scan, the previous guard is unread and the row is red (fail closed).
- AD-3: ownership taken back after a renounce is red; an owner set from address(0) after an upgrade with no earlier owner seen is judged against an unread holder (an EOA or an unclassified owner is red). A FIRST LZ delegate set more than 7,200 blocks after the OApp's deployment is red (ruling #7).
- AD-4: CANCELLER_ROLE (admin-level) is privileged: a grant to a wallet is red. Every admin-level role is privileged by construction.
- AD-1: see §2.
- MR-2: a rate provider / price oracle that is a contract an EOA controls ranks with that EOA (red, also as a head-state breach). Provider and oracle-source verification resolves an EIP-1967 proxy: a verified proxy in front of an unverified implementation is not verified.

**Queue.**
- CCIP pool and TokenAdminRegistry calls are decoded and judged: `setRemotePool`, `applyChainUpdates` (1.5.0 and 1.5.1+), `removeRemotePool`, `setChainRateLimiterConfig(s)`, `setRebalancer`, `setSiloRebalancer`, `updateSiloDesignations`, `setPool`, `transferAdminRole` (CC-1 / CC-2 / CC-3 / AD-3, + AD-8 when armed). A call that still cannot be decoded is a loud CALL NOT DECODED chip.
- A pending revoke (or renounce) of the last pauser is red MR-1, judged in order inside the op.
- A fully signed Safe proposal is ARMED (AD-8 on a red call): anyone can execute it.

**CCIP 1.6 siloed pools.** Each siloed chain's rebalancer is read (`isSiloed` / `getChainRebalancer`) and judged (CC-3 at head); `SiloRebalancerSet`, `UnsiloedRebalancerSet` and `ChainSiloed` are scanned. WBTC's card no longer reports the unset unsiloed rebalancer as "renounced".

**UI.**
- The timeline shows every note; the operational / anomaly reason leads them. ANOMALY, NOT VERIFIED and VERIFICATION LOOKUP FAILED chips are red (they only explain red rows); OPERATIONAL stays amber.
- The Oracles block and its filter say "not collected" for a subject whose oracle events are not collected, and name the window (`last 180 d`) otherwise.
- A tab with no collector output carries a `∅` mark; failed reads have their own `!n` mark (unread route sides keep `?n`); mark keys are unique.
- The card lists failed reads, and the headline is hedged over unread sides and failed reads ("red flags may be missing").
- Each breach in the red banner names its route ("eid 30110 (arbitrum) receive"); `$999.6M` reads `$1B`.

## Review fixes, round 6 (2026-10-07)

A fifth adversarial review (on-chain, rules, UI) of round 5. Every item has a test in `tests/unit/oracleRegistryConfigReview6.test.ts` that failed on the code before the fix (46 of the first 49 failed; the 3 that held are controls; a fourth control — a shared timelock's whitelist for a contract that is not the subject's is not filed — was added with the fix), and passes now. The collector was re-run at block 26,138,697 and the Kelp backtest re-run (byte-identical, pass).

**On-chain.**
- The Safes that hold PROPOSER / EXECUTOR / CANCELLER / admin roles on a declared timelock are in the subject's scope (`subjectExtraEmitters`): their events were scanned, then dropped by the per-subject filter, so weETH's 10-day-timelock proposer Safe and Strata's proposer Safe lost their AD-1 rows.
- AD-4 uses `isEoaControlled`: a privileged role granted to a contract an EOA controls (WBTC's CCIP RBACTimelock PROPOSER / CANCELLER to an MCMS that was EOA-owned when granted at 22,234,034 — its ownership moved to the RBACTimelock at 22,290,213, see round 8) is red even with no classified current holder; unclassified holders are noted, not silently dropped.

**Rules.**
- AD-2 whitelist rows are judged per card: a function whitelisted on one of the subject's contracts that reaches a declared power is red (an unmatched subject contract fails closed); one on another asset's contract (the Ethena timelock is shared) is not filed. At head (re-run): USDe / sUSDe OFT adapter owner (`setPeer` whitelisted), USDe minter contract (EthenaMinting functions whitelisted; the mint power declares no `bypassExclude`) and WBTC's CCIP pool owner (`bypasserExecuteBatch`) carry the AD-2 breach.
- AD-1 swaps (above). MR-2 / AD-9 through a zeroed value: A → 0 → B is judged as A → B (replay and queued setters).
- The remote side is judged whatever Ethereum does (both directions closed, or the Ethereum peer zeroed — the collector reads the remote OApp at its last non-zero peer), and a remote side reopened after a closed spell is compared with the config it last verified with (`remoteLastVerifying` in the state file).
- A Safe DELEGATECALL to anything but a Safe library (MultiSend, SignMessageLib) is a red AD-6 row (`DELEGATECALL`), pending or proposed — the Bybit singleton-swap shape (the Safe Tx Service `operation` is kept; MultiSend entries carry theirs).
- Declared parameter setters are decoded and judged against head (`ParamSpec.setter` in `subjects.json`: deposit limits, price oracles, pricePercentageLimit, USDe minter, EthenaMinting caps, cooldown, masterMinter / pauser, WBTC factory, APR bound, oracle quorum), plus `changeProxyAdmin` (AD-3) and `setContract` (MR-2 / AD-9). An armed one breaking a rule is AD-8.
- RoleAdminChanged to a role with no holder is never an upgrade; a role that administers another is privileged (its grant to an EOA is red).
- The run-to-run Safe diff compares head with what the EVENTS since the last run left (a silent drop after an evented change was masked) and the owner set (`Controller.owners`).
- BR-3 floor (above); BR-7 / BR-4 look at the receive library in its grace period too.
- A pending batch's sibling grants count in the burst and rate windows.
- An oracle source set as the first event of the window is judged as a replacement (AD-9 unless verified).
- A queued `setGuard` on a Safe (or field) not read at head is red (fail closed), never "guard added".
- Solady `RoleSet` (ether.fi RoleRegistry) is scanned and replayed as RoleGranted / RoleRevoked; its roles are not recognised, so a grant to a wallet is red (ruling #8).

**UI.**
- A fully signed Safe proposal reads `PROPOSED · ARMED · 6/6 SIGNED` and the headline counts it (`1 proposed (1 armed)`).
- A batch repeats its calls' loud chips on the header (WIDER DVN SET, CALL NOT DECODED, the new `TIMELOCK BYPASS`, `DELEGATECALL`) and opens when it carries one.
- Filter labels count the full timeline (`timeline.totals`); pressing a filter on a trimmed timeline loads the rest.
- Power notes (bypass functions and who holds the bypass, a holder not classified at head) reach the card; an unclassified holder and an unread whitelist are read gaps.
- The card remounts per subject (filters reset); "All" clears both filters; an active "Red only" can always be turned off.


## Review fixes, round 7 (2026-10-07)

A sixth adversarial review (rules, UI, on-chain) of round 6. Every item has a test in `tests/unit/oracleRegistryConfigReview7.test.ts`; all 37 failed on the code before the fix (some carry a control assertion inside), and pass now. Two round-5/6 tests that matched the old filter-button source were moved onto the new `timelineFilterButtons` output (same behaviour, asserted on the function).

**Rules.**
- AD-5 / AD-8 / AD-3 through an undeclared ProxyAdmin: a queued `upgrade` / `upgradeAndCall` / `changeProxyAdmin` is the subject's when its PROXY argument is (not only its target). The collector records the intermediate hops of every power path (`PowerRead.via`, e.g. the ProxyAdmin of an `eip1967_admin` step): their own events are scanned (an ownership move of the ProxyAdmin is filed) and calls queued on them are in scope. weETH's two OFT ProxyAdmins are covered this way.
- CC-1 through address(0): a TokenAdminRegistry `PoolSet` A → 0 → B and a 1.5.0 `RemotePoolSet` A → 0 → B are re-points (red), like BR-6 peers.
- CC-1 in the queue: re-adding a remote pool to a chain the pool no longer serves is red when the pool is not one the chain ever accepted (`ccipEverRemotePools`, replayed from `RemotePoolSet` / `RemotePoolAdded`).
- AD-6 between runs: guard, module guard and fallback handler are compared with what the EVENTS since the last run left (an evented `ChangedGuard(G1)` no longer hides a silent G1 → G2 at head); modules are matched one by one.
- OR-1: an oracle source moved to a contract an EOA controls is red (`isEoaControlled`, as MR-2).
- Rank model (**owner sign-off requested**): a threshold-1 multisig ranks with an EOA — any one signer acts alone. A privileged role granted to a 1-of-N Safe is red, EOA → Safe 1-of-N is not an upgrade, an unread previous holder replaced by one is red, and a power held by one carries the AD-3 head breach. Reverting is one line in `controllerRank`.
- BURNER_ROLE is privileged (Kelp `RSETH.burnFrom` burns any holder's balance with no allowance, the OFT adapter's lockbox included).
- A red role grant with no established bot pattern says so first ("no established MINTER_ROLE bot pattern yet: n of the 3 earlier grants…").

**On-chain.**
- The AD-2 whitelist matcher (history and queue) follows holder chains like the head bypass check: the contract a power is exercised through (EthenaMinting for "USDe minter contract") is matched with the same reach test; a holder-chain contract is never "foreign". The USDe minter power now declares the restrict-only EthenaMinting functions (`bypassExclude`), so head and history agree: the seven whitelisted selectors are restrict-only, the minter power keeps its 1 d delay.
- rsETH declares the ETHx price oracle (`assetPriceOracle:ETHx`, 0x3D08…dFd2), its proxy as a contract and its upgrade power (ProxyAdmin 0xb61e → Timelock 10 d).
- Every PROPOSER / EXECUTOR / CANCELLER / admin of a declared timelock is classified at head and in the run-to-run Safe snapshot (the Ethena EXECUTOR Safe 0xa075).

**UI.**
- Filter buttons come from `timelineFilterButtons`: with no collector output every one says "not collected" and is disabled; oracle rows in the change files count as collected when the state file is missing. Disabled labels use AA-contrast text with a dashed border.
- A closed-routes disclosure holding a red route opens and its summary counts the red ones.
- Before → after lines say what moved: a DVN contract swapped within one operator (operator + address, a `rotation` tag and a note), a peer re-point (titled as a peer change, peers on both lines), a queued `setPeer` (the peers, labelled send + receive, no send-side tag), multisig owner swaps (the owners). Two equal lines read "(same as before)".
- Floor breaches count ROUTES (`floorBreachRoutes`), the same unit as "under floor"; a subject with no LayerZero route reads "floor n/a", never "0 floor breaches".
- Pending legacy-multisig rows show their submission block (the collector scans `Submission` per multisig) or "block not read"; the legend says pending includes on-chain multisig submissions.
- A queued op is atomic under the filters (a batch never reads "0 red" because its red call is in another dimension). A selector the subject declares restrict-only is named, not a loud CALL NOT DECODED. The red banner is a region (the headline's aria-live already announces it). The rsETH note names the 10 d timelock as an on-chain pending source.

**Re-run (block 26,144,054, seven subjects; wstETH not re-collected).** Red rows: rsETH 82 → 85 (MANAGER and DEFAULT_ADMIN_ROLE to Safe 1-of-2 at 18,759,607; an unrecognised role to Safe 1-of-6 at 24,222,807), weETH 58 → 59 (role 0x5543… to Safe 1-of-5 at 25,533,308), PT-srUSDe 13 → 12 (the TIMELOCK_ADMIN grant to Safe 3-of-5 at 25,489,176 was red only because the EOA it replaced was unclassified; every timelock role holder is classified now, and a Safe replacing an EOA admin is not weaker), others unchanged. USDe state breaches 2 → 1 (the minter power keeps its 1 d delay; the OFT adapter owner's `setPeer` bypass stays red). weETH's two OFT ProxyAdmins now carry their ownership history; WBTC's 25 pending multisig submissions carry their submission block (oldest 7,144,784); 0xa075 is in the USDe / sUSDe Safe snapshots. Route rows with identical before → after lines: 228 → 0 (the 72 same-operator DVN swaps carry `rotation` and a note). The Kelp backtest re-run is unchanged in counts (227 changes, 55 red) and passes all five criteria; only the before → after lines of its peer rows changed.

## wstETH, the 8th subject (2026-10-07)

wstETH itself is immutable; the card covers the powers over stETH, its rate path, its redemption queue and the bridges that carry wstETH. Tests: `tests/unit/oracleRegistryConfigWsteth.test.ts` (parsers and rules), `…WstethAudit.test.ts` (first audit), `…WstethRemote.test.ts` (second audit, below).

**Coverage.**
- **Admin:** the Lido DAO path Aragon Voting (5 d LDO vote) → Dual Governance (`0xC1db…486E`) → EmergencyProtectedTimelock (`0xCE04…2316`, 3 d after submit, +1 d after schedule) → Admin Executor (`0x23E0…7021`) → Aragon Agent (`0x3e40…9c8c`). The effective delay of every Lido power is 8 d. The Aragon ACL is replayed from 2020 so that every permission's holder and manager is known. The Dual Governance line names its state, the emergency activation (4-of-7), execution (5-of-7) and reseal (5-of-6) committee Safes, the tiebreaker and the proposals canceller. DG proposals are read on-chain as pending ops (14 so far, none open).
- **Rate path:** LidoLocator pointers (accounting, AccountingOracle, sanity checker, VaultHub, LazyOracle), the HashConsensus quorum (5 of 9 members) and the OracleReportSanityChecker limits, plus the upgrade power over each of them.
- **Mint / redeem:** the stETH staking switches and staking limit, the Lido V3 external-mint cap (`maxExternalRatioBP` 3000), VaultHub. **Added in the second audit:** the WithdrawalQueue (stETH → ETH, `0x889e…F9B1`), with its pause switch and upgrade path. Its role history (GateSeal rotations; the reseal manager's PAUSE / RESUME at the Dual Governance launch) is replayed from 17,600,000.
- **Bridges:** the Chainlink-run CCIP SiloedLockReleaseTokenPool (9 chains; owner = the CCIP RBACTimelock, 3 h, with a bypasser). The Wormhole NTT manager to BNB Chain is locking, 2-of-2 Wormhole + Axelar. The L1 side of 13 canonical rollup bridges is covered: locked balance, deposit and withdrawal switches, proxy admin. Linea's is Linea-run, through a 0-delay timelock.

**Second audit (this pass).**
- **The NTT remote side is now read** (`readNttRemote`, `nttRemoteLines`, `nttRemoteGaps`). For each live peer, the remote manager is read at head on its chain through the LZ metadata's public RPCs. That covers the threshold and transceivers (BR-2 floor and BR-7 judged there too), its peer back to Ethereum (a mismatch is a warning), and the owner and pauser classified on that chain (an EOA-controlled owner is AD-3). It also covers the token supply there (burning mode = the bridged supply), which feeds the severity rank as max(locked, bridged), ruling #9.
  - A live peer with no remote read is a READ GAP (fail closed). One route breached on both sides is one floor breach.
  - Wormhole chain ids are mapped to EVM chains by a fixed table. An unmapped chain is not read, and the card says so.
  - Read on 2026-10-07: BNB Chain side 2-of-2 Wormhole + Axelar; 1,179.27 wstETH minted there; 1,179.3 locked on Ethereum.
- **Headline:** a card whose only floor-bound route is an NTT line reads "0 floor breaches", not "floor n/a" (`hasFloorRoutes`).
- **Role names:** Lido V3 `PausableUntilWithRoles.PauseRole` / `ResumeRole` hash to their namespace and keep the PAUSE / RESUME names and rules, like the BridgingManager roles. VaultHub's BAD_DEBT_MASTER / VALIDATOR_EXIT / REDEMPTION_MASTER / VAULT_MASTER, the WithdrawalQueue's FINALIZE / ORACLE / MANAGE_TOKEN_URI, the Voting's UNSAFELY_MODIFY_VOTE_TIME and Linea's TokenBridge config roles are named for display only. They stay PRIVILEGED (ruling #8), and no verdict changed. No role hash on the card is unnamed now.
- **Spot-checked on-chain, independently of the collector:** NTT threshold, transceivers, owner and pauser; the CCIP pool owner and the 3 h delay; the DG delays and the 5 d vote; the canonical bridges' EIP-1967 admin = Agent; Linea's ProxyAdmin owner = 0-delay timelock; stETH PAUSE_ROLE held by no one (manager = Agent); BUFFER_RESERVE_MANAGER_ROLE held by `0xfe59…f977`, a contract owned by the Aragon Voting directly.

**Result (block 26,144,725).**
- 19 red rows (11 still in effect), 0 pending, 0 proposed, 380 historical, 0 floor breaches, 1 head-state breach, no read gaps.
- **The breach:** AD-2, the CCIP pool owner's RBACTimelock has an unrestricted bypasser.
- **The red rows:**
  - AD-4: BUFFER_RESERVE_MANAGER_ROLE to a Voting-owned contract (block 26,054,464). The role can be used after a 5 d vote with no Dual Governance veto.
  - CC-1 ×3: remote pools re-pointed (23,843,863).
  - MR-1 ×2: stETH PAUSE / STAKING_PAUSE revoked from the Voting at the Dual Governance launch and granted to no one (22,817,714). Only the Agent, as permission manager, can grant them back, through Dual Governance.
  - AD-4 ×2: PROPOSER / CANCELLER on the CCIP RBACTimelock to an MCMS that was EOA-owned when granted (22,234,034), the same as on WBTC. Its owner has been the RBACTimelock itself since 22,290,213: round 8 marks both rows no longer in effect.
  - AD-3 ×8: NTT owner and pauser moves in 2024: Safe 3-of-4 → EOA, and Safe 3-of-4 → 3-of-5 (a signer added at the same threshold).
  - BR-2 ×2: the BNB route opened 1-of-1 (20,171,663), then sat at 1-of-2 until the threshold was raised to 2 (20,342,418).
  - AD-4: zkSync bridge DEFAULT_ADMIN to the deployer EOA for 40 blocks at deployment (18,413,104).

**Known gaps (wstETH):**
- History on the remote side (BNB Chain) and on the L2 sides of the canonical bridges is not scanned.
- The BNB owner `0x8e51…123d` is classified on BNB only. It is a contract, so it carries a warning, and the cross-chain executor is not followed back to the DAO.
- Aragon votes before they reach Dual Governance are not read.
- The tiebreaker committee internals and Polygon PoS / third-party wrappers are not covered.
- A deployment-time DEFAULT_ADMIN grant to the deployer EOA is red under AD-4, with no init window. This is consistent with PT-srUSDe and rsETH; ruling #7's 7,200-block window covers owners only. Extending it to first role grants is an owner call.

## Review fixes, round 8 (2026-10-07, final round)

Round 8 is the fourth refutation pass, run from three angles: on-chain, rules and UI. A confirmed bug that could make a dangerous change read calm, hide a red, or misstate chain data was fixed. Each one has a test in `tests/unit/oracleRegistryConfigReview8.test.ts`: all 31 fix tests failed on the code before the fix, and 10 controls passed both before and after. The other confirmed bugs, the gaps found while re-collecting, and every UNSURE item are registered in [CONFIG-CARDS-KNOWN-GAPS.md](CONFIG-CARDS-KNOWN-GAPS.md) (KG-1 to KG-3, UQ-1 to UQ-16).

**Rules.**
- **Upgrade with a call attached.** The call inside `upgradeToAndCall(impl, data)`, and the call inside a ProxyAdmin's `upgradeAndCall(proxy, impl, data)`, is judged as a call on the proxy. Before, an onlyOwner `transferOwnership(EOA)` hidden there read as one amber `logic_change` row.
- **Unread NTT reads.** A Wormhole NTT peer that could not be read counts as possibly live (fail closed): the floor is judged, and the read is a read gap. These are read gaps too:
  - an unread or unclassified Ethereum NTT owner;
  - an unread or unclassified canonical-bridge proxy admin (unless the bridge is ossified).

  `readNtt` also sweeps every EVM chain Wormhole maps, so a false-empty `PeerUpdated` scan cannot leave `peers` empty.
- **NTT and Safe calls in the queue are decoded:**
  - NTT `setThreshold`, `setTransceiver` (a new transceiver's network is unknown, so it is red BR-7), `removeTransceiver`, and the four-argument NTT `setPeer` (BR-1 / BR-2 / BR-6 / BR-7, as for executed events);
  - transceiver `setWormholePeer` / `setAxelarChainId` (BR-6; a current peer that was not read is red);
  - the NTT one-argument `upgrade(address)`;
  - the Safe ≤ 1.1.1 `changeMasterCopy` (AD-6 singleton).

  A transceiver of a subject NTT manager is in scope.
- **NTT effective count.** BR-1 on an NTT transceiver removal or threshold change compares the effective verifier count, not only the raw threshold.
- **CCIP:**
  - A chain removed and re-added with its rate limiter off is CC-2 (history; and the queue, through `ccipLastLimiterOn`).
  - CC-3 ranks the rebalancer with `isEoaControlled`.
  - A remote pool is compared with the pools the chain had LAST, so a roll-back to an older pool is a re-point. In history this is `lastServed`; in the queue it is `ccipRemotePoolsReplay` / `ccipLastRemotePools`.
- **Safe modules.** A Safe whose `getModulesPaginated` read failed has `modulesUnread`, not `modules: []`. It ranks as a plain contract, is a read gap, and is not diffed between runs.
- **Grant reasons.** A red grant that an established bot pattern would not clear leads with its anomaly and carries the ANOMALY tag. It no longer says "no established pattern yet". This changes the reason line on 41 rows: weETH 28, rsETH 7, PT-srUSDe 5, wstETH 1.

**On-chain.**
- **Role holders are re-judged at head** (`rejudgeRoleHoldersAtHead`).
  - A red AD-4 grant ends ("NO LONGER IN EFFECT at head") when two things hold. The grantee, classified at head, ranks strictly stronger than when it was granted. And it would not make the grant red against the holders it was ranked against.
  - A calm grant to a privileged role whose holder is EOA-controlled at head, and weaker than when granted, gets a red AD-4 row (bracketed, in effect).
  - A controller that was not read changes nothing.
- **What the collector now classifies.**
  - At head: every current holder of a privileged role that had code when granted.
  - At each grant block: the holders that grant is ranked against. Before, the replay fell back to a holder's head classification, or noted "could not be classified: not ranked against".

**UI.** With the head-state file missing, the headline still names "N red in effect" and "N red queued", and its tone is red (`headlineTone`). Before, it dropped both and read amber.

**Re-run (wstETH at block 26,145,187; the seven others at 26,145,153).**
- **wstETH:** 19 red (unchanged); red in effect 11 → 9. The MCMS `0xd975…cf7e` was EOA-owned when it was granted PROPOSER / CANCELLER at 22,234,034. Its owner has been the RBACTimelock `0x4483…9449` since 22,290,213. Both rows are no longer in effect.
- **WBTC:** red in effect 4 → 2 (the same MCMS rows).
- **rsETH:** red in effect 6 → 4. Two grantees are now stronger:
  - role `0x9c20…` to Safe `0x4e24…8c62`: 1-of-6 when granted, 2-of-6 since 24,306,194;
  - MANAGER to Safe `0xcbcd…29a1`: 1-of-2 when granted, 3-of-6 at head.
- **weETH:** red 59 → 62; red in effect unchanged at 11.
  - +4: grants of two unrecognised roles to 8 h timelocks (22,084,653–22,089,298). They are ranked against holders now classified at the grant block, and are weaker. None is in effect.
  - −1: the oracle committee rows 3 → 5 / 5 → 3 (25,626,145 / 25,633,016) fell between two param-grid points this run (KG-3).
- **USDe, sUSDe, cbBTC, PT-srUSDe:** counts unchanged.
- **All subjects:** no read gaps. The wstETH NTT sweep found one live peer (BNB Chain), as before.
- **Kelp backtest:** unchanged (its test passes on the same expected file).

## Owner rulings 2026-10-08 (#12–#14) and KG-2

Every change has tests in `tests/unit/oracleRegistryConfigRulings1214.test.ts`. 29 of the 30 failed on the code before the change. The one control passed before as well: Safe 6/11 → a 7-day timelock proposed by the same Safe was an upgrade then too. Tests whose fixtures encoded the superseded rules were updated:
- a timelock fixture now names its proposer (a governance Safe 7-of-12 by default);
- the Round 2 sort test now expects an unread value first.

**#12: a timelock ranks as its WEAKEST PROPOSER (`rules.ts`, `rankParts`).**
- **The rank tuple.** A rank is `[base (3 wide), delay credit, deferral tail]`, compared left to right.
  - *base:* the class of the weakest key holder. 6 = immutable; 5 = token-holder vote (Aragon Voting); 4 = multisig `[4, threshold, −signers]`; 2 = contract; 1 = EOA.
  - *delay credit:* the sum of the credits of the timelock stages in front of that holder. A stage's credit is 0 below 24 h and the delay itself at or above it. Every non-timelock has credit 0.
  - *tail:* one −1 per deferral hop.

  The base is compared first, so a delay never rescues a weak proposer.
- **Who counts as a proposer (the collector reads them at every classified block, `timelockSchedulers` / `classifyDgTimelock` in `admin.mjs`):**
  - OZ TimelockController / RBACTimelock: PROPOSER_ROLE holders plus the holders of `getRoleAdmin(PROPOSER_ROLE)` and its own admin, up to three levels. When `getRoleAdmin` cannot be read: TIMELOCK_ADMIN / DEFAULT_ADMIN / ADMIN. The timelock itself is not a proposer.
    - Candidates come from three sources: the timelock's own `RoleGranted` logs since deployment, the collector's admin scan, and AccessControlEnumerable. `hasRole` at the block decides; a failed read keeps the candidate.
    - No PROPOSER candidate at all (e.g. a false-empty log read) = unread.
  - DSPause: its owner and its authority.
  - Dual Governance timelock: its declared proposers (`getProposers()` on the governance contract). Its own stage is the after-submit delay; the proposers' vote is their own credit (Aragon Voting 5 d + after-submit 3 d = 8 d, as before).
- **Fail closed.** An unread proposer set ranks as a plain contract and is a read gap ("timelock …: proposers not read"). So does an empty one. An unrestricted bypass caps a timelock at a plain contract with no credit.
- **Where the rank applies:** wherever it was used before.
  - AD-3: the previous holder is compared with the new one.
  - AD-4: the grantee is compared with the current holders, and holders are re-judged at head.
  - CC-3 and MR-2.
  - The head-state breach check (`isEoaControlled`): a power held by a timelock that an EOA can propose into is AD-3 at head.
- **Required cases (tested):**
  - Safe 6/11 → 60 s timelock proposed by the same Safe = NEUTRAL;
  - → 60 s timelock proposed by an EOA = RED;
  - → 7-day timelock proposed by the same Safe = UPGRADE;
  - → 10-day timelock proposed by an EOA = RED;
  - a PROPOSER grant to an EOA on an existing timelock = RED (AD-4 on the grant; the timelock's rank drops to EOA, AD-3).
- **Interpretations for owner review:**
  - An Aragon Voting is ranked as the token-holder vote itself (base 5, credit = vote time). Its "proposer" (any LDO holder through the TokenManager) decides nothing. Review round 9 (R-1): a Voting whose vote time is 0 or was not read ranks as a plain contract and, at head, is a read gap; the base-5 rank for a read vote time is open owner call UQ-17.
  - Credits in series add up.
  - A 0-delay timelock now ranks as its proposer. Before, it ranked as a plain contract; ruling #12 makes 0 s and 60 s equal.
  - The controller cache moved to `controllers-at-v3.json` (review round 9: `controllers-at-v4.json`).
  - Review round 9 (R-2): a proposer that can change the delay without waiting for it gets no credit from that timelock. A Chainlink RBACTimelock gates `updateDelay` with ADMIN_ROLE; the collector marks every admin-role holder whose `updateDelay(0)` eth_call succeeds (another failure: fail closed) as a `delaySetter`. OZ TimelockController's `updateDelay` is self-only, so its admins keep the credit.
  - Review round 10 (R-6): an owner past that hop limit is recorded (`ownerNotFollowed`), and the contract ranks as a plain contract AND a read gap (it ranked as a plain contract silently).
- Review round 9 (CB-3): a contract's owner is followed for 2 hops counted from the last proposer / executor hop (it was 2 from the top of the tree, so a proposer under "ProxyAdmin owned by a timelock" never had its owner read). An ownership cycle is not followed: an MCMS owned by the RBACTimelock it proposes into ranks as a plain contract, with the timelock's credit counted once.
  - Proposer classifications are not memoized. The first re-run deadlocked: an MCMS proposer owned by its own RBACTimelock awaited its own pending promise, and node exited 13 with an unsettled top-level await. Recursion is now bounded by `seen` and a depth cap of 4 (deeper = unread). A nested timelock is described without its own proposer note, so the MCMS → RBACTimelock cycle prints once.

**#13: oracle committee members (closes KG-1).** The committee events are scanned and replayed: HashConsensus `MemberAdded` / `MemberRemoved`, EtherFiOracle `CommitteeMemberAdded` / `Removed` / `Updated`, and Aragon Voting `ExecuteVote`.
- **One row per (committee, transaction):** key `oracle/committee/<contract>`. `before` holds the members removed and `after` the members added, so a same-size swap shows.
- **Judged by the path:**
  - neutral when the committee's declared delayed governance path MADE the change. As first built, any `CallExecuted` / `ProposalExecuted` / `ExecuteVote` from the path in the same transaction counted; review round 9 (CB-2) checks each call (`committeePathVia`): the transaction was sent to a declared path contract whose execution event follows the member events, or each member event is followed by a path `CallExecuted` that targets the committee and names the member in its calldata;
  - red AD-5 outside it, or with no declared path;
  - initialization in the deploy block.
- **The declared path (`engine.ts`, `committeePaths`):** every delayed controller in the head trees of the holders of a declared power over the committee (ownedBy, an Agent's executors, a timelock's proposers). With no such power, the subject's declared timelocks. This is the head path, so a historical change is judged against today's path plus everything on it (e.g. the Aragon Voting, which is Dual Governance's proposer).
- **STILL IN EFFECT:** a red change stays in effect while a member it added is still in, or a member it removed is still out.
- The count parameters stay as they were (KG-3, UQ-2).

**#14: an unread value at risk sorts FIRST.** `compareValueAtRisk` puts a floor breach whose value was not read ahead of every priced one. `valueAtRiskLabel` says "value unread (why)". A partial read (one side unread) first sorted by the side that was read, labelled "lower bound"; review round 9 (R-3) sorts it with the unread ones (after the fully unread, by the side that was read) and labels it "value unread (…) · at least $X", because the value is the larger side (ruling #9) and with a side missing it is not known. The Kelp framing adds one sentence: on a card, the 817 unpriced breaches would be listed ahead of Kelp.

**KG-2: the banner counts routes.** `breachBannerTitle`: "1 FLOOR BREACH (2 sides) IN FORCE NOW", the same unit as the headline.

**Re-run (all 8 subjects at block 26,151,037; the raw and scan caches were rebuilt from scratch, then deleted).** Before = the round-8 data at 26,145,153 (wstETH 26,145,187). Format: red / red in effect / amber pending / floor breaches / state breaches.

| Subject | Before | After | Why |
| --- | --- | --- | --- |
| rsETH | 85 / 4 / 0 / 0 / 0 | 85 / 4 / 0 / 0 / 0 | Ruling #12 changed one verdict. At 19,812,242 the owner of `0xb61e…dc78` moved from a Safe 3-of-5 to the 3-minute timelock `0x49bd…35b1`, proposed by a Safe 3-of-5. It was an upgrade; it is now neutral (no credit below 24 h). One proposed Safe transaction executed on chain (+1 historical). |
| weETH | 62 / 11 / 9 / 0 / 0 | 63 / 11 / 9 / 0 / 0 | +9 committee rows (#13). +1 red: the first EtherFiOracle member add at 18,537,396 was made directly, not through a timelock (AD-5). It is not in effect: that member was removed through the timelock at 20,584,737. The other 8 went through the declared timelocks and are neutral. −1: the quorum 2 → 3 row at 25,626,145 disappeared. **Corrected in review round 9:** that was not grid drift (KG-3) but CB-1 — this run read all 8 subjects together, the weETH and wstETH param keys collided, and weETH showed wstETH's quorum 5 / 9 members (on chain 3 / 3). Fixed and re-collected; see "Review fixes, round 9". |
| USDe | 56 / 4 / 6 / 0 / 1 | 56 / 4 / 2 / 0 / 1 | Amber −4: the Ethena timelock ops scheduled at 26,133,937 and 26,139,184 executed at 26,146,886 / 26,146,894 (+2 historical). The AD-2 head breach now names the timelock's proposer (Safe 5-of-10). |
| sUSDe | 37 / 5 / 5 / 0 / 1 | 37 / 5 / 2 / 0 / 1 | Amber −3: the same executed ops. +2 new FULL_RESTRICTED_STAKER grants (restrictions, neutral). |
| WBTC | 15 / 2 / 25 / 0 / 1 | unchanged | The RBACTimelock `0x4483…9449` is still capped at a plain contract by its bypass. The AD-2 breach now names its weakest proposer. |
| cbBTC, PT-srUSDe | unchanged | unchanged | — |
| wstETH | 19 / 9 / 0 / 0 / 1 | 19 / 9 / 0 / 0 / 1 | +7 committee rows, all neutral: 4 through an Aragon vote, 3 through Dual Governance (the 2026 swap included). The Linea bridge timelock (0 s) now ranks as its weakest proposer, Safe 3-of-5 `0xb8f5…0051`. **Corrected in review round 9:** that Safe has a module (`0x784c…5436`, a 90-day cooldown), so it, and the timelock, still rank as a plain contract `[2]`; the "proposed by Safe 3-of-5" description does not show the module (UQ-22). No breach either way. |

- **No read gaps.** Every timelock at head has a read proposer set:
  - rsETH `0x49bd`: Safe 6-of-11;
  - weETH `0x9f26` / `0xcd42`: Safe 6-of-10 / 4-of-7;
  - Ethena `0xe8dc`: Safe 5-of-10;
  - PT-srUSDe `0x68d8` / `0xb2a3`: Safe 3-of-5 / 3-of-4;
  - Dual Governance: the Aragon Voting.
- **No new head breach.** No timelock that holds a power has an EOA proposer at head. At some past blocks, the WBTC RBACTimelock and the PT-srUSDe timelock `0x68d8` had an EOA proposer. No row flipped red or calm because of it (every row was compared before and after); the RBACTimelock is capped at a plain contract by its bypass anyway.
- Remote reads: 121 ok, 24 unread. Round 8 had 122 / 23: one more public RPC failure.
- **Kelp backtest:** passes, all 5 criteria. Red count unchanged at 55 (227 changes), because the fixture is LayerZero-only: no controller, no committee. The framing gained the ruling-#14 sentence.


## Review fixes, round 9 (2026-10-08)

Two refuters (an on-chain lens and a rules lens) reviewed the ruling #12–#14 work and confirmed six bugs. Each one could make a dangerous change read calm, hide a red, or misstate chain data, so all six were fixed. Tests: `tests/unit/oracleRegistryConfigReview9.test.ts` (15 tests; 11 fail with the fixes reverted, the other four are the CB-1 helper test and three controls). The fixture-level detail and the open owner calls they raised (UQ-17 to UQ-24) are in [CONFIG-CARDS-KNOWN-GAPS.md](CONFIG-CARDS-KNOWN-GAPS.md).

- **CB-1, param keys collided across subjects (data).** The collector read every subject's mint / redeem getters in one pass keyed by `key` alone. weETH and wstETH both declare `oracleQuorum` / `oracleMembers`, so the all-8 run above gave weETH wstETH's 5 / 9 (on chain 3 / 3) and dropped weETH's quorum 2 → 3 row. Keys are now read as `<subject>::<key>` (`params.mjs`, `scopedParamSpecs` / `paramsForSubject`).
- **CB-2, the committee path was checked per transaction.** Now per call (`adminReplay.ts`, `committeePathVia`): the transaction was sent to a declared path contract whose execution event follows the member events, or each member event is followed by a path `CallExecuted` that targets the committee and names the member in its calldata. The collector reads each committee transaction's recipient (`txTo`) and keeps the calldata of `CallExecuted` calls to a committee. Checked on chain before the change: the 7 wstETH transactions are sent to `0xce04` (Dual Governance) or `0x2e59` (the Voting), each with its execution event last; the 8 ether.fi transactions go through a Safe, with a `CallExecuted` to `0x57aa` right after each member event.
- **CB-3, a proposer contract's owner was never read under a ProxyAdmin → timelock chain.** Owner hops are counted from the last proposer / executor hop (`MAX_OWNER_HOPS = 2`), and an ownership cycle is not followed, so the MCMS under the RBACTimelock counts the delay credit once. Cache: `controllers-at-v4.json` (v3 entries with no timelock, Agent or cycle carry over).
- **R-1, an Aragon Voting with a 0 s or unread vote time outranked every Safe.** It ranks as a plain contract again, says so, and is a read gap at head.
- **R-2, an RBACTimelock ADMIN_ROLE holder got the delay credit.** It can call `updateDelay(0)` at once. The collector marks admin-role holders whose `updateDelay(0)` eth_call succeeds as `delaySetters` (any non-revert failure counts as yes); they get no credit from that timelock. Probed at head: no timelock in the 8 subjects has one.
- **R-3, a partly read value at risk sorted by its read side.** It now sorts with the unread breaches (after the fully unread, by the read side) and reads "value unread (…) · at least $X (…)".

**Re-run (weETH, WBTC, wstETH at block 26,151,320; the other five subjects are unchanged by these fixes and stay at 26,151,037).** The scan caches were deleted afterwards.

| Subject | Before (26,151,037) | After | Why |
| --- | --- | --- | --- |
| weETH | 63 / 11 / 9 / 0 / 0 | 63 / 11 / 9 / 0 / 0 | CB-1: the quorum 2 → 3 row at 25,626,145 is back (tx `0xc0d1ec56…`, an upgrade; 473 historical rows, was 472). Head state: quorum 3 and 3 active members, as on chain (was 5 / 9). The 9 committee rows are unchanged: 8 neutral under the per-call check, the 2023 direct add red and not in effect. |
| WBTC | 15 / 2 / 25 / 0 / 1 | unchanged | CB-3: the RBACTimelock description no longer repeats itself through the MCMS it owns ("[proposed by contract 0xe532…012f (the weakest of 3)]"). No verdict changed; the AD-2 head breach stands. |
| wstETH | 19 / 9 / 0 / 0 / 1 | unchanged | The same CB-3 description change on the CCIP rows. The 7 committee rows are unchanged and neutral. |

No verdict and no "still in effect" flag changed in any row of the three subjects; no read gap appeared. Kelp backtest: re-run offline, all 5 criteria pass, the output is byte-identical (227 changes, 55 red).

## Round 10 (2026-10-08/09): the token-vote ruling (UQ-17) and the fail-open items UQ-18 to UQ-24

All eight items are closed; the per-item detail is in [CONFIG-CARDS-KNOWN-GAPS.md](CONFIG-CARDS-KNOWN-GAPS.md) ("Closed 2026-10-08 (round 10)"). Tests: `tests/unit/oracleRegistryConfigUq17.test.ts` (36). Uncommitted at the time of writing.

**Token vote (UQ-17).** `rules.ts` `tokenVoteDecision` decides k from the vote's holder data (the voting token's supply, the app's `minAcceptQuorumPct` / `supportRequiredPct`, and the largest holders, each classified at the block); `tokenVoteParts` turns it into a rank. A holder whose control leads back to the same vote (`selfRef`: the Lido Agent) is left out — it votes only after a vote passed. The collector rebuilds the holder set at every block it classifies a vote at, in one streaming pass over the token's Transfer logs (`scripts/oracle-registry/config/lib/holders.mjs`): every empty chunk cross-checked on a second endpoint, every snapshot verified against `totalSupply()` and the ten largest `balanceOf()` at the block, top-50 cached. LDO: 734 chunks, about 4 minutes, 118 blocks.

**Measured, and against the owner's expectation.** Under the ruling as written ("pass a vote ALONE": its yes votes meet both thresholds with nobody else voting), ONE LDO holder passes a Lido vote alone at 116 of the 118 measured blocks: `0xf977…acec` (an EOA, a Binance hot wallet) holds 6.078 % at 26,152,213, above the 5 % quorum; `0x820f…0a18` held 7 % in 2023–24. So the Lido vote ranks as an EOA and every Lido power reads EOA-controlled. The required test "Lido's LDO vote ranks as broadly held" holds only if "alone" means "against every other holder voting no": then k = 16 at head. Open owner call UQ-25; the code ships the literal (fail-closed) reading.

**Re-collection.** wstETH was re-collected (head 26,152,213). The six other subjects with timelocks (rsETH, weETH, USDe, sUSDe, WBTC, PT-srUSDe) were NOT: free disk fell to 32 MB during their run (another job on the machine), so the run was stopped per the disk rule. Their cards still show the round-9 output; cbBTC (EOA holders only) is unaffected by these rules.

| Subject | Before (red / in effect / amber / breaches) | After | Why |
| --- | --- | --- | --- |
| wstETH | 19 / 9 / 0 / 1 | 51 / 33 / 0 / 42 | UQ-17: the Lido vote ranks as an EOA (one holder passes alone), so 31 grants, owner / proxy-admin moves and DG settings whose holder runs through the vote turn red (23 still in effect) and every Lido power has an AD-3 head breach (40). UQ-22: the Linea proposer Safe `0xb8f5…0051` is declared — its module enable at 22,996,844 is a red AD-6 row in effect (+1 red, +3 historical rows), and the Linea upgrade power carries AD-6 at head (+1). The 7 committee rows stay neutral (UQ-19 passes). No read gaps. |
| the other six | round-9 counts | not re-collected | see above |

Kelp backtest: re-run offline, all 5 criteria pass, output byte-identical (227 changes, 55 red).

## Review fixes, round 10 (2026-10-09)

Two refuters (an on-chain lens and a rules lens) reviewed the round-10 work and confirmed eight distinct bugs (two found by both). Each one could make a dangerous change read calm, hide a red, or misstate chain data, so all eight were fixed. Tests: `tests/unit/oracleRegistryConfigReview10.test.ts` (27 tests; 22 fail on the code before the fixes, 5 are controls). Per-item detail, and the unsure items they raised (UQ-26 to UQ-29, and two additions to UQ-25), are in [CONFIG-CARDS-KNOWN-GAPS.md](CONFIG-CARDS-KNOWN-GAPS.md) ("Fixed in review round 10"). Uncommitted at the time of writing.

- **Token votes (RV10-1, RV10-2).** The vote ranks as the WEAKEST set of k holders that passes it alone, where k is the smallest such set: every holder in some passing set of k counts (the top k, and each later holder that passes together with the k − 1 largest others). For k = 1 a key that passes alone is the floor. The decision is settled only when a later holder was examined and is in no such set (or the list is complete); unsettled = a read gap. A holder whose classification failed is a read gap (it ranked as a plain contract with the vote-time credit on top). Address(0) and the precompile range cannot vote. The collector examines holders until the decision is settled, and reads a cached vote again when it is not (`tokenVoteNeedsHolders`).
- **A failed read never ends a red (RV10-3, RV10-4, RV10-8).** A move to a holder whose rank rests on a read gap is never an upgrade: neutral, noted, tagged `read_gap` (chip READ GAP), and an open red on the key is carried forward like a rotation. In the head re-judge, a comparison holder not read (or resting on a read gap) keeps the red. A past-block classification that failed is recorded (`classifyFailed`) and looks up as null, never as the head classification.
- **Collector reads (RV10-5, RV10-6, RV10-7).** Each half of an adaptive getLogs split is cross-checked on its own. An owner past the hop limit is a read gap. Before Multicall3 (block 14,353,601) the views are read one eth_call each (a Safe there was a plain contract); classification cache `controllers-at-v5.json`.

**Data: not re-collected.** The wstETH re-run was stopped by the disk watchdog (free disk fell to 32 MB, most likely a new macOS swap file), so the stored cards still show the pre-fix verdicts where these fixes change them: one wstETH row (the 22,225,938 owner move onto a timelock with unread bypassers still reads UPGRADE), and possibly the six "NO LONGER IN EFFECT" grants on wstETH, WBTC and rsETH. Register entry KG-4. Kelp backtest: re-run offline, all 5 criteria pass, output byte-identical (227 changes, 55 red).

## Round 11 (2026-10-09): a token vote against the trailing year's opposition (UQ-25), and the re-collection (KG-4)

**Owner ruling 2026-10-09 (UQ-25, refines UQ-17).** "Can pass a vote alone" is judged against the AVERAGE OPPOSITION of the trailing year: not "nobody else votes" (the round-10 literal reading, which assumed no opposition) and not "everyone else votes no" (which assumed the most). For each token vote, at its classification block, D is the mean nay stake of every vote STARTED in the 365 days before the block (a vote with no nays counts as 0). A holder set S passes alone iff `stake(S) × 1e18 / supply > minAcceptQuorumPct` and `stake(S) × 1e18 / (stake(S) + D) > supportRequiredPct` (strict, as Aragon `_isValuePct`; the ruling's "≥" differs only at exact equality, which does occur in the LDO data — open owner call UQ-31). The rank shape is unchanged: the weakest passing set of k holders — k = 1 ranks as that holder, k ≤ 10 as a k-of-k multisig, more as broadly held. The Lido Agent stays excluded (a back-reference: it votes only after a vote passed). No vote in the window: D = 0, fail closed, and the card says so. Vote history not read: a read gap (plain contract, no delay credit). The rank note shows k, D (as a share of supply), the window end and the vote count.

**Where.** `rules.ts` `tokenVoteDecision` (D in the support test; `history` marks an unread history), `voteDefenseNote`, `tokenVoteNote`, `nodeReadGaps`; `types.ts` `VoteDefense`, `voting.defense` / `voting.defenseUnread`; collector `admin.mjs` `voteDefense` (votesLength, then getVote newest first in Multicall3 batches of 25, one eth_call each before Multicall3) and `enrichTokenVotes` (`defenseFor`, read before the holders; an unread history classifies no holder and fetches no snapshot; a cached vote without `defense` is read again, reusing the holders it had classified); `collect-config.mjs` caches D per (vote app, block) in `.cache/vote-defense-v1.json`. Tests: `tests/unit/oracleRegistryConfigUq25.test.ts` (16; 14 fail on the code before the change, 2 controls). Detail: [CONFIG-CARDS-KNOWN-GAPS.md](CONFIG-CARDS-KNOWN-GAPS.md) ("Closed 2026-10-09 (round 11)").

**Measured: Lido.** At 26,152,213: 13 votes in the window (ids 193–205), D = 279,135.7 LDO (0.0279 % of supply, shown truncated on the card as 0.027 %; the nays sit almost all in votes 193 and 200). `0xf977…acec` (an EOA, 6.078 %) passes alone with 99.5 % support against D, so k = 1 and the vote still ranks as an EOA. Over all 118 cached LDO blocks (2020-12 → 2026-10), D peaks at 0.069 % of supply (2021) and changes k at NONE of them (k = 1 at 116, k = 2 at the two 2020–21 blocks, with D or without). The first block, 11,473,299 (2020-12-17), has no vote in its window: D = 0, and its note says so. UQ-25 therefore changes no Lido verdict; only the rank notes change (they now show D, the window, the vote count and k).

**Re-collection (KG-4): not done.** The run was set up one subject per process (`--only=<key>`, `node --max-old-space-size=1536`), in this order: wstETH, weETH, WBTC, rsETH, USDe, sUSDe, PT-srUSDe, cbBTC. Before each subject it checked that free disk was at least 400 MB, waiting up to 10 minutes. Free disk never reached 400 MB (334–374 MB, one dip to 179 MB; swap about 2.6 GB and not shrinking), so the run stopped before wstETH. Every stored card is unchanged (counts as in the round-10 table). From the 118-block analysis above, UQ-25 by itself would change no count on re-collection; the pending changes are those listed in KG-4.

Kelp backtest: re-run offline, all 5 criteria pass, output byte-identical (227 changes, 55 red).

### Review round 11 (2026-10-09): what the two refuters found in the UQ-25 work

Two refuters (on-chain and rules) recomputed Lido's D, vote count and k from raw `getVote` / `CastVote` reads and matched the builder to the wei. They found two confirmed bugs; both are fixed. Tests: `tests/unit/oracleRegistryConfigReview11.test.ts` (22; 12 fail on the code and data before the fixes, 10 controls).

- **The card never renders a read gap it does not count (RV11-1).** Holder labels are rendered from the STORED controller trees with the CURRENT rules (`view.ts` `holderView` → `describeController`). The stored wstETH trees were collected before UQ-25, so all 98 Lido vote nodes rendered "trailing-year vote history UNREAD … ranked as a plain contract" while the same card listed no read gap and its stored text said k = 1. Two fixes:
  - **Data:** the 98 head vote nodes in `state/wsteth.json` were given the D the collector had already read at that head block (`.cache/vote-defense-v1.json`, key `<vote app>@26152213`) — offline, no chain read, nothing else in the file changed. They now render k = 1 with the D note, consistent with the stored verdicts (42 AD-3 head breaches, 51 red, no read gap).
  - **Code (fail closed for any stale card):** `view.ts` `readGapsOf` adds to the stored read gaps every line the current rules find in the stored head trees (`rules.ts` `treeReadGaps`: a Safe's modules, a timelock's proposers, a vote's time, and `nodeReadGaps`, with the engine's exact lines). The card's `readGaps` and `counts.readGaps` (and the tab summary) use it. On a card the engine just built it adds nothing (tested). On the committed data it adds one line: WBTC's CCIP timelock `0x4483…9449` (`bypasserExecuteBatch` bypassers not classified — round-9 output predating UQ-24, KG-4), which the label already showed.
- **An implausible D is a read gap (RV11-2).** Nothing checked D: a misread D larger than the whole supply (a yea / nay or unit mix-up) made a 60 % EOA whale read as broadly held `[5]`. `rules.ts` `defenseMean` now requires a whole record (integers; D = floor(sum / count); no vote = no nays) and D ≤ supply; otherwise the history is unread (a read gap, plain contract, no credit). The collector (`admin.mjs` `readVotes`) refuses a vote whose yea + nay exceed its own voting power (`getVote` word 8), so its history is recorded as unread.
- **Cosmetic (RV11-3).** A classification without a recorded history said "trailing-year vote history" twice; it now says "trailing-year vote history UNREAD (not recorded with this classification)".

Registered, not fixed (owner calls): a failed D read at head drops that power's head breaches while its reds stay in effect (UQ-30); the strict threshold versus the ruling's "≥" (UQ-31, equality occurs at two 2020–21 LDO blocks, no rank change). Delegation (UQ-27) was raised again; it stays open. Kelp backtest: re-run offline, all 5 criteria pass (227 changes, 55 red), backtest files unchanged.
