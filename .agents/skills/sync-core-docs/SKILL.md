---
name: sync-core-docs
description: >
  Update membrane-app documentation, types, and service files after membrane-core contract changes.
  Use this skill whenever the user mentions syncing docs after contract changes, updating frontend
  types to match new contract messages, propagating membrane-core changes to membrane-app,
  refreshing cross-organ flow docs, or says things like "core changed", "contracts updated",
  "sync the frontend", "update app docs", or "what changed in core". Also trigger when the user
  references a specific membrane-core contract change and wants the app side updated.
---

# Sync Core Docs

Update membrane-app documentation, TypeScript types, service files, and Ditto page contracts
after changes land in the membrane-core repository.

## Why this skill exists

membrane-app and membrane-core are separate repos with no direct imports between them.
Contract message types are **manually mirrored** in TypeScript (in `types/`, `services/`,
and `contracts/generated/`). Documentation about protocol mechanics lives in both repos
in different forms. When membrane-core contracts change — new messages, renamed fields,
updated flows — the app side drifts out of sync silently. This skill bridges that gap.

## When to use

- After a PR merges in membrane-core that changes contract messages, state, or flows
- When the user says "core changed" or "contracts updated" and wants the app updated
- When cross-organ flow documentation in membrane-core diverges from app-side docs
- When new contract messages need corresponding TypeScript types or service functions
- When Ditto page contracts reference stale facts or thresholds

## Step-by-step process

### 1. Detect what changed in membrane-core

Start by understanding what actually changed. Run a diff in the membrane-core repo:

```bash
# If the user specifies a commit range or PR:
cd /Users/EBmic/membrane-core && git diff <base>...<head> --stat

# If no range given, compare against the last known sync point:
cd /Users/EBmic/membrane-core && git log --oneline -20
```

Focus on changes in these locations (ordered by impact):

| membrane-core path | What it affects in membrane-app |
|---|---|
| `packages/membrane/src/*.rs` | Message types → `types/`, `services/`, `contracts/generated/` |
| `contracts/*/src/contract.rs` | Execute/Query handlers → `services/*.ts` |
| `contracts/*/src/state.rs` | State shape → query response types |
| `docs/cross-organ/` | Flow documentation → `docs/`, Ditto contracts |
| `docs/organs/` | Organ docs → `docs.md`, `membrane_about.md` |
| `packages/membrane/src/types.rs` | Shared types (Asset, Basket, etc.) → `types/`, `contracts/generated/` |

Read the reference file at `references/contract-app-mapping.md` for the full mapping
between membrane-core contracts and membrane-app files.

### 2. Categorize changes by type

Sort every change into one of these buckets:

**A. Message schema changes** (ExecuteMsg / QueryMsg variants added, removed, or renamed)
- These require TypeScript type updates in `contracts/generated/` or `types/`
- May require new service functions in `services/*.ts`
- May require React Query hook updates

**B. State/response changes** (new state keys, changed query responses)
- These require TypeScript type updates for response types
- May require service function return type updates

**C. Flow/logic changes** (new SubMsg chains, changed reply IDs, updated formulas)
- These require documentation updates in `docs/`
- May require Ditto page contract fact/message updates
- May require service function logic changes

**D. Parameter changes** (new config fields, changed defaults, renamed parameters)
- These require documentation updates
- May require UI component updates if parameters are displayed

**E. New contracts** (entirely new contract added)
- Requires new TypeScript type file, new service file, potentially new page

### 3. Apply updates to membrane-app

For each bucket, follow the appropriate update pattern:

#### For message schema changes (Bucket A)

1. Read the changed `.rs` file in `packages/membrane/src/`
2. Find the corresponding TypeScript types:
   - Check `contracts/generated/<contract>/` for codegen'd types
   - Check `types/*.ts` for manually mirrored types
   - Check `services/*.ts` for inline type definitions
3. Update the TypeScript to match the new Rust definitions
4. If a new ExecuteMsg variant was added, check if the service layer needs a new function

**Type mapping reference:**

| Rust | TypeScript |
|------|-----------|
| `Uint128` | `string` (stringified big number) |
| `Decimal` | `string` |
| `Addr` | `string` |
| `Option<T>` | `T \| undefined` or `T?` |
| `Vec<T>` | `T[]` |
| `String` | `string` |
| `u64` / `u128` | `number` or `string` (depending on size) |
| `bool` | `boolean` |
| `Coin` | `{ denom: string; amount: string }` |

**Naming convention:** Rust `snake_case` variants become TypeScript `snake_case` in message
objects (CosmWasm JSON serialization preserves snake_case).

#### For state/response changes (Bucket B)

1. Read the contract's `state.rs` and `query.rs`
2. Find the corresponding response types in `contracts/generated/<contract>/*.types.ts`
3. Update response interfaces to match

#### For flow/logic changes (Bucket C)

