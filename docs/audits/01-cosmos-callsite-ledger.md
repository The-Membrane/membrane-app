# Phase 0 Audit 1: Cosmos → EVM Call-Site Migration Ledger

Produced 2026-07-06 by a codebase sweep on the `evm-migration` branch. 265 distinct source
files (excluding `.claude/worktrees/*`) import Cosmos packages: components 115, contracts 88,
services 26, hooks 26, helpers 5, pages 4, config 1 (+2 Cosmos-shaped-by-content:
`config/chains.ts`, `config/gas.ts`).

## 1. Call sites by concern

### (a) Wallet connection / session
- `pages/_app.tsx:4-13,104-139` — cosmos-kit `ChainProvider` root (keplr/leap/cosmostation/ledger/station adapters, RPC endpoint overrides). Becomes the `WagmiProvider` + MetaMask connector root.
- `hooks/useWallet.ts:1-8` — thin wrapper over `useChain()`. **Already the abstraction seam** every feature hook consumes (`address`, `isWalletConnected`, `connect`, signing clients, `bech32_prefix`). Swapping its internals for wagmi `useAccount`/`useConnect`/`useDisconnect`/`useWalletClient` is the single highest-leverage change.
- `components/WalletModal.tsx:16` — cosmos-kit wallet-picker modal contract.
- `components/WallectConnect/WalletConnect.tsx:4,9,20-25` — bech32-prefix-based address truncation via `helpers/truncate.ts`.
- `components/Home/LeapOnboarding.tsx:5-6,25-43` — `@leapwallet/elements` onboarding swap widget; Cosmos-only, delete/replace.
- `hooks/useChainRoute.ts:1-21` — `[chain]` route param → `config/chains.ts` chain-name resolution; shape survives but downstream assumes Cosmos chain-name strings.

### (b) Tx signing + broadcast
- `hooks/useTransaction.ts:1-79` — central sign→broadcast pipeline (`DeliverTxResponse`, useMutation). **Second key seam.**
- `hooks/useExecute.ts:1-49` — alternate wrapper taking raw `ExecuteResult` closures.
- `hooks/useSimulate.ts:1-231`, `hooks/useSimulateAndBroadcast.ts:1-53` — Cosmos simulate→gas-buffer→StdFee flow via `config/gas.ts`; fee model has no 1:1 EVM analog (viem `simulateContract` + EIP-1559 estimation replaces it).
- **Seam bypasses** (construct their own signing clients; each needs individual rework to `walletClient.writeContract`):
  `components/Governance/hooks/{useEndProposal,useExecuteProposal,useRemoveProposal}.ts`,
  `components/Lockdrop/hooks/useWithdrawUnlocked.ts`, `components/NFT/hooks/useClientInfo.tsx`,
  `components/Racing/hooks/useUpdateCustomDecal.ts`, `components/Stake/hooks/useRestake.ts`.
- `hooks/useEmissionsVotingSandwich.ts:41-42,61-62` — hand-encodes protobuf `MsgExecuteContract` (`toUtf8`, typeUrl literal); bypasses codegen entirely. Follow-up grep for `MsgExecuteContract.fromPartial` / `typeUrl:` literals recommended to find any siblings.
- `services/osmosis.ts` — message-factory layer under the seam; dozens of composer call sites incl. `swapExactAmountIn` (:759,827) and the multi-message `unloopPosition` (:272-416) / `loopPosition` (:419-516) leverage flows.
- `components/NFT/hooks/useIBC.ts:20,73-171` — IBC transfer messages (Osmosis↔Stargaze bridging); no EVM analog.
- 81 files reference `MsgExecuteContractEncodeObject` — the type-level seam to swap for viem `Abi` + `writeContract` args.

### (c) Contract queries / reads
- `contracts/codegen/*` — 48 generated files, 12 modules, 214 import refs. Active.
- `contracts/generated/*` — 40 generated files, 8 overlapping modules + `.react-query.ts` variants. Also active (`services/vesting.ts`, `services/staking.ts`, `services/liquidation.ts`, `services/lockdrop.ts`, `components/NeutronMint/*`). **Two parallel codegen surfaces — needs reconciliation before ABI-based codegen replaces both.**
- `helpers/cosmwasmClient.tsx:1-28` — query-client factory; the viem `publicClient` replacement target.
- `services/*.ts` — 130 direct `queryContractSmart` call sites (pattern example `services/cdp.ts:50-58,70-77`) + 13 files instantiating typed `*QueryClient`s.
- `hooks/useRpcClient.ts:1-19` + `hooks/useBalance.ts:16,22-38` — parallel osmojs native-module query path (bank/gamm/CL); collapses into viem `getBalance`/`readContract`.
- Direct `queryContractSmart` in component hooks (bypassing `services/`): `hooks/useMembraneDashboard.ts`, `hooks/useQRacing.ts`, `components/Disco/EpochRevenueCard.tsx`, `components/Disco/hooks/useDiscoUnstake.ts`, `components/Racing/hooks/useTournamentQueries.ts`, `useGenerateMaze.ts`, `components/Manic/hooks/useBoostBreakdown.ts`, `components/NeutronMint/hooks/useCapitalRecall.ts`, `useCurrentlyLent.ts`.

