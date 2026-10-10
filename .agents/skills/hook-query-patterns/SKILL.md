---
name: hook-query-patterns
description: >-
  Design patterns for hooks behind CTAs (deposit, claim, withdraw, unstake, lend) and efficient React Query
  usage in membrane-app. Use this skill whenever the user is building a new transaction hook, adding a CTA
  button, writing a mutation or query hook, connecting a form to a blockchain transaction, fixing query spam
  or redundant network requests, debugging stale data or cache issues, or optimizing data fetching — even if
  they just say "add a deposit button", "hook up this form", "why is this refetching so much", or "write a
  hook for X." Covers the full CTA lifecycle: message building, simulation, broadcasting, cache invalidation,
  service layer conventions, and query efficiency patterns.
---

# CTA Hook & Query Patterns

Every transaction in membrane-app follows a three-layer architecture: **build messages → simulate → broadcast**. This skill documents the exact patterns so new hooks are consistent and don't spam the network.

## CTA Hook Architecture

CTA hooks power buttons like Deposit, Claim, Withdraw, and Unstake. They all share the same structure — a `useQuery` that builds CosmWasm messages, piped into `useSimulateAndBroadcast` which handles fee estimation, signing, and broadcasting.

### Template

```typescript
import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import { coin } from '@cosmjs/stargate'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math'

interface UseFeatureActionParams {
  asset: string
  amount: string
  txSuccess?: () => void
}

const useFeatureAction = ({ asset, amount, txSuccess }: UseFeatureActionParams) => {
  const { address } = useWallet()
  const contract = contracts.feature_contract

  // LAYER 1: Build messages
  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['feature_action', 'msgs', address, asset, amount],
    queryFn: () => {
      if (!address || !asset || !amount) return { msgs: undefined }
      if (!contract || contract === '') return { msgs: undefined }

      const microAmount = shiftDigits(amount, 6).dp(0).toString()
      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract,
          msg: toUtf8(JSON.stringify({ your_execute_msg: { asset } })),
          funds: [coin(microAmount, asset)],
        }),
      }
      return { msgs: [msg] }
    },
    enabled: !!address && !!asset && !!amount,
  })

  const msgs = queryData?.msgs ?? []

  // LAYER 2 + 3: Simulate & Broadcast
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['feature'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['feature_action_sim', (msgs?.toString() ?? '0')],
    amount,
    enabled: !!msgs?.length,
    onSuccess,
  })

  return { action, msgs }
}
```

### Why messages are built in useQuery (not useMutation)

Messages are deterministic — given the same inputs, you get the same messages. Wrapping them in `useQuery` means React Query caches the result and only rebuilds when a dependency changes. If they lived inside a `useMutation`, they'd rebuild on every button click and the simulation couldn't run ahead of time. The `useQuery` approach lets the simulation fire automatically as soon as messages are ready, so by the time the user clicks "Deposit", the fee is already estimated.

### Return shape

CTA hooks return `{ action, msgs }`:
- **action.simulate** — simulation state (isLoading, isSuccess, error)
- **action.tx** — the mutation, call `action.tx.mutate()` to trigger wallet signing
- **msgs** — the built messages (empty array means "not ready yet" — use this to disable the button)

Components wire it up like this:
```tsx
const { action } = useDiscoDeposit({ asset, slot, amount, txSuccess: onClose })

<Button
  onClick={() => action.tx.mutate()}
  isLoading={action.simulate.isLoading || action.tx.isLoading}
  isDisabled={!action.simulate.isSuccess}
>
  Deposit
</Button>
```

### Simulation infrastructure (don't reimplement)

Three shared hooks handle the entire simulation-to-broadcast pipeline:

