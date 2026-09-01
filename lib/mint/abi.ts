// Hand-written minimal ABIs for the Q-Racing mint bridge. Only the functions/events the
// app actually calls are declared — we deliberately do NOT pull in a codegen'd artifact or
// add a dependency. Mirrors membrane-solidity (branch feat/qracing-mint-claim):
//   contracts/qracing/MintClaim.sol, ByteToken.sol, PetNFT.sol, mocks/MinimalV2Dex.sol
//
// `as const` is load-bearing: it lets viem infer argument/return types at the call sites
// (readContract / writeContract / parseEventLogs).

/**
 * MintClaim — the lazy-mint bridge. `claim` is NON-payable (the CDT fee is an ERC-20 pull,
 * so the caller must have approved `mintFee` CDT to this contract first). The Voucher tuple
 * field order is load-bearing and must match VOUCHER_TYPEHASH in the contract exactly:
 *   Voucher(address to,bytes32 petAttrsHash,uint256 byteAmount,uint256 nonce,uint256 deadline)
 */
export const mintClaimAbi = [
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'v',
        type: 'tuple',
        components: [
          { name: 'to', type: 'address' },
          { name: 'petAttrsHash', type: 'bytes32' },
          { name: 'byteAmount', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'mintFee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'signer',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'nonceUsed',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'Claimed',
    inputs: [
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: false },
      { name: 'byteAmount', type: 'uint256', indexed: false },
      { name: 'nonce', type: 'uint256', indexed: false },
    ],
  },
] as const

/** Minimal ERC-20 surface: fee approval + allowance/balance/decimals reads. */
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
 * `getAmountsIn`; swaps buy an EXACT CDT amount (`amountOut`) so the user always ends up
 * with exactly `mintFee` CDT, spending at most `amountInMax` of the input asset.
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
