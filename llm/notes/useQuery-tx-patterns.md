# Standard Patterns for useQuery Transaction Message Construction

## Overview
This document outlines the standard patterns and best practices for using `useQuery` to construct transaction execution messages in the membrane-app codebase.

## Core Pattern Structure

### 1. Basic Hook Structure

All transaction hooks follow this general structure:

```typescript
import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'

const useYourHook = (params: YourParams) => {
  const { address } = useWallet()
  
  // Define QueryData type for type safety
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  
  // useQuery for message construction
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [...],
    queryFn: () => {
      // Early returns for missing dependencies
      if (!address || !otherRequiredParam) {
        return { msgs: undefined } // or { msgs: [] }
      }
      
      // Construct messages
      const msgs: MsgExecuteContractEncodeObject[] = []
      // ... message construction logic
      
      return { msgs }
    },
    enabled: !!address && !!otherRequiredParam,
  })
  
  // Extract msgs with fallback
  const msgs = queryData?.msgs ?? []
  
  // onSuccess callback for query invalidation
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['relevant_query_key'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    // ... other invalidations
  }
  
  // Return useSimulateAndBroadcast hook
  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['simulation_key', (msgs?.toString() ?? "0")],
      enabled: !!msgs?.length,
      onSuccess,
    })
  }
}
```

### 2. QueryKey Patterns

#### Pattern A: Simple QueryKey (Most Common)
Include all dependencies that affect message construction:

```typescript
queryKey: [
  'action_name', // Descriptive action name
  address,
  asset?.base,
  amount,
  otherDependency,
]
```

**Examples:**
- `['bid', 'msgs', address, selectedAsset?.base, premium, cdt]`
- `['staking', 'msg', address, mbrnAsset?.base, contracts.staking, amount, txType]`
- `['update bid', 'msgs', address, selectedAsset?.base, newAmount]`

#### Pattern B: Complex QueryKey with Multiple Dependencies
For complex operations with many dependencies:

```typescript
queryKey: [
  'complex_action_msgs',
  address ?? null,
  appState.rpcUrl,
  params.tokenId ?? null,
  params.paymentOption?.denom ?? null,
  params.paymentOption?.amount ?? null,
  params.contractAddress ?? (contracts as any).car ?? null,
]
```

**Key Points:**
- Use `?? null` for optional values to ensure consistent cache keys
- Include all parameters that affect message construction
- Use descriptive prefixes (e.g., `_msgs`, `_creation`)

#### Pattern C: QueryKey with JSON Stringification
For complex objects in queryKey:

```typescript
queryKey: [
  'mint',
  address,
  positionId,
  summary ? JSON.stringify(summary.map(s => String(s.amount))) : '0',
  mintState?.mint,
  mintState?.repay,
  chainName
]
```

**Note:** Only stringify when necessary. Prefer primitive values when possible.

### 3. QueryFn Patterns

#### Pattern A: Direct Return (Simple Messages)
```typescript
queryFn: () => {
  if (!address || !asset) return
  
  const msg = buildBidMsg({ address, asset, ... })
  return [msg] as MsgExecuteContractEncodeObject[]
}
```

#### Pattern B: Object Return (Preferred for Type Safety)
```typescript
queryFn: () => {
  if (!address || !asset) return { msgs: undefined }
  
  const msgs: MsgExecuteContractEncodeObject[] = []
  msgs.push(buildBidMsg({ ... }))
  
  return { msgs }
}
```

#### Pattern C: Async QueryFn (For Data Fetching)
```typescript
queryFn: async () => {
  if (!client || !address) return { msgs: [] }
  
  // Fetch required data
  const data = await fetchSomeData(client, address)
  
  // Construct messages based on fetched data
  const msgs: MsgExecuteContractEncodeObject[] = []
  // ... message construction
  
  return { msgs }
}
```

### 4. Message Construction Patterns

#### Pattern A: Using Message Composers (Preferred)
```typescript
import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'

const messageComposer = new StakingMsgComposer(address, contracts.staking)
const msg = messageComposer.stake({ user: address }, funds)
```

#### Pattern B: Using Service Builders
```typescript
import { buildBidMsg } from '@/services/liquidation'

const msg = buildBidMsg({
  address,
  asset: selectedAsset,
  liqPremium: premium,
  funds,
})
```

#### Pattern C: Manual Message Construction
```typescript
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'

const msg: MsgExecuteContractEncodeObject = {
  typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
  value: MsgExecuteContract.fromPartial({
    sender: address,
    contract: contracts.lockdrop,
    msg: toUtf8(JSON.stringify({
      claim: {}
    })),
    funds: []
  })
}
```

**Preference Order:**
1. Message Composers (type-safe, generated from contracts)
2. Service Builders (reusable, tested)
3. Manual Construction (only when necessary)

