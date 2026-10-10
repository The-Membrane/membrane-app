// Bounded local headline snapshot for the Mac recorder. This is display data,
// not a substitute for the sealed RSS poll receipts or the research news ledger.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

import { parsedItemIdentity } from './newsPollLedger.mjs'

export const NEWS_LOCAL_PATH = resolve('data/research/venue-signals/news-local-store.json')
export const MAX_LOCAL_VENUES = 20
export const MAX_LOCAL_PER_VENUE = 100
const MAX_ITEM_BYTES = 16 * 1024
const MAX_STORE_BYTES = 8 * 1024 * 1024
const MIN_FREE_BYTES = 1024 * 1024 * 1024

function iso(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function validItem(item, version) {
  return (
    item &&
    typeof item.venue === 'string' &&
    item.venue.length > 0 &&
    item.venue.length <= 128 &&
    typeof item.title === 'string' &&
    item.title.length > 0 &&
    typeof item.source === 'string' &&
    item.source.length > 0 &&
    typeof item.url === 'string' &&
    /^https?:\/\//.test(item.url) &&
    (item.publishedAt === null || iso(item.publishedAt)) &&
    iso(item.fetchedAt) &&
    (version === 1 ||
      (item.identityVersion === 3 &&
        /^[0-9a-f]{64}$/.test(item.itemIdentitySha256) &&
        item.itemIdentitySha256 === parsedItemIdentity(item))) &&
    Buffer.byteLength(JSON.stringify(item)) <= MAX_ITEM_BYTES
  )
}

const sealItem = (item) => ({
  ...item,
  identityVersion: 3,
  itemIdentitySha256: parsedItemIdentity(item),
})

function validate(snapshot) {
  if (
    !snapshot ||
    ![1, 2].includes(snapshot.version) ||
    !iso(snapshot.updatedAt) ||
    !Array.isArray(snapshot.items) ||
    snapshot.items.length > MAX_LOCAL_VENUES * MAX_LOCAL_PER_VENUE
  )
    throw new Error('Invalid local news snapshot')
  const counts = new Map()
  const seen = new Set()
  for (const item of snapshot.items) {
    if (!validItem(item, snapshot.version)) throw new Error('Invalid local news item')
    const key = JSON.stringify([item.venue, item.url])
    if (seen.has(key)) throw new Error('Duplicate local news item')
    seen.add(key)
    counts.set(item.venue, (counts.get(item.venue) ?? 0) + 1)
    if (counts.size > MAX_LOCAL_VENUES || counts.get(item.venue) > MAX_LOCAL_PER_VENUE)
      throw new Error('Local news bound exceeded')
  }
  return snapshot
}

function assertRegularPath(path) {
  try {
    if (!lstatSync(path).isFile()) throw new Error('Unsafe local news path')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function assertSafeDirectory(path) {
  try {
    if (!lstatSync(path).isDirectory()) throw new Error('Unsafe local news directory')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export function readLocalNews(path = NEWS_LOCAL_PATH) {
  assertSafeDirectory(dirname(path))
  assertRegularPath(path)
  if (!existsSync(path)) return { version: 2, updatedAt: null, items: [] }
  const bytes = readFileSync(path, 'utf8')
  if (Buffer.byteLength(bytes) > MAX_STORE_BYTES) throw new Error('Local news snapshot oversized')
  return validate(JSON.parse(bytes))
}

const byNewest = (a, b) =>
  (b.publishedAt ?? b.fetchedAt).localeCompare(a.publishedAt ?? a.fetchedAt) ||
  b.fetchedAt.localeCompare(a.fetchedAt) ||
  a.url.localeCompare(b.url)

/** @param {{ venue?: string, perVenue?: number, fetchedAfter?: string, fetchedBefore?: string }} options */
export function selectLocalNews(snapshot, options = {}) {
  const { venue, perVenue = 15, fetchedAfter, fetchedBefore } = options
  validate(snapshot)
  if (!Number.isInteger(perVenue) || perVenue < 1 || perVenue > MAX_LOCAL_PER_VENUE)
    throw new Error('Invalid local news limit')
  if (
    (fetchedAfter !== undefined && !iso(fetchedAfter)) ||
    (fetchedBefore !== undefined && !iso(fetchedBefore))
  )
    throw new Error('Invalid local news freshness bound')
  const counts = new Map()
  return snapshot.items
    .filter(
      (item) =>
        (venue === undefined || item.venue === venue) &&
        (fetchedAfter === undefined || item.fetchedAt >= fetchedAfter) &&
        (fetchedBefore === undefined || item.fetchedAt <= fetchedBefore),
    )
    .sort(byNewest)
    .filter((item) => {
      const count = counts.get(item.venue) ?? 0
      counts.set(item.venue, count + 1)
      return count < perVenue
    })
}

function diskGuard(path, extraBytes) {
  let ancestor = dirname(path)
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('No local news output ancestor')
    ancestor = parent
  }
  const fs = statfsSync(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extraBytes < MIN_FREE_BYTES)
    throw new Error('Local news disk reserve reached')
}

export function saveLocalNews(venue, rows, { path = NEWS_LOCAL_PATH, fetchedAt } = {}) {
  if (typeof venue !== 'string' || !venue || venue.length > 128 || !Array.isArray(rows))
    throw new Error('Invalid local news input')
  if (!iso(fetchedAt)) throw new Error('Invalid local news fetch time')
  if (rows.length > MAX_LOCAL_PER_VENUE) throw new Error('Local news batch bound exceeded')
  // Never follow a symlink at the snapshot leaf. The output directory lives in
  // the repo's ignored data tree and is created only by this recorder.
  assertSafeDirectory(dirname(path))
  assertRegularPath(path)
  const prior = readLocalNews(path)
  const byVenue = new Map()
  for (const item of prior.items) {
    if (!byVenue.has(item.venue)) byVenue.set(item.venue, [])
    byVenue.get(item.venue).push(sealItem(item))
  }
  if (!byVenue.has(venue) && byVenue.size >= MAX_LOCAL_VENUES)
    throw new Error('Local news venue bound exceeded')
  const current = new Map((byVenue.get(venue) ?? []).map((item) => [item.url, item]))
  for (const row of rows) {
    const item = sealItem({
      venue,
      title: row.title,
      source: row.source,
      url: row.url,
      publishedAt: row.publishedAt,
      fetchedAt,
    })
    if (!validItem(item, 2)) throw new Error('Invalid local news item')
    // The latest poll's title/source/date must match its sealed parsed-item
    // identity. Keep a newer saved version if a delayed poll arrives later.
    const existing = current.get(item.url)
    current.set(item.url, existing && existing.fetchedAt > fetchedAt ? existing : item)
  }
  byVenue.set(venue, [...current.values()].sort(byNewest).slice(0, MAX_LOCAL_PER_VENUE))
  const snapshot = {
    version: 2,
    updatedAt: prior.updatedAt && prior.updatedAt > fetchedAt ? prior.updatedAt : fetchedAt,
    items: [...byVenue.values()].flat(),
  }
  validate(snapshot)
  const bytes = `${JSON.stringify(snapshot)}\n`
  if (Buffer.byteLength(bytes) > MAX_STORE_BYTES) throw new Error('Local news snapshot oversized')
  diskGuard(path, Buffer.byteLength(bytes))
  mkdirSync(dirname(path), { recursive: true })
  assertSafeDirectory(dirname(path))
  const temp = `${path}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
  }
  return { saved: rows.length, total: snapshot.items.length, updatedAt: snapshot.updatedAt }
}
