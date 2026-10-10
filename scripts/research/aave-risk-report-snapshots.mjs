// Prospective Aave forum evidence capture. Never polls or writes without --run.
// A Discourse created_at is not evidence that today's editable wording existed then.
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ORIGIN = 'https://governance.aave.com'
export const DEFAULT_OUT = resolve('data/research/venue-signals/aave-risk-report-snapshots-v1.json')
// Unlike the multi-year archive scan, one bounded forum poll writes at most 12 MB.
export const DISK_FLOOR_BYTES = 1 * 1024 ** 3
export const HARD_LIMITS = Object.freeze({
  pagesPerCategory: 8,
  topics: 400,
  posts: 120,
  responseBytes: 1_000_000,
  totalBytes: 12_000_000,
})
export const CATEGORIES = Object.freeze([
  { id: 7, slug: 'risk', name: 'Risk' },
  { id: 4, slug: 'governance', name: 'Governance' },
])
const STUDY = 'aave-prospective-risk-report-snapshots-v1'
const MATCH =
  /(?:cap(?:s|acity)?|risk[\s-]*steward|steward|risk[\s-]*report|risk[\s-]*oracle|risk[\s-]*recommend|parameter|liquidity|borrow|supply|offboard|onboard)/i
const sha = (value) => createHash('sha256').update(value).digest('hex')
export const digest = (value) => sha(JSON.stringify(value))
const seal = (payload) => ({ payload, sha256: digest(payload) })
const initial = () => ({
  study: STUDY,
  origin: ORIGIN,
  categories: CATEGORIES,
  runs: [],
  categorySnapshots: [],
  listingPages: [],
  postSnapshots: [],
})

export function readCheckpoint(path) {
  if (!existsSync(path)) return initial()
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  if (!saved?.payload || saved.sha256 !== digest(saved.payload))
    throw new Error('Forum checkpoint SHA mismatch')
  const data = saved.payload
  if (
    data.study !== STUDY ||
    data.origin !== ORIGIN ||
    !Array.isArray(data.runs) ||
    !Array.isArray(data.categorySnapshots) ||
    !Array.isArray(data.listingPages) ||
    !Array.isArray(data.postSnapshots)
  )
    throw new Error('Forum checkpoint identity mismatch')
  return data
}

export function diskGuard(path) {
  let dir = dirname(resolve(path))
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('No output ancestor')
    dir = parent
  }
  const stat = statfsSync(dir)
  if (stat.bavail * stat.bsize < DISK_FLOOR_BYTES) throw new Error('Disk reserve below 1 GiB')
}

function save(path, payload, checkDisk) {
  checkDisk(path)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(seal(payload)), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    // Do not remove or alter the previous sealed checkpoint on a failed write.
    throw error
  }
}

function cappedUrl(value, category) {
  const url = new URL(value, ORIGIN)
  const base = `/c/${category.slug}/${category.id}`
  if (url.origin !== ORIGIN || ![base, `${base}.json`].includes(url.pathname))
    throw new Error('Invalid category pagination URL')
  if (!url.pathname.endsWith('.json')) url.pathname += '.json'
  return url.toString()
}

async function boundedJson(fetchImpl, url, budget, checkDisk, out, now) {
  checkDisk(out)
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
  })
  const httpDate = response.headers?.get('date') ?? null
  if (!response.ok) {
    const retryAfter = response.status === 429 ? response.headers?.get('retry-after') : null
    throw new Error(
      `HTTP ${response.status} at ${new URL(url).pathname}` +
        (retryAfter ? `; Retry-After ${retryAfter} (not automatically retried)` : ''),
    )
  }
  const contentLength = Number(response.headers?.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > budget.responseBytes)
    throw new Error('Response Content-Length exceeds byte cap')
  let bytes
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > budget.responseBytes || budget.usedBytes + size > budget.totalBytes) {
        await reader.cancel()
        throw new Error('Response exceeds byte budget')
      }
      chunks.push(value)
    }
    bytes = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      size,
    )
  } else {
    bytes = Buffer.from(await response.arrayBuffer())
    if (
      bytes.byteLength > budget.responseBytes ||
      budget.usedBytes + bytes.byteLength > budget.totalBytes
    )
      throw new Error('Response exceeds byte budget')
  }
  budget.usedBytes += bytes.byteLength
  const rawResponseSha256 = sha(bytes)
  const fetchedAt = now().toISOString()
  const fetchedMs = Date.parse(fetchedAt)
  const serverMs = httpDate === null ? NaN : Date.parse(httpDate)
  if (
    !Number.isFinite(serverMs) ||
    Math.abs(fetchedMs - serverMs) > 5 * 60_000 ||
    fetchedMs < budget.lastFetchedMs
  )
    throw new Error('Untrusted forum evidence time: clock skew or rollback')
  budget.lastFetchedMs = fetchedMs
  return {
    value: JSON.parse(bytes.toString('utf8')),
    fetchedAt,
    httpDate,
    responseBytes: bytes.byteLength,
    rawResponseSha256,
    url,
  }
}

