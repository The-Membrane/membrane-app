import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

import { liveDir, seedDir } from '@/lib/curatorFeed/paths'
import { parseExposureFile, parseFeedFile, type ExposureFile, type FeedFile } from '@/lib/curatorFeed/store'

// The curator feed dataset on disk, shared by /api/curator-feed and
// /api/curator-feed/holder. LOCAL-FIRST: .data/curator-feed (the collector's live copy)
// when it holds a feed, else the canonical copy in the private datasets repo. Re-parsed
// only when the file changes.

const dir = (): string => {
  const live = liveDir()
  return existsSync(join(live, 'feed.json')) ? live : seedDir()
}

type Cached<T> = { path: string; mtimeMs: number; value: T }
let feedCache: Cached<FeedFile> | null = null
let exposureCache: Cached<ExposureFile> | null = null

function load<T>(name: string, parse: (raw: unknown) => T, cache: Cached<T> | null): Cached<T> {
  const path = join(dir(), name)
  const { mtimeMs } = statSync(path)
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache
  return { path, mtimeMs, value: parse(JSON.parse(readFileSync(path, 'utf8'))) }
}

export function loadFeedFile(): FeedFile {
  feedCache = load('feed.json', parseFeedFile, feedCache)
  return feedCache.value
}

export function loadExposureFile(): ExposureFile {
  exposureCache = load('exposure.json', parseExposureFile, exposureCache)
  return exposureCache.value
}

/** The 503 body when the dataset cannot be read: the fs code only (the message would carry a server path). */
export const unavailableError = (e: unknown): string =>
  `curator feed dataset unavailable (${(e as NodeJS.ErrnoException).code ?? 'unreadable'}) — run pnpm curators:feed, or clone triccs/membrane-datasets next to the app (or set MEMBRANE_DATASETS_DIR)`
