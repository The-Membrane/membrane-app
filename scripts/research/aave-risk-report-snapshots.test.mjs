import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { collect, digest, matchingTitle, readCheckpoint } from './aave-risk-report-snapshots.mjs'

const fixedNow = () => new Date('2026-09-25T19:00:00.000Z')
const categoryList = {
  category_list: {
    categories: [
      { id: 7, name: 'Risk' },
      { id: 4, name: 'Governance' },
    ],
  },
}
const listing = (topics, more = null) => ({ topic_list: { topics, more_topics_url: more } })
const topic = (id, title) => ({
  id,
  title,
  created_at: '2026-09-20T00:00:00Z',
  last_posted_at: '2026-09-24T00:00:00Z',
  posts_count: 2,
})
const ok = (value, headers = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { date: 'Fri, 25 Sep 2026 19:00:00 GMT', ...headers },
  })

function mockFetch({
  raw = 'Borrow cap: 100m to 120m',
  version = 1,
  more = null,
  failPost = false,
  pages = [],
} = {}) {
  const seen = []
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname
    seen.push(path)
    if (path === '/categories.json') return ok(categoryList)
    if (path === '/c/risk/7.json')
      return ok(
        listing(
          [topic(10, 'Risk Steward cap recommendation'), topic(11, 'Unrelated social thread')],
          more,
        ),
      )
    if (path === '/c/governance/4.json') return ok(listing([topic(12, 'Governance discussion')]))
    if (path === '/t/10.json')
      return ok({ id: 10, post_stream: { posts: [{ id: 101, post_number: 1 }] } })
    if (path === '/posts/101.json')
      return failPost
        ? new Response('failure', { status: 503 })
        : ok({
            id: 101,
            topic_id: 10,
            post_number: 1,
            version,
            created_at: '2026-09-20T00:00:00Z',
            updated_at: '2026-09-24T00:00:00Z',
            raw,
          })
    if (path === '/c/risk/7/page2.json') return ok(listing(pages))
    throw new Error(`Unexpected URL ${url}`)
  }
  return { fetchImpl, seen }
}

