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

**Admin.** Controller rank, strongest first: immutable > timelock (by delay) > Safe or multisig (by threshold, then signer count) > contract > EOA = 7702 EOA.
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
- **AD-5:** an `Upgraded` or `AdminChanged` event has no `CallExecuted` from the subject's timelock in the same tx.
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

Deferred: sUSDe (nearly free to add), wstETH and sUSDS.

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

**SEVERITY RANK (owner rulings #5 and round 2 #9, built).** Floor breaches are ranked by the value at risk behind the route: the larger of the Ethereum adapter's locked balance and the remote chain's bridged supply, priced in USD with the registry consensus (times an on-chain rate when the token is not a catalog asset: rsETH = ETH consensus × `LRTOracle.rsETHPrice()`). The card shows it on every floor-breach row and in the red banner, and sorts by it, worst first (`lib/oracleRegistry/config/value.ts`). At block 24,908,284 the exploited route carried **$295M**: 116,723.5 rsETH locked in the adapter × $2,527 (ETH consensus $2,362.90 at that block, from an archive snapshot of the registry, `backtest/registry-at-eval.json`); the Unichain peer's supply was 49.3 rsETH. Across the 825 floor-breaching OApps, Kelp ranks **#1 of the 8 that the registry can price**; 817 could not be priced (a token the registry does not price — the registry covers ten assets — or a native OFT with nothing locked on Ethereum), and remote supplies are not read for the base rate. So the rank puts Kelp first where it can be computed, but it is computed for 1% of the apps: the registry's asset coverage, not the rule, is the limit. `kelp-rseth.expected.json` carries this framing as computed text (`framing`).

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
- In the controller rank, a timelock with no delay or with an unrestricted bypass counts as a plain contract. A contract that defers to an owner ranks strictly below that owner.
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
- AD-4 uses `isEoaControlled`: a privileged role granted to a contract an EOA controls (WBTC's CCIP RBACTimelock PROPOSER / CANCELLER to an EOA-owned MCMS) is red even with no classified current holder; unclassified holders are noted, not silently dropped.

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

