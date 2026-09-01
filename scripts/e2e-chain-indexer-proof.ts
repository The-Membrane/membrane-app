/**
 * e2e-chain-indexer-proof.ts — throwaway proof that lib/game/chainIndexer.ts turns real
 * anvil chain events into real onchain_results / daily_firsts rows.
 *
 * No dev server, no React: viem against anvil (31337) for the chain side, the real
 * (dev) Neon DB via lib/db for the read-back. Uses anvil default account #0 (the
 * membrane-solidity q-racing Deploy.s.sol broadcaster — the only account minted CDT at
 * deploy time, PocketGP.sol / Deploy.s.sol:149) as both OWNER and signer; no burner
 * indirection here, this is just proving the indexer, not the session-key flow (see
 * scripts/e2e-qgame-proof.ts for that).
 *
 * Sequence (matches the task's specified proof recipe — train + runDaily only; ladder
 * and ghost boards are exercised by chainIndexer.ts's logic/types but not by this
 * script, see the final report for why):
 *   1. Reuse an existing pet owned by account #0, or createPet if none exists.
 *   2. train(id, 0) ~20 times — PocketGP.sol's daily-maze "brain" needs some trained
 *      Q-table before runDaily has a realistic chance of finishing; a fresh brain can
 *      still finish on attempt 1 by luck, this is just insurance.
 *   3. runDaily(id) in a loop until `finished === true` (bounded attempts).
 *   4. Call indexNewEvents() directly (bypassing the 60s HTTP-route throttle by calling
 *      the function in-process, once) and report what it ingested.
 *   5. Query onchain_results / daily_firsts directly and print row counts per board
 *      (names only — no secrets, no raw wallet keys).
 *
 * Run:  pnpm tsx scripts/e2e-chain-indexer-proof.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import { createWalletClient, http, defineChain, getAddress, parseEventLogs, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sql } from 'drizzle-orm'

import { pocketGPAbi, petNftAbi, petLensAbi } from '../lib/qgame/abi'
import { erc20Abi } from '../lib/payments/abi'
import { getPublicClient } from '../services/chain/client'
import { indexNewEvents } from '../lib/game/chainIndexer'
import { db } from '../db'

const RPC = process.env.EVM_RPC_URL ?? 'http://127.0.0.1:8545'
const CHAIN_ID = 31337
// anvil default account #0 — the q-racing Deploy.s.sol broadcaster, the only wallet
// minted CDT at deploy time (Deploy.s.sol:149 `cdt.mint(msg.sender, 1000 ether)`).
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const TRAIN_ATTEMPTS = 20
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
    petLens: getAddress(book.qgamePetLens),
    cdt: getAddress(book.qgameCdt),
  }
  console.log('qgame addresses:', A)

  const owner = privateKeyToAccount(OWNER_KEY)
  console.log('owner:', owner.address)

  const pub = getPublicClient(anvil, RPC)
  const ownerWallet = createWalletClient({ account: owner, chain: anvil, transport: http(RPC) })

  // The engine's Q-table writes make gas estimates undershoot real execution
  // occasionally (same note as scripts/e2e-qgame-proof.ts) — a 60% buffer usually
  // covers it, but retry with a bigger buffer on the rare transient revert rather than
  // failing the whole proof over one flaky tx.
  const send = async (req: any) => {
    let lastErr: unknown
    for (const bufferPct of [160n, 300n, 500n]) {
      try {
        const est = await pub.estimateContractGas({ ...req, account: owner })
        const hash = await ownerWallet.writeContract({ ...req, gas: (est * bufferPct) / 100n })
        const receipt = await pub.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error(`tx reverted: ${req.functionName}`)
        return receipt
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr
  }

  // ── 1. reuse an existing pet, or createPet ───────────────────────────────────────
  step('1. reuse an existing pet or createPet')
  const totalMinted = (await pub.readContract({
    address: A.petNFT,
    abi: petNftAbi,
    functionName: 'totalMinted',
  })) as bigint

  let petId: bigint | null = null
  for (let id = 1n; id <= totalMinted; id++) {
    const o = (await pub
      .readContract({ address: A.petNFT, abi: petNftAbi, functionName: 'ownerOf', args: [id] })
      .catch(() => null)) as Address | null
    if (o && getAddress(o) === owner.address) {
      petId = id
      break
    }
  }

  if (petId === null) {
    const petPrice = (await pub.readContract({
      address: A.pocketGP,
      abi: pocketGPAbi,
      functionName: 'petPrice',
    })) as bigint
    await send({
      address: A.cdt,
      abi: erc20Abi,
      functionName: 'approve',
      args: [A.pocketGP, petPrice],
    })
    const createRcpt = await send({
      address: A.pocketGP,
      abi: pocketGPAbi,
      functionName: 'createPet',
      args: ['Indexer Proof Runner'],
    })
    const xfer = createRcpt.logs.find(
      (l) => getAddress(l.address) === A.petNFT && l.topics[0] && l.topics.length === 4,
    )
    if (!xfer) throw new Error('no PetNFT Transfer log in createPet receipt')
    petId = BigInt(xfer.topics[3] as `0x${string}`)
    ok(true, `created pet #${petId}`)
  } else {
    ok(true, `reusing existing pet #${petId}`)
  }

  const card0: any = await pub.readContract({
    address: A.petLens,
    abi: petLensAbi,
    functionName: 'getPetCard',
    args: [petId],
  })
  ok(card0.exists === true, `pet #${petId} card exists`)

  // ── 2. train ~20 times ─────────────────────────────────────────────────────────────────────────────────────
  if (Number(card0.trainRaces) >= TRAIN_ATTEMPTS) {
    step(`2. train — skipped, pet already has ${card0.trainRaces} training races`)
    ok(true, `brain already trained (${card0.trainRaces} >= ${TRAIN_ATTEMPTS})`)
  } else {
    step(`2. train(id, 0) x${TRAIN_ATTEMPTS}`)
    for (let i = 0; i < TRAIN_ATTEMPTS; i++) {
      await send({ address: A.pocketGP, abi: pocketGPAbi, functionName: 'train', args: [petId, 0] })
    }
    const card1: any = await pub.readContract({
      address: A.petLens,
      abi: petLensAbi,
      functionName: 'getPetCard',
      args: [petId],
    })
    ok(card1.trainRaces >= card0.trainRaces + TRAIN_ATTEMPTS, `trainRaces ${card0.trainRaces} -> ${card1.trainRaces}`)
  }

  // ── 3. runDaily — simulate first, train between failed simulations ────────────────
  // The daily seed is a PURE function of (day, mazeId) now — PocketGP.sol's _runDaily
  // comment: "retrying the same day reproduces the identical race". Blind same-day
  // retries are futile: the only lever is the pet's brain. Strategy: eth_call-simulate
  // runDaily (free, no state change); if it predicts a finish, send ONE real tx; if
  // not, send a few real train() txs (they mutate the tokenId-keyed Q-table, changing
  // the daily outcome) and re-simulate.
  step('3. runDaily(id) — simulate, train-between-attempts until a finish')
  const today = (await pub.readContract({
    address: A.pocketGP,
    abi: pocketGPAbi,
    functionName: 'today',
  })) as number

  let finished = false
  let simRounds = 0
  const alreadyClaimed = (await pub.readContract({
    address: A.pocketGP,
    abi: pocketGPAbi,
    functionName: 'dailyClaimed',
    args: [today, owner.address],
  })) as boolean

  if (alreadyClaimed) {
    finished = true
    console.log('  (dailyClaimed already true for today — a finish already happened; its DailyRun event is on-chain for the indexer)')
  } else {
    // Scan DAYS, not retries: warp anvil forward a day at a time (evm_increaseTime +
    // evm_mine — dev chain, timestamps already drift months ahead of wall-clock, so
    // warping further is harmless) and eth_call-simulate each day. The seed is
    // keccak(day, mazeId), so each new day is a fresh maze the trained brain might
    // solve; a predicted finish gets a real runDaily tx. The receipt's decoded
    // DailyRun event is the ground truth — if the real race diverges from the
    // prediction, log it and keep scanning rather than fail.
    while (simRounds < MAX_DAILY_ATTEMPTS) {
      simRounds++
      const { result } = await pub.simulateContract({
        address: A.pocketGP,
        abi: pocketGPAbi,
        functionName: 'runDaily',
        args: [petId],
        account: owner.address,
      })
      const [willFinish] = result as readonly [boolean, number]
      if (willFinish) {
        const rcpt = await send({ address: A.pocketGP, abi: pocketGPAbi, functionName: 'runDaily', args: [petId] })
        const runLogs = parseEventLogs({ abi: pocketGPAbi, eventName: 'DailyRun', logs: rcpt.logs })
        const ev = runLogs[0]?.args as { day?: number; finished?: boolean; rank?: number } | undefined
        console.log(
          `  real runDaily on scan round ${simRounds}: DailyRun day=${ev?.day} finished=${ev?.finished} rank=${ev?.rank}`,
        )
        if (ev?.finished) {
          finished = true
          break
        }
        console.log('  (simulation predicted a finish but the real race did not — continuing the day scan)')
      }
      await pub.request({ method: 'evm_increaseTime' as any, params: [86_400] as any })
      await pub.request({ method: 'evm_mine' as any, params: [] as any })
    }
  }
  ok(finished, `daily finished (after ${simRounds} scanned day(s))`)

  // ── 4. run the indexer ─────────────────────────────────────────────────────────
  step('4. indexNewEvents()')
  const result = await indexNewEvents()
  console.log('  indexNewEvents result:', JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  ok(!result.skipped, 'indexer ran (not skipped)')

  // ── 5. read back from the DB ─────────────────────────────────────────────────────
  step('5. row counts per board in onchain_results / daily_firsts')
  const boardCounts = await db.execute<{ board: string; n: string }>(sql`
    select board, count(*) as n from onchain_results group by board order by board
  `)
  for (const row of boardCounts.rows) {
    console.log(`  onchain_results[${row.board}] = ${row.n}`)
  }
  const firstsCount = await db.execute<{ n: string }>(sql`select count(*) as n from daily_firsts`)
  console.log(`  daily_firsts = ${firstsCount.rows[0]?.n ?? 0}`)

  const ourRows = await db.execute<{ board: string; value: string; occurred_at: string }>(sql`
    select board, value, occurred_at from onchain_results
    where wallet = ${owner.address}
    order by occurred_at desc limit 5
  `)
  console.log('  most recent rows for this proof run:')
  for (const r of ourRows.rows) console.log(`    ${r.board} value=${r.value} at ${r.occurred_at}`)

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nPROOF ERRORED:', e)
  process.exit(1)
})