async function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aave-forum-test-'))
  try {
    await fn(join(dir, 'snapshot.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('captures broad listing metadata and append-only first-seen/changed post versions', async () =>
  withTemp(async (out) => {
    const one = mockFetch()
    const first = await collect({
      out,
      fetchImpl: one.fetchImpl,
      now: fixedNow,
      checkDisk: () => {},
    })
    assert.equal(first.run.status, 'complete-listing-title-filter-partial')
    assert.equal(first.postSnapshotsAdded, 1)
    const saved = readCheckpoint(out)
    assert.equal(saved.listingPages.length, 2)
    assert.equal(
      saved.listingPages[0].listing.topic_list.topics[1].title,
      'Unrelated social thread',
    )
    assert.equal(saved.listingPages[0].httpDate, 'Fri, 25 Sep 2026 19:00:00 GMT')
    assert.equal(saved.postSnapshots[0].fetchedAt, '2026-09-25T19:00:00.000Z')
    assert.equal(saved.postSnapshots[0].createdAt, '2026-09-20T00:00:00Z')
    assert.equal(
      saved.postSnapshots[0].rawSha256,
      createHash('sha256').update(saved.postSnapshots[0].raw).digest('hex'),
    )
    assert.ok(one.seen.includes('/posts/101.json'))
    assert.ok(!one.seen.includes('/t/11.json'))

    const unchanged = await collect({
      out,
      fetchImpl: mockFetch().fetchImpl,
      now: fixedNow,
      checkDisk: () => {},
    })
    assert.equal(unchanged.postSnapshotsAdded, 0)
    const changed = await collect({
      out,
      fetchImpl: mockFetch({ raw: 'Borrow cap: 100m to 130m', version: 2 }).fetchImpl,
      now: fixedNow,
      checkDisk: () => {},
    })
    assert.equal(changed.postSnapshotsAdded, 1)
    const final = readCheckpoint(out)
    assert.equal(final.postSnapshots.length, 2)
    assert.equal(final.postSnapshots[0].raw, 'Borrow cap: 100m to 120m')
    assert.equal(final.postSnapshots[1].raw, 'Borrow cap: 100m to 130m')
    assert.equal(final.postSnapshots[1].version, 2)
  }))

test('revisits an older matched topic after it falls off newest listing pages', async () =>
  withTemp(async (out) => {
    let runNumber = 0
    const seen = []
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname
      seen.push([runNumber, path])
      if (path === '/categories.json') return ok(categoryList)
      if (path === '/c/risk/7.json')
        return ok(
          listing(
            runNumber === 1
              ? [topic(10, 'Risk Steward cap recommendation')]
              : [topic(20, 'Unrelated new discussion')],
          ),
        )
      if (path === '/c/governance/4.json') return ok(listing([]))
      if (path === '/t/10.json')
        return ok({ id: 10, post_stream: { posts: [{ id: 101, post_number: 1 }] } })
      if (path === '/posts/101.json')
        return ok({
          id: 101,
          topic_id: 10,
          post_number: 1,
          version: runNumber,
          raw: `Borrow cap: ${runNumber === 1 ? '120m' : '130m'}`,
        })
      throw new Error(`Unexpected URL ${url}`)
    }
    runNumber = 1
    await collect({ out, fetchImpl, now: fixedNow, checkDisk: () => {} })
    runNumber = 2
    const second = await collect({ out, fetchImpl, now: fixedNow, checkDisk: () => {} })
    assert.equal(second.run.postCoverage.previouslyMatched, 1)
    assert.equal(second.run.postCoverage.newlyMatched, 0)
    assert.equal(second.run.postCoverage.attempted, 1)
    assert.equal(second.run.postCoverage.deferred, 0)
    assert.deepEqual(second.run.postAttempts, [10])
    assert.equal(seen.filter(([run, path]) => run === 2 && path === '/t/10.json').length, 1)
    assert.equal(seen.filter(([run, path]) => run === 2 && path === '/posts/101.json').length, 1)
    assert.deepEqual(
      readCheckpoint(out).postSnapshots.map((post) => [post.version, post.raw]),
      [
        [1, 'Borrow cap: 120m'],
        [2, 'Borrow cap: 130m'],
      ],
    )
  }))

test('retries previously discovered titles left unfetched by a post cap, with explicit deferrals', async () =>
  withTemp(async (out) => {
    const seen = []
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname
      seen.push(path)
      if (path === '/categories.json') return ok(categoryList)
      if (path === '/c/risk/7.json')
        return ok(listing([topic(10, 'Borrow cap change'), topic(20, 'Supply cap change')]))
      if (path === '/c/governance/4.json') return ok(listing([]))
      const match = /^\/t\/(10|20)\.json$/.exec(path)
      if (match)
        return ok({
          id: Number(match[1]),
          post_stream: { posts: [{ id: Number(match[1]) + 100, post_number: 1 }] },
        })
      const post = /^\/posts\/(110|120)\.json$/.exec(path)
      if (post)
        return ok({
          id: Number(post[1]),
          topic_id: Number(post[1]) - 100,
          post_number: 1,
          version: 1,
          raw: 'Cap change',
        })
      throw new Error(`Unexpected URL ${url}`)
    }
    const first = await collect({
      out,
      fetchImpl,
      now: fixedNow,
      checkDisk: () => {},
      posts: 1,
    })
    assert.equal(first.run.status, 'partial')
    assert.equal(first.run.postCoverage.deferred, 1)
    assert.deepEqual(first.run.postAttempts, [10])
    seen.length = 0
    const second = await collect({
      out,
      fetchImpl,
      now: fixedNow,
      checkDisk: () => {},
      posts: 1,
    })
    assert.equal(second.run.postCoverage.previouslyMatched, 2)
    assert.equal(second.run.postCoverage.deferred, 1)
    assert.deepEqual(second.run.postAttempts, [20])
    assert.equal(seen.filter((path) => path === '/t/20.json').length, 1)
    assert.equal(readCheckpoint(out).postSnapshots.length, 2)
  }))

