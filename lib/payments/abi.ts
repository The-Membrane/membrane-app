// Hand-written minimal ABIs for on-chain payment plumbing (ERC-20 approvals + swap-quote
// routing). Only the functions/events the app actually calls are declared — we deliberately
// do NOT pull in a codegen'd artifact or add a dependency.
//
// `as const` is load-bearing: it lets viem infer argument/return types at the call sites
// (readContract / writeContract / parseEventLogs).

/** Minimal ERC-20 surface: approval + allowance/balance/decimals reads. */
export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const

/**
 * UniswapV2Router02-compatible router (anvil mock: MinimalV2Router02). Quotes via
 * `getAmountsIn`; swaps buy an EXACT output amount so the user always ends up with exactly
 * the target fee, spending at most `amountInMax` of the input asset.
 */
export const routerAbi = [
  {
    type: 'function',
    name: 'getAmountsIn',
    stateMutability: 'view',
    inputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'swapTokensForExactTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'amountInMax', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'swapETHForExactTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'WETH',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const
