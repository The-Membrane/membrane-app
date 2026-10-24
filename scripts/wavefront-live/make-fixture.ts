/**
 * Writes tests/unit/fixtures/wavefront-live-reads.json: a handful of the Oct 10 pull's per-event
 * re-reads (aave-events.jsonl.gz, morpho-events.jsonl.gz from the datasets repo), chosen to cover
 * e-mode, multi-collateral, not-liquidatable-at-N and every chain. The live engine's readers are
 * run against a scripted chain that answers exactly these reads, and must produce the same
 * records (tests/unit/wavefrontLiveReads.test.ts).
 *
 *   MEMBRANE_DATASETS_DIR=/path/to/membrane-datasets npx tsx scripts/wavefront-live/make-fixture.ts
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'

const ds = process.env.MEMBRANE_DATASETS_DIR ?? '/home/user/membrane-datasets'
const dir = join(ds, 'recall-coverage/inputs/oct10/onchain')
const read = (f: string) =>
  gunzipSync(readFileSync(join(dir, f)))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

const aave = read('aave-events.jsonl.gz') as Record<string, any>[]
const morpho = read('morpho-events.jsonl.gz') as Record<string, any>[]

const pickAave: Record<string, any>[] = []
const add = (r: Record<string, any> | undefined) => {
  if (r && !pickAave.includes(r)) pickAave.push(r)
}
for (const chain of ['mainnet', 'arbitrum', 'optimism', 'base'])
  add(aave.find((r) => r.chain === chain && r.position.length >= 3 && r.atN.liquidatable))
for (const chain of ['mainnet', 'arbitrum', 'optimism']) add(aave.find((r) => r.chain === chain && r.eMode))
add(aave.find((r) => !r.atN.liquidatable))
add(aave.find((r) => r.position.some((p: any) => p.priceErrN)))

const pickMorpho: Record<string, any>[] = []
for (const chain of ['mainnet', 'base']) {
  pickMorpho.push(...morpho.filter((r) => r.chain === chain).slice(0, 3))
}
const nl = morpho.find((r) => !r.liquidatableN)
if (nl) pickMorpho.push(nl)

const strip = (r: Record<string, any>) => {
  const { hosts, ...rest } = r
  void hosts
  return rest
}
writeFileSync(
  join(__dirname, '../../tests/unit/fixtures/wavefront-live-reads.json'),
  JSON.stringify(
    {
      source: 'membrane-datasets recall-coverage/inputs/oct10/onchain/{aave,morpho}-events.jsonl.gz',
      aave: pickAave.map(strip),
      morpho: pickMorpho.map(strip),
    },
    null,
    1,
  ) + '\n',
)
console.log(`aave ${pickAave.length}, morpho ${pickMorpho.length}`)
