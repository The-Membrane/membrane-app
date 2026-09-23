// Probe every candidate RPC for its real eth_getLogs range cap, save the table to
// public/data/rpc-ring.json. Run before a scan, or whenever the ring looks dead.
//   node scripts/probe-rpc-ring.mjs
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const env = readFileSync(join(root, '.env.local'), 'utf8')
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '')
const extra = String(get('RECORDER_RPC_URL') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const { probeRing, saveRing } = await import('../lib/position-sim/rpcRing.ts')
const t = await probeRing(undefined, extra)
saveRing(t)
for (const e of t.entries) console.log(String(e.cap).padStart(6), String(e.ms).padStart(6) + 'ms', e.alive ? '     ' : ' dead', extra.includes(e.url) ? `env:${new URL(e.url).host}` : e.url)
console.log(`saved public/data/rpc-ring.json — ${t.entries.filter((e) => e.cap > 0).length} endpoints serve getLogs`)