### 5. Enabled Condition Patterns

#### Pattern A: Simple Enabled
```typescript
enabled: !!address && !!selectedAsset && !!cdt
```

#### Pattern B: Complex Enabled with State Checks
```typescript
enabled: !!address && !!selectedAsset && isUpdated && newAmount < originalAmount
```

#### Pattern C: Enabled with Run Flag
```typescript
enabled: !!address && !!collateralValue && !!managedActionState.collateralAmount && run
```

#### Pattern D: Enabled with Multiple Dependencies
```typescript
enabled: !!client && !!markets && !!address && run
```

**Best Practices:**
- Always include `!!address` check
- Include all required dependencies
- Use `run` flag for conditional execution
- Be explicit about what's required

### 6. Early Return Patterns

#### Pattern A: Return undefined
```typescript
if (!address || !asset) return { msgs: undefined }
```

#### Pattern B: Return Empty Array
```typescript
if (!address || !asset) return { msgs: [] }
```

**Guidelines:**
- Use `undefined` when the query should not run (enabled handles this)
- Use `[]` when you want to return empty but valid result
- Be consistent within a hook

### 7. Message Extraction Patterns

#### Pattern A: Direct Extraction
```typescript
const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({...})
```

#### Pattern B: Object Extraction with useMemo
```typescript
const { data: queryData } = useQuery<QueryData>({...})

const { msgs }: QueryData = useMemo(() => {
  if (!queryData) return { msgs: undefined }
  return queryData
}, [queryData])
```

#### Pattern C: Simple Fallback
```typescript
const msgs = queryData?.msgs ?? []
```

**Preference:** Pattern C (simple fallback) is preferred for most cases.

### 8. onSuccess Invalidation Patterns

#### Standard Invalidations
```typescript
const onSuccess = () => {
  // Always invalidate balances after transactions
  queryClient.invalidateQueries({ queryKey: ['balances'] })
  
  // Invalidate specific data related to the action
  queryClient.invalidateQueries({ queryKey: ['user bids'] })
  queryClient.invalidateQueries({ queryKey: ['liquidation info'] })
  
  // Optional: Call custom callback
  txSuccess?.()
}
```

**Common Query Keys to Invalidate:**
- `['balances']` - After any transaction that affects balances (chain-agnostic)
- `['positions']` - After CDP/mint operations
- `['staked']` - After staking operations
- `['user bids']` - After bid operations
- `['liquidation info']` - After liquidation-related operations
- `['points']` - After operations that earn points

### 9. useSimulateAndBroadcast Integration

#### Standard Pattern
```typescript
return {
  action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['simulation_key', (msgs?.toString() ?? "0")],
    enabled: !!msgs?.length,
    onSuccess,
  })
}
```

#### With Additional Options
```typescript
return {
  action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['simulation_key', simulationSignature],
    enabled: !!msgs?.length,
    onSuccess,
    amount: amount.toString(), // Optional: for fee calculation
    shrinkMessage: true, // Optional: for long messages
  })
}
```

#### Building Stable Simulation Signatures
For complex messages, create stable signatures:

```typescript
const simulationSignature = [
  params.tokenId ?? '',
  params.paymentOption?.denom ?? '',
  params.paymentOption?.amount ?? '',
  (params.contractAddress ?? contracts.car ?? '').toString(),
].join('|')

queryKey: ['refill_energy_sim', simulationSignature]
```

### 10. Type Safety Patterns

#### Define QueryData Type
```typescript
type QueryData = {
  msgs: MsgExecuteContractEncodeObject[] | undefined
  // Optional: Add other return values
  status?: 'pending' | 'finished' | 'error'
}
```

#### Use Generic Type Parameter
```typescript
const { data: queryData } = useQuery<QueryData>({...})
```

### 11. Error Handling Patterns

#### Pattern A: Early Returns (Preferred)
```typescript
queryFn: () => {
  if (!address || !asset) return { msgs: [] }
  // ... safe to proceed
}
```

#### Pattern B: Try-Catch for Async Operations
```typescript
queryFn: async () => {
  try {
    const data = await fetchData()
    // ... construct messages
    return { msgs }
  } catch (e) {
    console.error('Error constructing messages:', e)
    return { msgs: [] }
  }
}
```

### 12. Special Patterns

#### Pattern A: Conditional Message Construction
```typescript
var msg;
if (premium === 10) {
  msg = buildStabilityPooldepositMsg({ address, funds })
} else {
  msg = buildBidMsg({ address, asset, liqPremium: premium, funds })
}
return [msg] as MsgExecuteContractEncodeObject[]
```

