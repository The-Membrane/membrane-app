// Local, self-sealed prospective Morpho holder observations. The Mac clock is
// not independently attested; a successful eth_call is not a mined payout.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const ROOT = resolve('data/research/venue-signals/carry-local-morpho-holder-v1')
export const ISSUE_DIR = join(ROOT, 'issues')
export const SCORE_DIR = join(ROOT, 'scores')
export const ATTEMPT_DIR = join(ROOT, 'attempts')
export const V2_ISSUE_DIR = join(ROOT, 'v2-issues')
export const V2_SCORE_DIR = join(ROOT, 'v2-scores')
export const V2_ATTEMPT_DIR = join(ROOT, 'v2-attempts')
const MAX_BYTES = 512 * 1024
const RESERVE = 1024 * 1024 * 1024
const SHA = /^[0-9a-f]{64}$/
export const hash = (value) => createHash('sha256').update(value).digest('hex')
const name = (number) => `${String(number).padStart(8, '0')}.json`
const unsealed = ({ sha256: _sha, ...record }) => record

export async function readChain(dir, validate) {
  let files
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const file of files) {
    if (file !== name(records.length + 1)) throw Error('morpho_holder_ledger_gap')
    const bytes = await readFile(join(dir, file))
    if (bytes.length > MAX_BYTES) throw Error('morpho_holder_record_oversize')
    const record = JSON.parse(bytes.toString('utf8'))
    if (
      bytes.toString('utf8') !== `${JSON.stringify(record)}\n` ||
      record.sequence !== records.length + 1 ||
      record.previousSha256 !== (records.at(-1)?.sha256 ?? null) ||
      !SHA.test(record.sha256 ?? '') ||
      record.sha256 !== hash(JSON.stringify(unsealed(record)))
    )
      throw Error('morpho_holder_chain_invalid')
    validate(record)
    records.push(record)
  }
  return records
}

export function seal(record, prior) {
  const body = {
    ...record,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
  }
  return { ...body, sha256: hash(JSON.stringify(body)) }
}

export async function appendChain(dir, record, validate) {
  await mkdir(dir, { recursive: true })
  const prior = await readChain(dir, validate)
  const sealed = seal(record, prior)
  validate(sealed)
  const bytes = `${JSON.stringify(sealed)}\n`
  const length = Buffer.byteLength(bytes)
  if (length > MAX_BYTES) throw Error('morpho_holder_record_oversize')
  const disk = statfsSync(dir)
  if (Number(disk.bavail) * Number(disk.bsize) < RESERVE + length)
    throw Error('morpho_holder_disk_reserve')
  const temporary = join(dir, `.holder-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(temporary, join(dir, name(sealed.sequence)))
    const directory = await open(dir, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
  return sealed
}
