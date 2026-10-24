/**
 * Append-only JSONL checkpoint: one line per finished unit of work, keyed. Re-running loads the
 * file and skips every key already present, so a killed run resumes where it stopped. A torn
 * last line (process killed mid-write) is ignored.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { createHash } from 'crypto'

export class JsonlStore<T> {
  readonly map = new Map<string, T>()
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line) continue
        try {
          const { k, v } = JSON.parse(line) as { k: string; v: T }
          this.map.set(k, v)
        } catch {
          /* torn line */
        }
      }
    }
  }
  has(k: string) {
    return this.map.has(k)
  }
  get(k: string) {
    return this.map.get(k)
  }
  put(k: string, v: T) {
    this.map.set(k, v)
    appendFileSync(this.path, JSON.stringify({ k, v }) + '\n')
  }
  /** Rewrite the file from memory (after replacing values). */
  compact() {
    writeFileSync(
      this.path,
      [...this.map].map(([k, v]) => JSON.stringify({ k, v })).join('\n') + '\n',
    )
  }
  get size() {
    return this.map.size
  }
}

/** Small JSON value checkpoint (whole file rewritten). */
export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
export function writeJson(path: string, v: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(v, null, 1))
}

/** Deterministic sample membership: sha256(key) mapped to [0,1). */
export function sampleFrac(key: string): number {
  const h = createHash('sha256').update(key).digest()
  return h.readUInt32BE(0) / 2 ** 32
}

/** Run `fn` over items with at most `n` in flight. */
export async function pmap<T, R>(
  items: T[],
  n: number,
  fn: (x: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

export function progress(label: string) {
  let last = 0
  return (done: number, total: number) => {
    const now = Date.now()
    if (now - last > 30_000 || done === total) {
      last = now
      process.stderr.write(`[${label}] ${done}/${total} ${new Date().toISOString()}\n`)
    }
  }
}