| Hook | Location | What it does |
|------|----------|-------------|
| `useSimulateAndBroadcast` | `hooks/useSimulateAndBroadcast.ts` | Connects simulate → transaction. Fee flows automatically. |
| `useSimulate` | `hooks/useSimulate.ts` | Fee estimation with 5% gas buffer, exponential backoff retry (max 3), smart error categorization (won't retry user errors like insufficient funds). Cache: 15s staleTime, 60s gcTime. |
| `useTransaction` | `hooks/useTransaction.ts` | Wallet signing + broadcasting. Shows toast on success/error. Has `suppressToaster` flag for Ditto. |

These hooks handle retry logic, gas estimation, and error presentation. New CTA hooks should use `useSimulateAndBroadcast` directly — never reimplement simulation or retry.

### Cache invalidation on success

After a successful transaction, invalidate using the broadest relevant query key prefix:

```typescript
const onSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['disco'] })      // All disco queries
  queryClient.invalidateQueries({ queryKey: ['balances'] })    // Always when tokens move
  txSuccess?.()                                                 // Callback last
}
```

The prefix approach (just `['disco']`) catches every query whose key starts with that array — deposits, claims, slots, everything. This is intentional: after a transaction, you want fresh data everywhere in that feature.

Always invalidate `['balances']` when tokens move. If the action affects other features (like voting), add those too:
```typescript
if (unstakeAction === 'request') {
  queryClient.invalidateQueries({ queryKey: ['emissions_user_votes'] })
}
```

### Reference implementations

- **Simple deposit**: `components/Disco/hooks/useDiscoDeposit.ts`
- **Simple claim** (no funds): `components/Disco/hooks/useDiscoClaim.ts`
- **Complex 2-step** with voting sandwich: `components/Disco/hooks/useDiscoUnstake.ts`
- **CDP deposit** with position lookup: `components/NeutronMint/hooks/useDepositTransaction.ts`

---

## Data Query Hooks

Data hooks fetch on-chain state and make it available to components. They follow a consistent pattern with React Query.

### Structure

```typescript
import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'

export const useFeatureData = () => {
  const { appState } = useAppState()
  const { data: client } = useCosmWasmClient(appState.rpcUrl)

  return useQuery({
    queryKey: ['feature', 'data_type', appState.rpcUrl],
    queryFn: () => getFeatureData(client || null),
    enabled: true,
    staleTime: 1000 * 60 * 5,
  })
}
```

### staleTime tiers

Choose based on how quickly data goes stale:

| Freshness | staleTime | Use for |
|-----------|-----------|---------|
| Real-time | `1000 * 30` (30s) | TVL, vault balances, live prices |
| Volatile | `1000 * 60` (1m) | Pending claims, unstake requests |
| Standard | `1000 * 60 * 2` (2m) | User deposits, positions |
| Stable | `1000 * 60 * 5` (5m) | Asset configs, slot queues, APR, contract params |
| Static | `Infinity` | Asset metadata, contract addresses |

Not setting a staleTime means React Query treats data as immediately stale — every component mount triggers a refetch. That's the #1 cause of query spam.

### Query key rules

**Use only primitives — never objects:**
```typescript
// Good: stable, predictable cache keys
queryKey: ['disco', 'asset_queue', asset, appState.rpcUrl]

// Bad: object identity changes every render → infinite cache misses
queryKey: ['disco', { asset, rpcUrl: appState.rpcUrl }]
```

**Always include `appState.rpcUrl`** in data query keys. This ensures cache separation across chains — switching from osmosis to neutron gets fresh data instead of stale cross-chain results.

**For simulation keys**, stringify the messages so re-simulation only happens when messages actually change:
```typescript
queryKey: ['feature_sim', (msgs?.toString() ?? '0')]
```

### enabled gates

Every query needs an `enabled` condition that prevents it from firing before dependencies are ready:

```typescript
// Wait for user to be connected
enabled: !!user && !!asset

// Wait for all form inputs to be valid
enabled: !!address && !!asset && slot >= 1 && slot <= 9 && !!amount

// Wait for messages to be built before simulating
enabled: !!msgs?.length

// Always-on (service handles null client with mock fallback)
enabled: true
```

Without `enabled`, a query with undefined parameters fires immediately, gets back an error or empty result, and then fires again once the real parameters arrive — doubling network traffic for no reason.

### Parallel queries with useQueries

When you need the same data shape for multiple entities (claims per asset, deposits per user):

```typescript
const claimsQueries = useQueries({
  queries: assets.map((asset: string) => ({
    queryKey: ['disco', 'pending_claims', user, asset, appState.rpcUrl],
    queryFn: () => getPendingClaims(client || null, user || '', asset),
    enabled: !!user && !!asset,
    staleTime: 1000 * 60,
  })),
})

const allClaims = claimsQueries.map(q => q.data?.claims || []).flat()
const isLoading = claimsQueries.some(q => q.isLoading)
```

This fires all queries in parallel and React Query deduplicates any overlapping keys. Much better than a serial loop.

### Aggregation hooks

Complex hooks combine multiple queries and memoize the result:

```typescript
const useFeatureMetrics = (user: string | undefined) => {
  const { data: assets } = useFeatureAssets()
  const { data: deposits, isLoading: depositsLoading } = useAllUserDeposits(user)

  const claimsQueries = useQueries({
    queries: (assets?.assets || []).map(a => ({ /* per-asset query */ })),
  })

  const metrics = useMemo(() => {
    if (!deposits || !assets) return null
    return computeMetrics(deposits, claimsQueries)
  }, [deposits, assets, claimsQueries])

  return {
    metrics,
    isLoading: depositsLoading || claimsQueries.some(q => q.isLoading),
  }
}
```

Reference implementations: `hooks/useDiscoData.ts` (useDiscoUserMetrics), `hooks/useAcquisition.ts`.

---

## Service Layer

Services are the `queryFn` implementations — they talk to the chain and return data. Every service follows the same contract.

### Pattern

```typescript
const USE_MOCK_DATA = false  // Toggle for development

export async function getFeatureData(
  client: CosmWasmClient | null,
  contractAddr?: string
) {
  // 1. Mock data path
  if (USE_MOCK_DATA) {
    await new Promise(resolve => setTimeout(resolve, 100))
    return getMockFeatureData()
  }

  // 2. Validate client
  if (!client) return null

  // 3. Validate contract address (fallback to config)
  const contract = contractAddr || (contracts as any).feature_contract
  if (!contract || contract === '') return null

  // 4. Query the chain
  try {
    const result = await client.queryContractSmart(contract, {
      get_feature_data: {}
    })
    return result
  } catch (error) {
    console.error('Error querying feature data:', error)
    return null
  }
}
```

### Conventions

- **Return null on failure, never throw.** Hooks handle null with fallback values. Throwing would break the React Query error boundary and require explicit error handling in every component.
- **Mock data with simulated delay** (100-150ms) so UI transitions look realistic during development.
- **Contract address fallback** from `config/contracts.json` — the optional param is for testing or overrides.
- **Validate contract address string** — check both null and empty string (`!contract || contract === ''`).
- **Exception**: `services/systemDiscounts.ts` returns mock data on error instead of null, because boosts/discounts should always have a fallback value rather than breaking the UI.

### File locations

| Category | Path |
|----------|------|
| CTA hooks | `components/Disco/hooks/`, `components/NeutronMint/hooks/` |
| Data query hooks | `hooks/useDiscoData.ts`, `hooks/useTransmuterData.ts`, `hooks/useAcquisition.ts` |
| Simulation infra | `hooks/useSimulateAndBroadcast.ts`, `hooks/useSimulate.ts`, `hooks/useTransaction.ts` |
| Services | `services/disco.ts`, `services/transmuter.ts`, `services/acquisition.ts` |
| Mock data | `services/discoMockData.ts`, `components/acquisition/mockData.ts` |
| Contract configs | `config/contracts.json` |
| Hook exports | `components/Disco/hooks/index.ts` |

---

## Anti-Patterns

These are the mistakes that cause network spam, stale data bugs, and wasted re-renders.

### Missing staleTime

```typescript
// Bad: refetches on every mount/focus/reconnect
useQuery({ queryKey: ['data'], queryFn: fetchData })

// Good: respects cache for 5 minutes
useQuery({ queryKey: ['data'], queryFn: fetchData, staleTime: 1000 * 60 * 5 })
```

### Objects in query keys

```typescript
// Bad: new object reference every render → cache never hits
queryKey: ['data', { asset, rpcUrl }]

// Good: flat primitives
queryKey: ['data', asset, rpcUrl]
```

### Missing enabled gate

```typescript
// Bad: fires immediately with undefined address, then again when address loads
useQuery({ queryKey: ['user', address], queryFn: () => fetchUser(address!) })

// Good: waits until address exists
useQuery({ queryKey: ['user', address], queryFn: () => fetchUser(address!), enabled: !!address })
```

### Building messages inside useMutation

```typescript
// Bad: no caching, rebuilds on every click, can't pre-simulate
const mutation = useMutation({
  mutationFn: async () => {
    const msg = buildMessage(amount, asset)
    const fee = await simulate(msg)
    return broadcast(msg, fee)
  },
})

// Good: messages cached via useQuery, simulation runs ahead of time
const { data } = useQuery({ queryKey: [...], queryFn: () => ({ msgs: [buildMessage(...)] }) })
const action = useSimulateAndBroadcast({ msgs: data?.msgs ?? [], ... })
```

### Nuking the entire cache

```typescript
// Bad: invalidates every query in the app
queryClient.invalidateQueries()

// Good: targeted prefix
queryClient.invalidateQueries({ queryKey: ['disco'] })
queryClient.invalidateQueries({ queryKey: ['balances'] })
```

### Reimplementing simulation

The simulation layer (`useSimulate`) already handles fee estimation, gas buffering, retry with exponential backoff, and error categorization. Adding custom retry logic or fee estimation on top creates conflicts and duplicated network calls.

### Polling stable data

```typescript
// Bad: polls config every 5 seconds (it changes maybe once a month)
useQuery({ queryKey: ['config'], queryFn: fetchConfig, refetchInterval: 5000 })

// Good: long staleTime, no polling
useQuery({ queryKey: ['config'], queryFn: fetchConfig, staleTime: 1000 * 60 * 5 })
```

Only use `refetchInterval` for genuinely real-time data like visualization streams (`hooks/useVisualizationData.ts` uses 30s interval). For everything else, staleTime is sufficient.