function firstPostId(topic) {
  const posts = topic?.post_stream?.posts
  const first = Array.isArray(posts) ? posts.find((post) => post.post_number === 1) : null
  const fallback = topic?.post_stream?.stream?.[0]
  const id = first?.id ?? fallback
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Topic has no valid first-post ID')
  return id
}

function normalizePost(topicId, post, fetched) {
  if (
    post?.topic_id !== topicId ||
    post?.post_number !== 1 ||
    !Number.isSafeInteger(post.id) ||
    post.id < 1 ||
    !Number.isSafeInteger(post.version) ||
    post.version < 1 ||
    typeof post.raw !== 'string'
  )
    throw new Error('Invalid first-post payload')
  return {
    topicId,
    postId: post.id,
    version: post.version,
    createdAt: post.created_at ?? null,
    updatedAt: post.updated_at ?? null,
    fetchedAt: fetched.fetchedAt,
    httpDate: fetched.httpDate,
    rawSha256: sha(post.raw),
    raw: post.raw,
    responseSha256: fetched.rawResponseSha256,
  }
}

export function matchingTitle(title) {
  return typeof title === 'string' && MATCH.test(title)
}

// A current listing is only a discovery window. A previously matched title remains
// eligible even if its topic has since fallen off every newly fetched page.
function historicalMatches(data) {
  const matches = new Map()
  for (const page of data.listingPages) {
    for (const topic of page.listing?.topic_list?.topics ?? []) {
      if (Number.isSafeInteger(topic?.id) && topic.id > 0 && matchingTitle(topic.title))
        matches.set(topic.id, {
          id: topic.id,
          title: topic.title,
          categoryId: page.categoryId,
        })
    }
  }
  // Old checkpoints may contain a post even if their listing entry was lost.
  for (const post of data.postSnapshots) {
    if (!matches.has(post.topicId) && matchingTitle(post.titleAtFetch))
      matches.set(post.topicId, {
        id: post.topicId,
        title: post.titleAtFetch,
        categoryId: post.categoryIdAtFetch,
      })
  }
  return matches
}

function orderedPostQueue(data, priorMatched, currentMatched) {
  const latestAttempt = new Map()
  data.runs.forEach((run, index) => {
    for (const topicId of run.postAttempts ?? []) latestAttempt.set(topicId, index)
  })
  const queue = new Map(priorMatched)
  for (const [id, topic] of currentMatched) queue.set(id, topic)
  return [...queue.values()].sort((a, b) => {
    // Oldest (or never) attempted first. Prior-first sorting would starve new
    // recommendations once the historical queue fills the per-run post cap.
    const aAttempt = latestAttempt.get(a.id) ?? -1
    const bAttempt = latestAttempt.get(b.id) ?? -1
    return aAttempt - bAttempt || a.id - b.id
  })
}