#### Pattern B: Multiple Messages
```typescript
const msgs: MsgExecuteContractEncodeObject[] = []

// Add multiple messages
msgs.push(depositMsg)
msgs.push(borrowMsg)
msgs.push(loopMsg)

return { msgs }
```

#### Pattern C: Message Ordering Matters
```typescript
// If repaying and updating assets, repay first
if (mintState.repay > 0) {
  return [...mintAndRepay, ...depositAndWithdraw]
}
return [...depositAndWithdraw, ...mintAndRepay]
```

#### Pattern D: Duplicate Messages
```typescript
const exec = { /* message */ } as MsgExecuteContractEncodeObject
const count = Math.max(1, params.numberOfMatches ?? 1)
const msgs = Array.from({ length: count }, () => ({ ...exec }))
return { msgs }
```

## Ditto Transaction Success Integration

### Overview
The Ditto Speech Box provides a unified transaction confirmation and success flow. When using transaction hooks, integrate with Ditto to show contextual success messages and acknowledgements.

### Integration Pattern

#### Step 1: Use Ditto Confirmation Hook
```typescript
import { useDittoConfirmation } from '@/components/DittoSpeechBox/hooks/useDittoConfirmation'

const YourComponent = () => {
  const { openConfirmation } = useDittoConfirmation()
  const action = useYourHook()
  
  // When user clicks to execute transaction
  const handleExecute = () => {
    openConfirmation(
      action,
      <YourTransactionDetails />, // React node with transaction details
      {
        label: 'Confirm Transaction',
        actionType: 'deposit' // or 'withdraw', 'stake', 'mint', etc.
      }
    )
  }
}
```

#### Step 2: Define Action Type
The `actionType` parameter determines which acknowledgement message is shown. Available types:
- `'deposit'` - For deposit operations
- `'withdraw'` - For withdrawal operations
- `'loop'` - For position looping
- `'mint'` - For minting operations
- `'stake'` - For staking operations
- `'unstake'` - For unstaking operations
- `'swap'` - For swap operations
- `'lock'` - For locking operations
- `'unlock'` - For unlocking operations

#### Step 3: Automatic Success Handling
The Ditto confirmation system automatically:
1. Shows loading view while transaction is pending
2. Shows success view when `tx.isSuccess` is true
3. Displays contextual acknowledgement message based on `actionType` and current page
4. Shows points earned (if applicable)
5. Provides transaction hash link to explorer

#### Step 4: Custom Success Callbacks (Optional)
If you need custom logic on transaction success, use the `txSuccess` callback pattern:

```typescript
const useYourHook = ({ txSuccess }: { txSuccess?: () => void }) => {
  // ... message construction logic
  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    // Custom callback (Ditto will still show success view)
    txSuccess?.()
  }
  
  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['simulation_key'],
      enabled: !!msgs?.length,
      onSuccess,
    })
  }
}
```

### Acknowledgement Messages

#### How It Works
1. Ditto uses `getAcknowledgement(actionType, page)` from `@/config/dittoMessages`
2. Messages are contextual - page-specific messages take priority
3. Falls back to generic messages if no page-specific message exists

#### Adding Custom Acknowledgements
Edit `config/dittoMessages.ts`:

```typescript
export const txAcknowledgements: TxAcknowledgement[] = [
  // Page-specific (higher priority)
  { 
    actionType: 'deposit', 
    page: '/manic', 
    message: "Great! Your position is now earning", 
    priority: 10 
  },
  // Generic fallback
  { 
    actionType: 'deposit', 
    message: "Deposit successful!", 
    priority: 1 
  },
]
```

### Transaction Flow States

The Ditto confirmation system manages these views automatically:

1. **Confirm View** - Shows transaction details, simulation results, confirm button
2. **Loading View** - Shows while transaction is pending (wallet approval + broadcast)
3. **Success View** - Shows success message, acknowledgement, points earned, explorer link
4. **Error View** - Shows error message with retry option

### Points Integration

If your transaction earns points, Ditto automatically:
1. Captures points before transaction
2. Calculates points earned after success
3. Displays points earned in success view
4. Uses 2-second delay to allow on-chain points update

No additional code needed - this is handled automatically by `TxSuccessView`.

### Example: Complete Integration

```typescript
import { useDittoConfirmation } from '@/components/DittoSpeechBox/hooks/useDittoConfirmation'
import useBid from '@/components/Bid/hooks/useBid'

const PlaceBidComponent = () => {
  const { openConfirmation } = useDittoConfirmation()
  
  // Hook returns action with simulate and tx
  const bid = useBid({ 
    txSuccess: () => {
      // Optional: Custom logic after success
      console.log('Bid placed successfully')
    }
  })
  
  const handlePlaceBid = () => {
    // Open Ditto confirmation with transaction details
    openConfirmation(
      bid.action,
      <BidDetailsComponent />, // Your custom transaction details
      {
        label: 'Place Bid',
        actionType: 'deposit' // Determines acknowledgement message
      }
    )
  }
  
  return (
    <Button onClick={handlePlaceBid}>
      Place Bid
    </Button>
  )
}
```

