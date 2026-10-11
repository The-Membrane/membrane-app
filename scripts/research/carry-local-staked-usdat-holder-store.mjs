// Append-only local Saturn prospective records. Raw holder evidence stays in ignored local data.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// V1 remains immutable as an exploratory pilot with two unlinked manual issues.
export const ROOT = resolve('data/research/venue-signals/carry-local-staked-usdat-holder-v2')
export const ISSUE_DIR = join(ROOT, 'issues')
export const SCORE_DIR = join(ROOT, 'scores')
export const ATTEMPT_DIR = join(ROOT, 'attempts')
const MAX_BYTES = 256 * 1024
const RESERVE_BYTES = 1024 * 1024 * 1024
const SHA = /^[0-9a-f]{64}$/
const name = (sequence) => `${String(sequence).padStart(8, '0')}.json`
export const hash = (value) => createHash('sha256').update(value).digest('hex')
const unsealed = ({ sha256: _seal, ...body }) => body

export async function readChain(dir, validate) {
  let files
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const file of files) {
    if (file !== name(rows.length + 1)) throw Error('saturn_chain_gap')
    const bytes = await readFile(join(dir, file))
    if (bytes.length > MAX_BYTES) throw Error('saturn_record_oversize')
    const row = JSON.parse(bytes.toString('utf8'))
    if (
      bytes.toString('utf8') !== `${JSON.stringify(row)}\n` ||
      row.sequence !== rows.length + 1 ||
      row.previousSha256 !== (rows.at(-1)?.sha256 ?? null) ||
      !SHA.test(row.sha256 ?? '') ||
      row.sha256 !== hash(JSON.stringify(unsealed(row)))
    )
      throw Error('saturn_chain_invalid')
    validate(row)
    rows.push(row)
  }
  return rows
}

export async function appendChain(dir, body, validate, stat = statfsSync) {
  await mkdir(dir, { recursive: true })
  const prior = await readChain(dir, validate)
  const payload = {
    ...body,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
  }
  const row = { ...payload, sha256: hash(JSON.stringify(payload)) }
  validate(row)
  const bytes = `${JSON.stringify(row)}\n`
  const length = Buffer.byteLength(bytes)
  if (length > MAX_BYTES) throw Error('saturn_record_oversize')
  const disk = stat(dir)
  if (Number(disk.bavail) * Number(disk.bsize) < RESERVE_BYTES + length)
    throw Error('saturn_disk_reserve')
  const temp = join(dir, `.saturn-${randomUUID()}.tmp`)
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(temp, join(dir, name(row.sequence)))
    const directory = await open(dir, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temp, { force: true })
  }
  return row
}
