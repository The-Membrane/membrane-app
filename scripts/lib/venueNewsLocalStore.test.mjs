import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readLocalNews, saveLocalNews, selectLocalNews } from './venueNewsLocalStore.mjs'

const T1 = '2026-09-30T21:00:00.000Z'
const T2 = '2026-09-30T22:00:00.000Z'
const row = (id, publishedAt = T1) => ({
  title: `Headline ${id}`,
  source: 'Publisher',
  url: `https://example.com/${id}`,
  publishedAt,
})

function withPath(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'venue-news-local-'))
  const path = join(dir, 'news.json')
  try {
    return fn(path, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('stores raw rows per venue, dedupes venue+URL, and refreshes repeated metadata', () =>
  withPath((path) => {
    saveLocalNews('sGHO', [row(1)], { path, fetchedAt: T1 })
    saveLocalNews('sGHO', [{ ...row(1), title: 'Changed title' }, row(2, T2)], {
      path,
      fetchedAt: T2,
    })
    saveLocalNews('sUSDS', [row(1)], { path, fetchedAt: T2 })
    const snapshot = readLocalNews(path)
    assert.equal(snapshot.version, 2)
    assert.equal(snapshot.items.length, 3)
    assert.equal(selectLocalNews(snapshot, { venue: 'sGHO' }).length, 2)
    assert.equal(
      snapshot.items.find((item) => item.venue === 'sGHO' && item.url.endsWith('/1')).title,
      'Changed title',
    )
    assert.equal(
      snapshot.items.find((item) => item.venue === 'sGHO' && item.url.endsWith('/1')).fetchedAt,
      T2,
    )
    assert.equal(snapshot.items.find((item) => item.venue === 'sUSDS').fetchedAt, T2)
    assert.equal(snapshot.items.find((item) => item.venue === 'sUSDS').title, 'Headline 1')
    assert.equal(
      snapshot.items.every((item) => item.identityVersion === 3),
      true,
    )
    assert.equal(
      snapshot.items.every((item) => /^[0-9a-f]{64}$/.test(item.itemIdentitySha256)),
      true,
    )
    assert.equal(lstatSync(path).mode & 0o777, 0o600)
    assert.deepEqual(
      readdirSync(join(path, '..')).filter((name) => name.endsWith('.tmp')),
      [],
    )
  }))

test('a repeated URL uses the latest poll identity within its own venue only', () =>
  withPath((path) => {
    saveLocalNews('sGHO', [row(1)], { path, fetchedAt: T1 })
    saveLocalNews('sUSDS', [row(1)], { path, fetchedAt: T1 })
    const latest = { ...row(1, T2), title: 'New title', source: 'New publisher' }
    saveLocalNews('sGHO', [latest], { path, fetchedAt: T2 })
    // An older delayed capture must not replace the newest exact identity.
    saveLocalNews('sGHO', [{ ...row(1), title: 'Delayed old title' }], {
      path,
      fetchedAt: T1,
    })
    const snapshot = readLocalNews(path)
    const sGho = snapshot.items.find((item) => item.venue === 'sGHO')
    const sUsds = snapshot.items.find((item) => item.venue === 'sUSDS')
    assert.equal(sGho.title, latest.title)
    assert.equal(sGho.source, latest.source)
    assert.equal(sGho.publishedAt, T2)
    assert.equal(sGho.fetchedAt, T2)
    assert.equal(sUsds.title, 'Headline 1')
    assert.equal(sUsds.fetchedAt, T1)
    assert.equal(snapshot.items.length, 2)
  }))

test('caps each venue at 100 rows and returns at most 15 per venue', () =>
  withPath((path) => {
    saveLocalNews(
      'sGHO',
      Array.from({ length: 100 }, (_, i) => row(i)),
      {
        path,
        fetchedAt: T1,
      },
    )
    saveLocalNews('sGHO', [row(100, T2)], { path, fetchedAt: T2 })
    const snapshot = readLocalNews(path)
    assert.equal(snapshot.items.length, 100)
    assert.equal(selectLocalNews(snapshot).length, 15)
    assert.equal(selectLocalNews(snapshot)[0].url, 'https://example.com/100')
    assert.throws(
      () =>
        saveLocalNews(
          'sGHO',
          Array.from({ length: 101 }, (_, i) => row(i)),
          { path, fetchedAt: T2 },
        ),
      /batch bound/,
    )
  }))

test('filters stale rows before the per-venue limit', () =>
  withPath((path) => {
    saveLocalNews(
      'sGHO',
      Array.from({ length: 20 }, (_, i) => row(i, T2)),
      {
        path,
        fetchedAt: T1,
      },
    )
    saveLocalNews('sGHO', [row(20, T1)], { path, fetchedAt: T2 })
    const items = selectLocalNews(readLocalNews(path), {
      perVenue: 15,
      fetchedAfter: T2,
      fetchedBefore: T2,
    })
    assert.equal(items.length, 1)
    assert.equal(items[0].url, 'https://example.com/20')
  }))

test('rejects symlink and corrupt snapshot instead of reading or overwriting it', () =>
  withPath((path, dir) => {
    const destination = join(dir, 'elsewhere')
    writeFileSync(destination, 'unchanged')
    symlinkSync(destination, path)
    assert.throws(() => saveLocalNews('sGHO', [row(1)], { path, fetchedAt: T1 }), /Unsafe/)
    rmSync(path)
    writeFileSync(path, '{bad json')
    assert.throws(() => saveLocalNews('sGHO', [row(1)], { path, fetchedAt: T1 }))
  }))

test('rejects source tampering against a stored v3 item identity', () =>
  withPath((path) => {
    saveLocalNews('sGHO', [row(1)], { path, fetchedAt: T1 })
    const snapshot = readLocalNews(path)
    snapshot.items[0].source = 'Changed publisher'
    writeFileSync(path, `${JSON.stringify(snapshot)}\n`)
    assert.throws(() => readLocalNews(path), /Invalid local news item/)
  }))
