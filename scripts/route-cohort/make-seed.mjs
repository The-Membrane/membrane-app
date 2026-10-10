import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAddress } from 'viem'
import { normalizeSeed } from './collector.mjs'

/** Only vault routes are ERC-4626-readable. Lending destinations need a separate reader. */
export function buildSeed(raw, sourceName, sourceSha256, cohortId) {
  const routes = JSON.parse(raw)
  if (!Array.isArray(routes)) throw new Error('Route artifact must be an array')
  const positions = new Map()
  let unsupported = 0
  for (const row of routes) {
    if (row.destKind !== 'vault' || !isAddress(row.dest, { strict: false })) {
      unsupported++
      continue
    }
    if (!isAddress(row.borrower, { strict: false }) || typeof row.route !== 'string') {
      throw new Error('Vault route has invalid owner or route identity')
    }
    const owner = row.borrower.toLowerCase()
    const vault = row.dest.toLowerCase()
    const id = `${owner}:${vault}`
    const prior = positions.get(id)
    if (prior) prior.routeIds.add(row.route)
    else positions.set(id, { owner, vault, routeIds: new Set([row.route]) })
  }
  const seed = {
    schemaVersion: 1,
    cohortId,
    source: { name: sourceName, sha256: sourceSha256 },
    positions: [...positions.values()]
      .map((position) => ({ ...position, routeIds: [...position.routeIds].sort() }))
      .sort((a, b) => `${a.owner}:${a.vault}`.localeCompare(`${b.owner}:${b.vault}`)),
  }
  normalizeSeed(seed)
  return { seed, unsupported }
}

export async function run(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    throw new Error(
      'Usage: node scripts/route-cohort/make-seed.mjs <routes_ab.json> <cohort-id> <output.json>',
    )
  }
  const [input, cohortId, output] = argv
  if (resolve(input) === resolve(output)) throw new Error('Input and output paths must differ')
  const raw = await readFile(input, 'utf8')
  const sha256 = createHash('sha256').update(raw).digest('hex')
  const { seed, unsupported } = buildSeed(raw, basename(input), sha256, cohortId)
  await writeFile(output, `${JSON.stringify(seed)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(
    JSON.stringify({ output: resolve(output), positions: seed.positions.length, unsupported }) +
      '\n',
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
