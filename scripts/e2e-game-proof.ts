/**
 * End-to-end proof of the offchain Q-Racing loop against a RUNNING dev server.
 * Run: pnpm exec tsx scripts/e2e-game-proof.ts [baseUrl]
 *
 * Exercises the real HTTP surface (cookie auth included) exactly as a browser would:
 * player bootstrap → pet creation → race start → locally-solved maze → submit →
 * server replay verification → BYTE + points credit → state + leaderboard reads.
 * Exits 0 only if every step behaves; prints a compact transcript, never secrets.
 */
import { generateMaze, solveMaze } from '../lib/game/maze'

const base = process.argv[2] ?? 'http://localhost:3005'
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

async function main() {
  console.log('1. player bootstrap')
  const player = await call('POST', '/api/game/player')
  assert(player.status === 200 && !!cookie, 'creates player + sets cookie', player)

  console.log('2. create pet')
  const pet = await call('POST', '/api/game/pet', { name: 'proof-runner' })
  assert(
    pet.status === 200 || pet.status === 409, // 409 = already exists from a prior run
    'pet created (or already exists)',
    pet,
  )

  console.log('3. start race')
  const start = await call('POST', '/api/game/race/start', { difficulty: 1 })
  assert(start.status === 200 && start.json.raceId, 'race opened, seed issued', start)
  const { raceId, mazeSeed, difficulty } = start.json

  console.log('4. solve maze locally from the server seed')
  const maze = generateMaze(Number(mazeSeed), Number(difficulty))
  const moves = solveMaze(maze)
  assert(Array.isArray(moves) && moves.length > 0, `solver found a path (${moves?.length} moves)`)

  console.log('5. submit path — server must replay and verify')
  const submit = await call('POST', '/api/game/race/submit', { raceId, moves })
  assert(submit.status === 200 && submit.json.verified === true, 'server verified the run', submit)
  console.log(`     ticks=${submit.json.ticks} byteAwarded=${submit.json.byteAwarded}`)

  console.log('5b. cheat check — junk path on a fresh race must NOT verify')
  const start2 = await call('POST', '/api/game/race/start', { difficulty: 1 })
  assert(start2.status === 200, 'second race opened', start2)
  const cheat = await call('POST', '/api/game/race/submit', {
    raceId: start2.json.raceId,
    moves: [0, 0, 0, 0, 0, 0],
  })
  assert(
    cheat.status === 200 && cheat.json.verified === false,
    'wall-spam path rejected (no credit)',
    cheat,
  )

  console.log('6. state readback')
  const state = await call('GET', '/api/game/state')
  assert(state.status === 200, 'state returns', state)
  const balance = BigInt(state.json.byteBalance ?? 0)
  assert(balance > 0n, `BYTE balance credited (${balance} base units)`)
  assert(state.json.energy?.value < 100, 'energy was actually spent', state.json.energy)

  console.log('7. leaderboard (public, no cookie)')
  const savedCookie = cookie
  cookie = ''
  const lb = await call('GET', '/api/game/leaderboard?board=top_times&limit=5')
  cookie = savedCookie
  assert(lb.status === 200 && Array.isArray(lb.json.entries ?? lb.json), 'leaderboard readable', lb)

  console.log('\nALL STEPS PASSED — offchain loop verified end to end.')
}

main().catch((e) => {
  console.error('E2E crashed:', e.message)
  process.exit(1)
})
