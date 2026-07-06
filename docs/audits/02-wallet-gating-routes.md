# Phase 0 Audit 2: Wallet-Gated Rendering by Route

Produced 2026-07-06 on the `evm-migration` branch. Product requirement: full app visibility
without connecting a wallet.

## Verdict

**No route hard-walls on wallet connection today.** The mint page's old hard gate is already
commented out (`pages/[chain]/mint/index.tsx:11-18`). One confirmed data bug and one dead-code
landmine, both fixed/removed on this branch (see bottom).

## Route classification

| Route | Class | Notes |
|---|---|---|
| `/[chain]`, `/about`, `/headquarters`, `/levels` | VIEWABLE | Static/no wallet checks |
| `/[chain]/acquisition-dashboard`, `/ltv-dashboard`, `/membrane-dashboard`, `/control-room` | VIEWABLE | Public hooks (`useBasket`, `useOraclePrice`); TVL computed without address |
| `/[chain]/disco` | VIEWABLE (user metrics correctly gated) | Public disco stats `enabled: true` (`hooks/useDiscoData.ts:31,46`); user hooks `enabled: !!user` (`:61`) |
| `/[chain]/mint` | VIEWABLE | Public `useBasket`/`useRates`/`useBasketAssets` ungated; `useUserPositions` correctly address-gated |
| `/[chain]/stake`, `/transmuter`, `/isolated`, `/boost` | VIEWABLE | User-specific sub-hooks gated appropriately |
| `/[chain]/liquidate` | **PARTIALLY GATED (bug)** | "Collateral at risk" silently zero pre-connect via `useBasketPositions` gate — see fix |
| `/[chain]/portfolio` | Partially gated by design | Inherently user-specific; still renders shell |
| `/[chain]/maze-runners`, `/tournament` | VIEWABLE | Wallet only for score writes |
| Root redirect stubs (`/`, `/bid`, `/borrow`, `/stake`, …) | VIEWABLE | `router.replace` only |

(Deeply nested subcomponents like `BoostSection`/`Governance` internals were grep-swept, not
read line-by-line — spot-check during page rework.)

## Shared mechanisms

1. `hooks/useWallet.ts` — canonical `address` source; returns undefined when disconnected, never blocks render itself. Gating happens at consumers via `enabled: !!address` (78 occurrences, sampled — the vast majority correctly gate genuinely user-specific reads).
2. **The one real bug** — `hooks/useCDP.ts:159-176` `useBasketPositions` fetches *protocol-wide* positions (no address in the query) but was gated `enabled: !!address` (`:173`). Blanked pre-connect: liquidate-page collateral-at-risk (`components/Bid/hooks/useCollateralAtRisk.ts:12,18-19`), nav liquidation detection (`components/Nav/hooks/useLiquidations.ts:32`), public APR estimate (`hooks/useEarnQueries.ts:455`).
3. Public-RPC seam already correct: `helpers/cosmwasmClient.tsx:5-16` uses `appState.rpcUrl` (public, set in `_app.tsx:84-96` independent of wallet). Same pattern must carry into the viem `publicClient` under EVM.
4. `components/RouteGuard.tsx` — hard auth gate with a 3-page public allowlist; **never imported anywhere** (dead code), but a landmine if rewired.

## No wallet-RPC-only public data

No public dataset is fetched exclusively through the connected wallet's provider. (Whether
cosmos-kit's `getRpcEndpoint()` resolves in every pre-connect state was not runtime-verified —
moot under EVM migration, where reads go through a wallet-independent viem `publicClient`.)

## Fixes applied on this branch

1. `hooks/useCDP.ts:173` — `enabled: !!address` → `enabled: !!client` on `useBasketPositions` (matches sibling public hooks).
2. `components/RouteGuard.tsx` — deleted (dead code, dangerous allowlist).
