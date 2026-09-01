/**
 * End-to-end proof of the FULL Q-Racing mint bridge — offchain game loop + on-chain
 * lazy-mint + swap-path — against a RUNNING dev server AND a running anvil node.
 * Run: pnpm exec tsx scripts/e2e-mint-proof.ts [baseUrl]   (default http://localhost:3005)
 *
 * Prereqs (the orchestrator/dev-env owns these; this script only drives them):
 *   - anvil on http://localhost:8545 (chain 31337) with DeployQRacingMint deployed
 *   - config/evm/addresses.json chain 31337 populated with real qracing.* addresses
 *   - the on-chain MintClaim.signer() == the backend voucher signer (MINT_SIGNER_KEY)
 *   - anvil account #1 funded with CDT (>=25) and USDC (for the swap-path check)
 *
 * Mirrors scripts/e2e-game-proof.ts: same cookie-carrying `call()` + `assert()` style,
 * a compact transcript, exits 0 only if every step behaves, and never prints secrets.
 *
 * Flow: player bootstrap → pet → win a race (real seed→maze→solve→submit) so BYTE exists →
 * link the anvil #1 wallet (nonce → sign → verify) → request a mint voucher → on-chain
 * approve+claim → confirm → state readback (BYTE debited, pet left 'offchain') → bonus
 * USDC→CDT swap-path check (pure on-chain, no API).
 */
import { generateMaze, solveMaze } from '../lib/game/maze'
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { mintClaimAbi, erc20Abi, routerAbi } from '../lib/mint/abi'
import addressBook from '../config/evm/addresses.json'

const base = process.argv[2] ?? 'http://localhost:3005'
const RPC_URL = 'http://localhost:8545'

// ---------------------------------------------------------------------------
// PUBLIC ANVIL DEVNET KEY — account index #1. This is the well-known, published
// Foundry/anvil test mnemonic key ("test test ... junk"). It is NOT a secret and
// guards nothing outside this local devnet. NEVER reuse this pattern for a real key.
// address -> 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
// ---------------------------------------------------------------------------
const ANVIL_1_PK =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

const A = (addressBook as Record<string, Record<string, string>>)['31337']
const MINT_CLAIM = A.qracingMintClaim as Address
const CDT = A.qracingCdt as Address
const USDC = A.qracingUsdc as Address
const ROUTER = A.qracingRouter as Address

const account = privateKeyToAccount(ANVIL_1_PK)
const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) })
const walletClient = createWalletClient({ account, chain: foundry, transport: http(RPC_URL) })

let cookie = ''

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

function assert(cond: boolean, label: string, detail?: unknown) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    console.error(`  ✗ FAILED: ${label}`, detail ?? '')
    process.exit(1)
  }
}

const DEADLINE = () => BigInt(Math.floor(Date.now() / 1000) + 3600)

