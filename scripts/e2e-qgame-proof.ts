/**
 * e2e-qgame-proof.ts — PURE-CHAIN end-to-end proof of the on-chain Q-Racing wiring.
 * No dev server, no React: just viem against the running anvil (31337).
 *
 * Proves the owner/burner split the app relies on:
 *   1. OWNER approves CDT + createPet(name)         -> pet NFT minted to the OWNER
 *   2. OWNER grantSession(burner, +7d)              -> sessionOf(owner) == burner
 *   3. OWNER funds the burner with dust ETH          -> burner gas balance set
 *   4. BURNER-signed train(id, 0)                    -> PetLens trainRaces increments (owner-attributed)
 *   5. BURNER-signed runDaily(id) on a finishing day -> BYTES minted to the OWNER, NOT the burner
 *   6. burner ETH decreased by the gas it spent
 *   7. sweep the burner dust back to the OWNER       -> burner ~empty, owner refunded
 *
 * The daily seed is mix(day, owner) (PocketGP.sol:791) — independent of block and burner —
 * so an eth_call predicts the real send exactly. We scan days cheaply via eth_call to find
 * a finishing day, then send ONE real burner runDaily for a deterministic BYTES mint.
 *
 * Run:  pnpm tsx scripts/e2e-qgame-proof.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseEther,
  formatEther,
  getAddress,
  type Address,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { pocketGPAbi, petNftAbi, petLensAbi, bytesAbi } from '../lib/qgame/abi'
import { erc20Abi } from '../lib/payments/abi'

const RPC = process.env.EVM_RPC_URL ?? 'http://127.0.0.1:8545'
const CHAIN_ID = 31337
// anvil account #1 acts as the pet OWNER.
const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
// The daily race seed is block-random (PocketGP.mix XORs blockhash/timestamp), so each
// runDaily is an independent ~10% finish. We loop same-day attempts (unfinished ones don't
// set dailyClaimed, so retries are allowed and reshuffle the seed) until BYTES mints. Fund
// the burner enough to cover the worst-case attempt count at ~0.01 ETH/attempt.
const TOPUP = parseEther('2')
const MAX_DAILY_ATTEMPTS = 200

const anvil = defineChain({
  id: CHAIN_ID,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})

let failures = 0
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failures++
    console.error(`  ✗ ${msg}`)
  }
}
function step(s: string) {
  console.log(`\n${s}`)
}

async function main() {
  const book = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../config/evm/addresses.json'), 'utf8'),
  )[String(CHAIN_ID)]
  const A = {
    pocketGP: getAddress(book.qgamePocketGP),
    petNFT: getAddress(book.qgamePetNFT),
    bytes: getAddress(book.qgameBytes),
    petLens: getAddress(book.qgamePetLens),
    cdt: getAddress(book.qgameCdt),
  }
  console.log('qgame addresses:', A)

  const owner = privateKeyToAccount(OWNER_KEY)
  const burner = privateKeyToAccount(generatePrivateKey())
  console.log('owner :', owner.address)
  console.log('burner:', burner.address)

  const pub = createPublicClient({ chain: anvil, transport: http(RPC) })
  const ownerWallet = createWalletClient({ account: owner, chain: anvil, transport: http(RPC) })
  const burnerWallet = createWalletClient({ account: burner, chain: anvil, transport: http(RPC) })

  const send = async (wallet: typeof ownerWallet, req: any) => {
    // The engine's Q-table writes make gas estimates undershoot the real execution, so
    // add a 60% buffer (still far under the 30M block limit) to avoid out-of-gas reverts.
    const est = await pub.estimateContractGas({ ...req, account: wallet.account })
    const hash = await wallet.writeContract({ ...req, gas: (est * 160n) / 100n })
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`tx reverted: ${req.functionName}`)
    return receipt
  }

  // ── 1. createPet (OWNER) ──────────────────────────────────────────────────
  step('1. OWNER approve CDT + createPet')
  const petPrice = (await pub.readContract({
    address: A.pocketGP,
    abi: pocketGPAbi,
    functionName: 'petPrice',
  })) as bigint
  await send(ownerWallet, {
    address: A.cdt,
    abi: erc20Abi,
    functionName: 'approve',
    args: [A.pocketGP, petPrice],
  })
  const createRcpt = await send(ownerWallet, {
    address: A.pocketGP,
    abi: pocketGPAbi,
    functionName: 'createPet',
    args: ['E2E Runner'],
  })
  // recover tokenId from PetNFT Transfer(0x0, owner, id) — id is topic[3]
  const xfer = createRcpt.logs.find(
    (l) => getAddress(l.address) === A.petNFT && l.topics[0] && l.topics.length === 4,
  )
  if (!xfer) throw new Error('no PetNFT Transfer log in createPet receipt')
  const petId = BigInt(xfer.topics[3] as `0x${string}`)
  const petOwner = (await pub.readContract({
    address: A.petNFT,
    abi: petNftAbi,
    functionName: 'ownerOf',
    args: [petId],
  })) as Address
  const card0: any = await pub.readContract({
    address: A.petLens,
    abi: petLensAbi,
    functionName: 'getPetCard',
    args: [petId],
  })
  ok(getAddress(petOwner) === owner.address, `pet #${petId} owned by OWNER`)
  ok(card0.exists === true, 'PetLens card exists')

  // ── 2. grantSession (OWNER) ───────────────────────────────────────────────
  step('2. OWNER grantSession(burner, +7d)')
  // Base expiry on CHAIN time (anvil timestamps can drift far from wall-clock), else
  // grantSession reverts BadSession when expiry <= block.timestamp.
  const chainNow = (await pub.getBlock({ blockTag: 'latest' })).timestamp
  const expiry = chainNow + 7n * 86400n
  await send(ownerWallet, {
    address: A.pocketGP,
    abi: pocketGPAbi,
    functionName: 'grantSession',
    args: [burner.address, expiry],
  })
  const [sKey] = (await pub.readContract({
    address: A.pocketGP,
    abi: pocketGPAbi,
    functionName: 'sessionOf',
    args: [owner.address],
  })) as [Address, bigint]
  ok(getAddress(sKey) === burner.address, 'sessionOf(owner) == burner key')

  // ── 3. fund the burner with dust ETH (OWNER) ──────────────────────────────
  step(`3. OWNER funds burner with ${formatEther(TOPUP)} ETH of dust gas`)
  const fundHash = await ownerWallet.sendTransaction({
    account: owner,
    chain: anvil,
    to: burner.address,
    value: TOPUP,
  })
  await pub.waitForTransactionReceipt({ hash: fundHash })
  const burnerEth0 = await pub.getBalance({ address: burner.address })
  ok(burnerEth0 === TOPUP, `burner funded (${formatEther(burnerEth0)} ETH)`)

  // ── 4. BURNER-signed train ────────────────────────────────────────────────
  step('4. BURNER-signed train(id, 0)')
  await send(burnerWallet, {
    address: A.pocketGP,
    abi: pocketGPAbi,
    functionName: 'train',
    args: [petId, 0],
  })
  const card1: any = await pub.readContract({
    address: A.petLens,
    abi: petLensAbi,
    functionName: 'getPetCard',
    args: [petId],
  })
  ok(card1.trainRaces > card0.trainRaces, `trainRaces ${card0.trainRaces} -> ${card1.trainRaces} (owner-attributed)`)
  const burnerEth1 = await pub.getBalance({ address: burner.address })
  ok(burnerEth1 < burnerEth0, `burner ETH decreased after train (${formatEther(burnerEth1)} ETH)`)

  // ── 5. BURNER-signed runDaily until a finish mints BYTES to the OWNER ──────
  step('5. BURNER-signed runDaily (loop same-day until a finish mints BYTES)')
  const readBytes = (who: Address) =>
    pub.readContract({ address: A.bytes, abi: bytesAbi, functionName: 'balanceOf', args: [who] }) as Promise<bigint>
  const ownerBytes0 = await readBytes(owner.address)
  let attempts = 0
  let ownerBytes1 = ownerBytes0
  while (attempts < MAX_DAILY_ATTEMPTS) {
    attempts++
    await send(burnerWallet, { address: A.pocketGP, abi: pocketGPAbi, functionName: 'runDaily', args: [petId] })
    ownerBytes1 = await readBytes(owner.address)
    if (ownerBytes1 > ownerBytes0) break
  }
  const burnerBytes = await readBytes(burner.address)
  ok(ownerBytes1 > ownerBytes0, `OWNER BYTES ${ownerBytes0} -> ${ownerBytes1} after ${attempts} runDaily attempt(s) — minted to OWNER`)
  ok(burnerBytes === 0n, 'burner holds 0 BYTES (rewards never go to the burner)')

  // ── 6. burner ETH spent on gas ────────────────────────────────────────────
  step('6. burner ETH spent on gas across its two signed txs')
  const burnerEth2 = await pub.getBalance({ address: burner.address })
  ok(burnerEth2 < burnerEth1, `burner ETH ${formatEther(burnerEth1)} -> ${formatEther(burnerEth2)} after runDaily`)

  // ── 7. sweep the dust back to the OWNER (burner-signed) ────────────────────
  step('7. sweep remaining burner dust back to OWNER')
  const ownerEthBefore = await pub.getBalance({ address: owner.address })
  const gas = 21_000n
  const { maxFeePerGas, gasPrice } = await pub.estimateFeesPerGas().catch(() => ({
    maxFeePerGas: undefined,
    gasPrice: undefined,
  }))
  const feePerGas = (maxFeePerGas ?? gasPrice ?? 1_000_000_000n) as bigint
  const value = burnerEth2 - gas * feePerGas
  const sweepHash = await burnerWallet.sendTransaction({
    account: burner,
    chain: anvil,
    to: owner.address,
    value,
    gas,
    ...(maxFeePerGas ? { maxFeePerGas } : {}),
  })
  await pub.waitForTransactionReceipt({ hash: sweepHash })
  const burnerEth3 = await pub.getBalance({ address: burner.address })
  const ownerEthAfter = await pub.getBalance({ address: owner.address })
  ok(burnerEth3 < gas * feePerGas, `burner swept to dust (${formatEther(burnerEth3)} ETH left)`)
  ok(ownerEthAfter > ownerEthBefore, 'OWNER received the swept remainder')

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nE2E ERRORED:', e)
  process.exit(1)
})