1. Read the relevant `docs/cross-organ/*.md` file in membrane-core
2. Find the corresponding documentation in membrane-app:
   - `docs.md` — protocol overview
   - `membrane_about.md` — vision and philosophy
   - `docs/*.md` — specific feature docs
3. Update the app-side docs to reflect the new flow
4. Check Ditto page contracts (`contracts/*.Contract.ts`) for stale facts or thresholds

#### For parameter changes (Bucket D)

1. Search membrane-app for references to the old parameter name
2. Update any hardcoded defaults, display labels, or tooltip text
3. Update documentation that references the parameter

#### For new contracts (Bucket E)

1. Create TypeScript types in `types/<contractName>.ts`
2. Create a service file in `services/<contractName>.ts`
3. Add the contract address to `config/contracts.json`
4. If it needs a page, scaffold one in `pages/[chain]/`

### 4. Update cross-cutting documentation

After applying specific changes, update these cross-cutting docs:

- **`docs.md`** — If any user-facing mechanics changed (minting, liquidation, staking, etc.)
- **`membrane_about.md`** — If protocol philosophy or high-level design changed
- **Ditto page contracts** — If facts, thresholds, or shortcuts reference changed values:
  - `contracts/discoContract.ts` (LTV Disco)
  - `contracts/transmuterContract.ts` (Transmuter)
  - `contracts/portfolioContract.ts` (Portfolio)

### 5. Verify consistency

After all updates, run a quick consistency check:

```bash
# Search for any remaining references to old names/values
cd /Users/EBmic/membrane-app && grep -r "<old_term>" --include="*.ts" --include="*.tsx" --include="*.md"
```

Summarize what was updated in a clear list for the user.

## Important notes

- **Never guess at contract changes.** Always read the actual diff or current contract code.
- **Preserve existing patterns.** membrane-app has specific coding standards (see AGENTS.md).
  Follow the existing import style, type naming, and service patterns.
- **Don't regenerate codegen'd types by hand** if the codegen pipeline (`scripts/codegen.js`)
  can do it. But note that codegen requires JSON schemas in `contracts/schema/` to be updated
  first — if those schemas haven't been regenerated from membrane-core, manual type updates
  are appropriate.
- **Comments matter.** Files like `services/q-racing.ts` and `types/acquisitionIntents.ts`
  have comments like "Types mirrored from membrane-core rps_engine.rs". Update these comments
  when the source file changes.
- **Cross-organ flows are the highest-value docs.** The files in `docs/cross-organ/` in
  membrane-core describe multi-contract interactions that are critical for frontend developers.
  When these change, the corresponding membrane-app documentation and service logic must be
  updated carefully.

## How Bad Debt Flows

Critical cross-contract flow for the CDP system. Keep this section updated when bad debt
handling changes in membrane-core.

### Current Flow (revenue-based, no MBRN mints)

```
1. CDP: Insolvent position detected (collateral value < $1)
   → check_and_fulfill_bad_debt() in contracts/cdp/src/contract.rs

2. CDP: First tries basket.pending_revenue to cover bad debt

3. CDP: Routes per-asset bad debt to LTV Disco via AddBadDebt { asset, amount }
   → Only if LTV Disco can handle it (queried via CanHandleBadDebt)

4. CDP: Remaining bad debt → toggles revenue-distributor ON
   → RevDistExecuteMsg::ToggleBadDebtFulfillment { toggle: true }
   → Sets BAD_DEBT_ACTIVE = true in revenue-distributor state

5. Revenue-distributor: While BAD_DEBT_ACTIVE == true:
   → Queries CDP GetBasket for pending_bad_debt
   → Sends min(available_CDT, pending_bad_debt) to CDP FulfillBadDebt
   → Distributes any remainder normally to destinations

6. CDP: fulfill_bad_debt() burns CDT, decrements pending_bad_debt
   → When pending_bad_debt reaches zero, sends ToggleBadDebtFulfillment { toggle: false }
   → Revenue-distributor resumes normal distribution
```

### Key Contracts & Messages

| Contract | Key Messages | File |
|----------|-------------|------|
| CDP | `FulfillBadDebt {}` (receives CDT) | `contracts/cdp/src/contract.rs` |
| CDP | `check_and_fulfill_bad_debt()` (internal) | `contracts/cdp/src/contract.rs` |
| Revenue Distributor | `ToggleBadDebtFulfillment { toggle }` | `contracts/revenue-distributor/src/contract.rs` |
| Revenue Distributor | `BadDebtActive {}` (query) | `contracts/revenue-distributor/src/query.rs` |

### Frontend Impact

- Query `BadDebtActive {}` on revenue-distributor to show when revenue is being redirected
- Debt auctions (`SwapForMbrn`) are deprecated — remove any UI for debt auction participation
- `pending_bad_debt` field on Basket query shows current bad debt amount