### Key Points

1. **Always use `openConfirmation`** - Don't call `action.tx.mutate()` directly
2. **Provide `actionType`** - This ensures correct acknowledgement messages
3. **Ditto handles success view** - No need to manually show success modals
4. **Suppress toaster** - Ditto replaces the default toaster with contextual messages
5. **Points are automatic** - If points are earned, they're shown automatically

### Legacy Pattern (Still Supported)

For components not yet migrated to Ditto:

```typescript
const useYourHook = ({ txSuccess }: { txSuccess?: () => void }) => {
  // ... message construction
  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.() // Custom callback
  }
  
  return useSimulateAndBroadcast({
    msgs,
    queryKey: ['simulation_key'],
    enabled: !!msgs?.length,
    onSuccess,
  })
}
```

This pattern still works, but Ditto integration is preferred for better UX.

## Service Layer Notes

### Transaction-Specific Notes from Services

1. **liquidation.ts**
   - Uses `LiquidationQueueMsgComposer` for type-safe message construction
   - `buildBidMsg`, `buildRetractBidMsg`, `buildUpdateBidMsg` are reusable builders

2. **stabilityPool.ts**
   - Uses `StabilityPoolMsgComposer` for deposits
   - Simple deposit pattern: `messageComposer.deposit({}, funds)`

3. **managed.ts**
   - Complex async operations for fetching market data
   - Multiple parallel fetches using `Promise.all`
   - Handles up to 11 messages in batch operations

## Checklist for New Transaction Hooks

When creating a new transaction hook, ensure:

- [ ] Import required dependencies (`useQuery`, `MsgExecuteContractEncodeObject`, etc.)
- [ ] Define `QueryData` type for type safety
- [ ] Include all dependencies in `queryKey` array
- [ ] Use early returns for missing dependencies
- [ ] Construct messages using preferred method (Composer > Builder > Manual)
- [ ] Set appropriate `enabled` condition
- [ ] Extract `msgs` with fallback (`?? []` or `?? undefined`)
- [ ] Define `onSuccess` with query invalidations
- [ ] Return `useSimulateAndBroadcast` hook
- [ ] Include `['balances']` in invalidations if balance changes
- [ ] Use stable simulation signatures for complex messages
- [ ] Add appropriate TypeScript types
- [ ] Handle errors appropriately (early returns or try-catch)
- [ ] Document `actionType` for Ditto integration (if applicable)

## Common Pitfalls to Avoid

1. **Missing dependencies in queryKey** - Causes stale cache
2. **Inconsistent enabled conditions** - Messages may not update
3. **Forgetting balance invalidations** - UI shows stale balances
4. **Not handling undefined/null** - Runtime errors
5. **Incorrect message ordering** - Transaction failures
6. **Missing type definitions** - Type safety issues
7. **Not using fallbacks** - Undefined errors
8. **Including non-serializable values in queryKey** - Cache issues
9. **Calling `tx.mutate()` directly** - Bypasses Ditto confirmation flow
10. **Not providing `actionType`** - Generic acknowledgement messages

## Examples Reference

- **Simple**: `components/Bid/hooks/useBid.ts`
- **Update Pattern**: `components/Bid/hooks/useUpdateBid.ts`
- **Staking Pattern**: `components/Stake/hooks/useStake.ts`
- **Complex Async**: `components/Dashboard/hooks/useFulfillManagedMarketIntents.ts`
- **Manual Construction**: `components/Lockdrop/hooks/useClaim.ts`
- **Multiple Messages**: `components/Mint/hooks/useMint.ts`
- **Conditional Logic**: `components/ManagedMarkets/hooks/useIncreasedExposureCard.ts`
- **Ditto Integration**: `components/Bid/PlaceBid.tsx` (uses `useBid` with Ditto)

## Summary

The standard pattern is:
1. Use `useQuery` to construct messages reactively
2. Include all dependencies in `queryKey`
3. Use early returns for missing dependencies
4. Construct messages using Composers or Builders when possible
5. Extract messages with fallback
6. Invalidate relevant queries on success
7. Return `useSimulateAndBroadcast` hook
8. Integrate with Ditto confirmation for better UX (preferred)
9. Use chain-agnostic query keys (e.g., `['balances']` instead of `['osmosis balances']`)

This pattern ensures type safety, proper caching, reactive updates when dependencies change, and a consistent user experience through Ditto integration.

