function runLimits(options) {
  const limits = {}
  for (const [key, max] of Object.entries(HARD_LIMITS)) {
    const value = options[key] ?? max
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${key}; maximum ${max}`)
    limits[key] = value
  }
  return limits
}

async function collectUnlocked({
  out = DEFAULT_OUT,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  checkDisk = diskGuard,
  ...options
} = {}) {
  const limits = runLimits(options)
  const data = readCheckpoint(out)
  const priorMatched = historicalMatches(data)
  const runId = `${now().toISOString()}-${data.runs.length + 1}`
  const run = {
    id: runId,
    startedAt: now().toISOString(),
    finishedAt: null,
    status: 'partial',
    limits,
    usedBytes: 0,
    topicsSeen: 0,
    postFetches: 0,
    postAttempts: [],
    postCoverage: {
      previouslyMatched: priorMatched.size,
      newlyMatched: 0,
      eligible: priorMatched.size,
      attempted: 0,
      deferred: 0,
    },
    categoryCoverage: [],
    errors: [],
  }
  data.runs.push(run)
  const priorTimes = [
    ...data.runs.map((item) => item.finishedAt),
    ...data.postSnapshots.map((item) => item.fetchedAt),
    ...data.listingPages.map((item) => item.fetchedAt),
  ]
  const budget = {
    ...limits,
    usedBytes: 0,
    lastFetchedMs: Math.max(0, ...priorTimes.map((value) => Date.parse(value) || 0)),
  }
  const seenTopics = new Set()
  const matched = new Map()
  const persist = () => {
    run.usedBytes = budget.usedBytes
    save(out, data, checkDisk)
  }
  persist()
  try {
    const categories = await boundedJson(
      fetchImpl,
      `${ORIGIN}/categories.json`,
      budget,
      checkDisk,
      out,
      now,
    )
    data.categorySnapshots.push({ runId, ...categories })
    persist()
    const returned = categories.value?.category_list?.categories
    if (
      !Array.isArray(returned) ||
      CATEGORIES.some((category) => !returned.some((item) => item.id === category.id))
    )
      throw new Error('Category taxonomy missing Risk or Governance')
    for (const category of CATEGORIES) {
      const coverage = {
        categoryId: category.id,
        pagesFetched: 0,
        topicsSeen: 0,
        nextUrl: `${ORIGIN}/c/${category.slug}/${category.id}.json`,
        complete: false,
        reason: null,
      }
      run.categoryCoverage.push(coverage)
      persist()
      const seenUrls = new Set()
      while (coverage.nextUrl) {
        if (coverage.pagesFetched >= limits.pagesPerCategory) {
          coverage.reason = 'page cap'
          break
        }
        if (seenTopics.size >= limits.topics) {
          coverage.reason = 'topic cap'
          break
        }
        const url = cappedUrl(coverage.nextUrl, category)
        if (seenUrls.has(url)) {
          coverage.reason = 'pagination loop'
          break
        }
        seenUrls.add(url)
        let page
        try {
          page = await boundedJson(fetchImpl, url, budget, checkDisk, out, now)
        } catch (error) {
          coverage.reason = `fetch error: ${error.message}`
          run.errors.push({ stage: 'listing', categoryId: category.id, url, error: error.message })
          break
        }
        const topics = page.value?.topic_list?.topics
        if (!Array.isArray(topics)) {
          coverage.reason = 'invalid topic listing'
          run.errors.push({
            stage: 'listing',
            categoryId: category.id,
            url,
            error: coverage.reason,
          })
          break
        }
        data.listingPages.push({
          runId,
          categoryId: category.id,
          fetchedAt: page.fetchedAt,
          httpDate: page.httpDate,
          url,
          responseBytes: page.responseBytes,
          responseSha256: page.rawResponseSha256,
          listing: page.value,
        })
        coverage.pagesFetched++
        for (const topic of topics) {
          if (!Number.isSafeInteger(topic?.id) || topic.id < 1 || typeof topic.title !== 'string') {
            run.errors.push({
              stage: 'listing-topic',
              categoryId: category.id,
              url,
              error: 'invalid topic ID/title',
            })
            continue
          }
          if (!seenTopics.has(topic.id)) {
            if (seenTopics.size >= limits.topics) {
              coverage.reason = 'topic cap'
              break
            }
            seenTopics.add(topic.id)
            coverage.topicsSeen++
            if (matchingTitle(topic.title))
              matched.set(topic.id, { id: topic.id, title: topic.title, categoryId: category.id })
          }
        }
        run.topicsSeen = seenTopics.size
        if (!Object.hasOwn(page.value.topic_list, 'more_topics_url')) {
          coverage.reason = 'missing pagination terminator'
          run.errors.push({
            stage: 'listing',
            categoryId: category.id,
            url,
            error: coverage.reason,
          })
          persist()
          break
        }
        const more = page.value.topic_list.more_topics_url
        if (more !== null && typeof more !== 'string') {
          coverage.reason = 'invalid pagination URL type'
          run.errors.push({
            stage: 'listing',
            categoryId: category.id,
            url,
            error: coverage.reason,
          })
          persist()
          break
        }
        coverage.nextUrl = more ? cappedUrl(more, category) : null
        if (!coverage.nextUrl && !coverage.reason) coverage.complete = true
        persist()
        if (coverage.reason) break
      }
    }
  } catch (error) {
    run.errors.push({ stage: 'run', error: error.message })
  }
  const queue = orderedPostQueue(data, priorMatched, matched)
  run.postCoverage.newlyMatched = [...matched.keys()].filter((id) => !priorMatched.has(id)).length
  run.postCoverage.eligible = queue.length
  for (const topic of queue) {
    if (run.postFetches >= limits.posts) {
      run.errors.push({
        stage: 'posts',
        error: 'post cap',
        remaining: queue.length - run.postFetches,
      })
      break
    }
    run.postAttempts.push(topic.id)
    run.postFetches++
    run.postCoverage.attempted = run.postFetches
    persist()
    try {
      const topicResult = await boundedJson(
        fetchImpl,
        `${ORIGIN}/t/${topic.id}.json`,
        budget,
        checkDisk,
        out,
        now,
      )
      const postId = firstPostId(topicResult.value)
      const postResult = await boundedJson(
        fetchImpl,
        `${ORIGIN}/posts/${postId}.json`,
        budget,
        checkDisk,
        out,
        now,
      )
      const snapshot = normalizePost(topic.id, postResult.value, postResult)
      const prior = data.postSnapshots.findLast(
        (entry) => entry.topicId === topic.id && entry.postId === postId,
      )
      if (!prior || prior.version !== snapshot.version || prior.rawSha256 !== snapshot.rawSha256)
        data.postSnapshots.push({
          runId,
          ...snapshot,
          titleAtFetch: topic.title,
          categoryIdAtFetch: topic.categoryId,
        })
    } catch (error) {
      run.errors.push({ stage: 'post', topicId: topic.id, error: error.message })
    }
    persist()
  }
  run.postCoverage.deferred = queue.length - run.postFetches
  run.finishedAt = now().toISOString()
  run.status =
    run.errors.length === 0 &&
    run.categoryCoverage.length === CATEGORIES.length &&
    run.categoryCoverage.every((entry) => entry.complete)
      ? 'complete-listing-title-filter-partial'
      : 'partial'
  persist()
  return {
    run,
    postSnapshotsAdded: data.postSnapshots.filter((item) => item.runId === runId).length,
    out,
  }
}

export async function collect(options = {}) {
  const out = resolve(options.out ?? DEFAULT_OUT)
  const checkDisk = options.checkDisk ?? diskGuard
  checkDisk(out)
  mkdirSync(dirname(out), { recursive: true })
  const lockPath = `${out}.lock`
  const lock = openSync(lockPath, 'wx', 0o600)
  try {
    return await collectUnlocked({ ...options, out, checkDisk })
  } finally {
    closeSync(lock)
    unlinkSync(lockPath)
  }
}

function parseArgs(argv) {
  const args = { run: false }
  const names = new Map([
    ['--max-pages', 'pagesPerCategory'],
    ['--max-topics', 'topics'],
    ['--max-posts', 'posts'],
    ['--max-response-bytes', 'responseBytes'],
    ['--max-total-bytes', 'totalBytes'],
  ])
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--run') args.run = true
    else if (token === '--out') args.out = argv[++i]
    else if (names.has(token)) args[names.get(token)] = Number(argv[++i])
    else throw new Error(`Unknown argument: ${token}`)
  }
  return args
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.run) {
    console.log('Dry by default. Pass --run for a bounded public Aave Discourse snapshot.')
  } else {
    collect(args)
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        console.error(error)
        process.exitCode = 1
      })
  }
}