### (d) Address & denom handling
- `helpers/chain.ts:1-103` — chain-registry-based symbol↔denom↔decimals resolution; replace with ERC-20 token list + `decimals()`.
- `config/defaults.ts:34-35,134,152+` — RPC URLs, bech32 `mainnetAddrs`, `denoms` map consumed all over swap/loop logic.
- Bech32/denom literals also in: `helpers/referral.ts`, `services/{oracle,transmuter,staking}.ts`, `hooks/useEarnQueries.ts`, `components/Home/hooks/{useUnloop,useBuyAndRedeem}.ts`, `components/Mint/hooks/useUSDCRedemptionWithdraw.ts`, `components/ManagedMarkets/hooks/useMarketCreation.ts`, `components/NeutronMint/*`, plus data files `config/contracts.json`, `config/delegates.json`, `config/lpAssets.json`, `config/venueLabels.ts` → wholesale address-book replacement.
- `coin()`/`coins()` from `@cosmjs/amino` in 14 files (e.g. `services/osmosis.ts:361,391,762,830`).
- `helpers/truncate.ts` — bech32-prefix truncation → generic 0x truncation.

### (e) Chain / network config
- `config/chains.ts:1-64` — Cosmos `ChainConfig[]`; becomes wagmi/viem `chains` + env-driven address book.
- `config/gas.ts:1-58` — uosmo/untrn gas table; delete (EIP-1559 replaces).
- `pages/_app.tsx:124-134` — hardcoded per-chain RPC endpoints.
- `hooks/useRpcClient.ts:8-15` — RPC fallback via cosmos.directory.

### (f) Cosmos-only UI (delete outright or redesign)
- `components/DittoSpeechBox/tabs/SkipWidgets.tsx:1-34` (+ `WidgetSkeleton.tsx`, `blockWidgetTracking.ts`) — Skip bridge widget.
- `components/Home/LeapOnboarding.tsx` — Leap Elements onboarding.
- `components/NFT/BridgeTo.tsx` + `components/NFT/hooks/useIBC.ts` — IBC bridge UI.
- `components/WalletModal.tsx` — cosmos-kit wallet picker.

## 2. Verdict summary

| Bucket | Size | Verdict |
|---|---|---|
| Generated codegen (`contracts/codegen` + `contracts/generated`) | 88 files | Replace wholesale with ABI-driven types (wagmi codegen / abitype) from membrane-solidity `out/` |
| Feature hooks/services on codegen clients or `queryContractSmart` | ~150 files | Replace: same business logic, viem read/write primitives via the new seam |
| Cosmos-only UI | ~6 files | Delete (IBC bridge: confirm no EVM-side requirement) |
| Chain/registry infra (`helpers/chain.ts`, `config/{chains,gas,defaults}`, `helpers/cosmwasmClient.tsx`, `hooks/{useRpcClient,useChainRoute}.ts`) | ~7 files | Replace; small count, highest blast radius |

## 3. Hard parts (design decisions, not mechanical ports)

1. **Multi-message atomic txs** — `unloopPosition`/`loopPosition` (`services/osmosis.ts:272-516`) and IBC flows chain 3+ messages in one Cosmos tx. EVM needs a router/multicall contract or batched-call design. Check whether the deployment-vaults spec already redesigns leverage before porting 1:1.
2. **Fee/gas model** — `useSimulate.ts:22-42` retry heuristics match Cosmos error strings ("insufficient funds", "out of gas"); will misfire on EVM revert reasons. Rebuild around viem `simulateContract` + typed revert decoding.
3. **IBC features** — `useIBC.ts` (channel IDs, timeout heights) is delete-or-redesign.
4. **Denom-string identity** — `denoms[symbol][0/1]` static tables conflate identity/decimals; re-key to ERC-20 address + on-chain `decimals()`.
5. **Raw protobuf construction** — `useEmissionsVotingSandwich.ts` bypasses codegen; sweep for `typeUrl:` literals to find siblings.
6. **Dual codegen trees** — resolve which of `contracts/codegen` vs `contracts/generated` is authoritative per module before replacing both.

## Caveats

Grep-driven sweep with ~25 seam files read in full; the ~150-file "replace" bucket is
characterized by pattern + worked examples, not individually read. Spot-check a sample from
`services/` and `components/*/hooks/` during migration. IBC-deletion and codegen-dedup calls
need a human decision.