test('a newly listed recommendation is not starved by previously visited topics', async () =>
  withTemp(async (out) => {
    let round = 1
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname
      if (path === '/categories.json') return ok(categoryList)
      if (path === '/c/risk/7.json')
        return ok(
          listing([
            topic(10, 'Borrow cap change'),
            topic(20, 'Supply cap change'),
            ...(round === 2 ? [topic(30, 'Risk Steward new recommendation')] : []),
          ]),
        )
      if (path === '/c/governance/4.json') return ok(listing([]))
      const topicMatch = /^\/t\/(10|20|30)\.json$/.exec(path)
      if (topicMatch)
        return ok({
          id: Number(topicMatch[1]),
          post_stream: { posts: [{ id: Number(topicMatch[1]) + 100, post_number: 1 }] },
        })
      const postMatch = /^\/posts\/(110|120|130)\.json$/.exec(path)
      if (postMatch)
        return ok({
          id: Number(postMatch[1]),
          topic_id: Number(postMatch[1]) - 100,
          post_number: 1,
          version: 1,
          raw: 'Prospective recommendation',
        })
      throw new Error(`Unexpected URL ${url}`)
    }
    await collect({ out, fetchImpl, now: fixedNow, checkDisk: () => {}, posts: 2 })
    round = 2
    const second = await collect({ out, fetchImpl, now: fixedNow, checkDisk: () => {}, posts: 1 })
    assert.deepEqual(second.run.postAttempts, [30])
    assert.equal(second.run.postCoverage.newlyMatched, 1)
    assert.equal(second.run.postCoverage.deferred, 2)
  }))

test('records incomplete page cap and post failures without claiming complete coverage', async () =>
  withTemp(async (out) => {
    const { fetchImpl } = mockFetch({ more: '/c/risk/7?page=1', failPost: true })
    const result = await collect({
      out,
      fetchImpl,
      now: fixedNow,
      checkDisk: () => {},
      pagesPerCategory: 1,
    })
    assert.equal(result.run.status, 'partial')
    assert.equal(result.run.categoryCoverage[0].reason, 'page cap')
    assert.equal(result.run.errors[0].stage, 'post')
    assert.equal(readCheckpoint(out).postSnapshots.length, 0)
  }))

test('reports HTTP 429 Retry-After without unbounded retries or false snapshots', async () =>
  withTemp(async (out) => {
    const base = mockFetch().fetchImpl
    let postRequests = 0
    const fetchImpl = (url, options) => {
      if (new URL(url).pathname === '/posts/101.json') {
        postRequests++
        return Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '60' } }))
      }
      return base(url, options)
    }
    const result = await collect({ out, fetchImpl, now: fixedNow, checkDisk: () => {} })
    assert.equal(result.run.status, 'partial')
    assert.equal(postRequests, 1)
    assert.match(result.run.errors[0].error, /HTTP 429.*Retry-After 60.*not automatically retried/)
    assert.equal(readCheckpoint(out).postSnapshots.length, 0)
  }))

test('pagination cannot silently cross into another category path', async () =>
  withTemp(async (out) => {
    const result = await collect({
      out,
      fetchImpl: mockFetch({ more: '/c/risk/77?page=1' }).fetchImpl,
      now: fixedNow,
      checkDisk: () => {},
    })
    assert.equal(result.run.status, 'partial')
    assert.match(result.run.errors[0].error, /Invalid category pagination URL/)
  }))