async function main() {
  console.log(`anvil ${RPC_URL} | dev server ${base} | wallet ${account.address}`)
  console.log(`MintClaim ${MINT_CLAIM} | CDT ${CDT} | USDC ${USDC} | Router ${ROUTER}`)

  console.log('\n1. player bootstrap')
  const player = await call('POST', '/api/game/player')
  assert(player.status === 200 && !!cookie, 'creates player + sets cookie', player)

  console.log('2. create pet')
  const pet = await call('POST', '/api/game/pet', { name: 'mint-proof-runner' })
  assert(
    pet.status === 200 || pet.status === 409, // 409 = already exists from a prior run
    'pet created (or already exists)',
    pet,
  )

  console.log('3. win one race so there is BYTE to mint')
  const start = await call('POST', '/api/game/race/start', { difficulty: 1 })
  assert(start.status === 200 && start.json.raceId, 'race opened, seed issued', start)
  const maze = generateMaze(Number(start.json.mazeSeed), Number(start.json.difficulty))
  const moves = solveMaze(maze)
  assert(Array.isArray(moves) && moves.length > 0, `solver found a path (${moves?.length} moves)`)
  const submit = await call('POST', '/api/game/race/submit', { raceId: start.json.raceId, moves })
  assert(submit.status === 200 && submit.json.verified === true, 'server verified the run', submit)
  console.log(`     ticks=${submit.json.ticks} byteAwarded=${submit.json.byteAwarded}`)

  console.log('4. capture BYTE balance BEFORE minting (state.pet only shows while offchain)')
  const preState = await call('GET', '/api/game/state')
  assert(preState.status === 200, 'state returns', preState)
  const byteBefore = BigInt(preState.json.byteBalance ?? 0)
  assert(byteBefore > 0n, `BYTE balance credited (${byteBefore} base units)`)
  assert(preState.json.pet && preState.json.pet.status === 'offchain', "pet is 'offchain' pre-mint", preState.json.pet)

  console.log('5. link the anvil #1 wallet (nonce → sign → verify)')
  const nonceRes = await call('GET', '/api/game/wallet/nonce')
  assert(nonceRes.status === 200 && !!nonceRes.json.message, 'nonce + message issued', nonceRes)
  const signature = await walletClient.signMessage({ account, message: nonceRes.json.message })
  const verify = await call('POST', '/api/game/wallet/verify', {
    address: account.address,
    signature,
    nonce: nonceRes.json.nonce,
  })
  assert(
    verify.status === 200 && verify.json.linked === true,
    'wallet signature verified + linked',
    verify,
  )

  console.log('6. request a pet_and_byte mint voucher')
  const voucherRes = await call('POST', '/api/mint/voucher', { kind: 'pet_and_byte' })
  assert(
    voucherRes.status === 200 && voucherRes.json.voucher && voucherRes.json.signature,
    'voucher + signature returned',
    voucherRes,
  )
  const claimId: string = voucherRes.json.claimId
  const v = voucherRes.json.voucher as {
    to: Address
    petAttrsHash: Hex
    byteAmount: string
    nonce: string
    deadline: string
  }
  const voucherSig = voucherRes.json.signature as Hex
  const claimedByte = BigInt(v.byteAmount)
  assert(v.to.toLowerCase() === account.address.toLowerCase(), 'voucher.to == linked wallet', v.to)
  console.log(`     claimId=${claimId} byteAmount=${claimedByte} nonce=${v.nonce}`)

  console.log('7. on-chain: read mintFee, approve CDT, claim(voucher, sig)')
  const fee = (await publicClient.readContract({
    address: MINT_CLAIM,
    abi: mintClaimAbi,
    functionName: 'mintFee',
  })) as bigint
  console.log(`     mintFee=${fee} CDT base units`)

  const cdtBeforeClaim = (await publicClient.readContract({
    address: CDT,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint
  assert(cdtBeforeClaim >= fee, `wallet has >= mintFee CDT (${cdtBeforeClaim} >= ${fee})`)

  const approveHash = await walletClient.writeContract({
    address: CDT,
    abi: erc20Abi,
    functionName: 'approve',
    args: [MINT_CLAIM, fee],
  })
  await publicClient.waitForTransactionReceipt({ hash: approveHash })

  const claimHash = await walletClient.writeContract({
    address: MINT_CLAIM,
    abi: mintClaimAbi,
    functionName: 'claim',
    args: [
      {
        to: v.to,
        petAttrsHash: v.petAttrsHash,
        byteAmount: BigInt(v.byteAmount),
        nonce: BigInt(v.nonce),
        deadline: BigInt(v.deadline),
      },
      voucherSig,
    ],
  })
  const claimRcpt = await publicClient.waitForTransactionReceipt({ hash: claimHash })
  assert(claimRcpt.status === 'success', `claim() mined success (tx ${claimHash})`, claimRcpt.status)

  const cdtAfterClaim = (await publicClient.readContract({
    address: CDT,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint
  assert(cdtBeforeClaim - cdtAfterClaim === fee, `exactly mintFee CDT pulled (${cdtBeforeClaim - cdtAfterClaim})`)

  console.log('8. confirm the claim server-side')
  const confirm = await call('POST', '/api/mint/confirm', { claimId, txHash: claimHash })
  assert(
    confirm.status === 200 && confirm.json.status === 'minted',
    "confirm flips status to 'minted'",
    confirm,
  )
  const tokenId = BigInt(confirm.json.tokenId ?? 0)
  assert(tokenId > 0n, `pet NFT minted with tokenId ${tokenId}`, confirm.json)
  console.log(`     byteMinted=${confirm.json.byteMinted} tokenId=${tokenId}`)

  console.log('9. state readback: BYTE debited, pet no longer offchain')
  const postState = await call('GET', '/api/game/state')
  assert(postState.status === 200, 'state returns', postState)
  const byteAfter = BigInt(postState.json.byteBalance ?? 0)
  assert(
    byteAfter === byteBefore - claimedByte,
    `BYTE balance dropped by claimed amount (${byteBefore} - ${claimedByte} = ${byteAfter})`,
    { byteBefore: byteBefore.toString(), claimedByte: claimedByte.toString(), byteAfter: byteAfter.toString() },
  )
  // state.pet is fetched WHERE status='offchain'; after mint the pet is 'minted', so it drops out.
  assert(
    postState.json.pet === null,
    "pet left 'offchain' status after mint (state.pet === null)",
    postState.json.pet,
  )

  console.log('\n10. BONUS — USDC→CDT swap path (pure on-chain, no API)')
  const path = [USDC, CDT] as Address[]
  const amountsIn = (await publicClient.readContract({
    address: ROUTER,
    abi: routerAbi,
    functionName: 'getAmountsIn',
    args: [fee, path],
  })) as readonly bigint[]
  const usdcQuoted = amountsIn[0]
  const pullMax = (usdcQuoted * 105n) / 100n // 5% slippage cap
  console.log(`     getAmountsIn: buying ${fee} CDT costs ~${usdcQuoted} USDC (pullMax @5% = ${pullMax})`)

  const usdcBefore = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint
  assert(usdcBefore >= pullMax, `wallet has USDC to swap (${usdcBefore} >= ${pullMax})`)
  const cdtBeforeSwap = (await publicClient.readContract({
    address: CDT,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint

  const usdcApprove = await walletClient.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'approve',
    args: [ROUTER, pullMax],
  })
  await publicClient.waitForTransactionReceipt({ hash: usdcApprove })

  const swapHash = await walletClient.writeContract({
    address: ROUTER,
    abi: routerAbi,
    functionName: 'swapTokensForExactTokens',
    args: [fee, pullMax, path, account.address, DEADLINE()],
  })
  const swapRcpt = await publicClient.waitForTransactionReceipt({ hash: swapHash })
  assert(swapRcpt.status === 'success', `swapTokensForExactTokens mined (tx ${swapHash})`, swapRcpt.status)

  const usdcAfter = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint
  const cdtAfterSwap = (await publicClient.readContract({
    address: CDT,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint
  const usdcPulled = usdcBefore - usdcAfter
  const cdtReceived = cdtAfterSwap - cdtBeforeSwap
  assert(cdtReceived >= fee, `received >= mintFee CDT from swap (${cdtReceived} >= ${fee})`)
  assert(usdcPulled <= pullMax, `pulled <= pullMax USDC (${usdcPulled} <= ${pullMax})`)
  console.log(`     quoted pullMax=${pullMax} vs actual pulled=${usdcPulled} USDC; CDT received=${cdtReceived}`)

  console.log('\nALL STEPS PASSED — full mint bridge verified end to end (offchain + on-chain + swap).')
}

main().catch((e) => {
  console.error('E2E crashed:', e?.message ?? e)
  process.exit(1)
})