test('missing pagination terminator is partial, not complete coverage', async () =>
  withTemp(async (out) => {
    const base = mockFetch().fetchImpl
    const fetchImpl = (url, options) =>
      new URL(url).pathname === '/c/risk/7.json'
        ? Promise.resolve(ok({ topic_list: { topics: [topic(10, 'Borrow cap change')] } }))
        : base(url, options)
    const result = await collect({ out, fetchImpl, now: fixedNow, checkDisk: () => {} })
    assert.equal(result.run.status, 'partial')
    assert.equal(result.run.categoryCoverage[0].reason, 'missing pagination terminator')
  }))

test('exclusive lock prevents simultaneous runs overwriting snapshots', async () =>
  withTemp(async (out) => {
    let releaseFetch
    let enteredFetch
    const waiting = new Promise((resolve) => {
      releaseFetch = resolve
    })
    const entered = new Promise((resolve) => {
      enteredFetch = resolve
    })
    const base = mockFetch().fetchImpl
    const fetchImpl = async (url, options) => {
      if (new URL(url).pathname === '/categories.json') {
        enteredFetch()
        await waiting
      }
      return base(url, options)
    }
    const first = collect({ out, fetchImpl, now: fixedNow, checkDisk: () => {} })
    await entered
    await assert.rejects(
      collect({ out, fetchImpl: base, now: fixedNow, checkDisk: () => {} }),
      /EEXIST/,
    )
    releaseFetch()
    await first
    assert.equal(readCheckpoint(out).runs.length, 1)
  }))

test('clock skew cannot backdate a prospective content snapshot', async () =>
  withTemp(async (out) => {
    const result = await collect({
      out,
      fetchImpl: mockFetch().fetchImpl,
      now: () => new Date('2026-09-25T18:00:00Z'),
      checkDisk: () => {},
    })
    assert.equal(result.run.status, 'partial')
    assert.match(result.run.errors[0].error, /Untrusted forum evidence time/)
    assert.equal(readCheckpoint(out).postSnapshots.length, 0)
  }))

test('hard response-byte budget is fail-closed and checkpoint remains sealed', async () =>
  withTemp(async (out) => {
    const result = await collect({
      out,
      fetchImpl: mockFetch().fetchImpl,
      now: fixedNow,
      checkDisk: () => {},
      responseBytes: 20,
    })
    assert.equal(result.run.status, 'partial')
    assert.match(result.run.errors[0].error, /byte budget|byte cap/)
    assert.equal(readCheckpoint(out).runs.length, 1)
  }))

test('tampering with a snapshot fails SHA verification', async () =>
  withTemp(async (out) => {
    await collect({ out, fetchImpl: mockFetch().fetchImpl, now: fixedNow, checkDisk: () => {} })
    const envelope = JSON.parse(readFileSync(out, 'utf8'))
    envelope.payload.postSnapshots[0].raw = 'altered'
    writeFileSync(out, JSON.stringify(envelope))
    assert.throws(() => readCheckpoint(out), /SHA mismatch/)
    assert.notEqual(envelope.sha256, digest(envelope.payload))
  }))

test('title matching covers cap and steward language but does not pretend to be a full-text census', () => {
  assert.equal(matchingTitle('Risk Stewards: supply and borrow cap increases'), true)
  assert.equal(matchingTitle('Weekly risk recommendations'), true)
  assert.equal(matchingTitle('Community social'), false)
})

test('fetch evidence time is captured after the response arrives', async () =>
  withTemp(async (out) => {
    let delivered = false
    const base = mockFetch()
    const fetchImpl = async (url, options) => {
      const response = await base.fetchImpl(url, options)
      delivered = true
      return response
    }
    const now = () => new Date(delivered ? '2026-09-25T19:01:00Z' : '2026-09-25T19:00:00Z')
    await collect({ out, fetchImpl, now, checkDisk: () => {} })
    const checkpoint = readCheckpoint(out)
    assert.equal(checkpoint.runs[0].startedAt, '2026-09-25T19:00:00.000Z')
    assert.equal(checkpoint.categorySnapshots[0].fetchedAt, '2026-09-25T19:01:00.000Z')
  }))
