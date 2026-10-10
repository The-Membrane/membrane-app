// Offline extraction of explicit Aave optimal-utilization recommendations.
// First local fetch time is the earliest supported evidence time; never created_at.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { DEFAULT_OUT, readCheckpoint } from './aave-risk-report-snapshots.mjs'

const clean = (value) =>
  String(value ?? '')
    .trim()
    .replaceAll('\\.', '.')
const cells = (line) =>
  line.trim().startsWith('|') && line.trim().endsWith('|')
    ? line.trim().slice(1, -1).split('|').map(clean)
    : null
const percent = (value) => {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(clean(value))
  if (!match) return null
  const number = Number(match[1])
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null
}
const header = (row) =>
  row?.length === 4 &&
  row[0].toLowerCase() === 'instance' &&
  row[1].toLowerCase() === 'asset' &&
  /^current optimal (?:utili[sz]ation|usage ratio)$/.test(row[2].toLowerCase()) &&
  /^recommended optimal (?:utili[sz]ation|usage ratio)$/.test(row[3].toLowerCase())
const separator = (row) => row?.length === 4 && row.every((cell) => /^:?-{2,}:?$/.test(cell))

export function extractRows(raw) {
  const lines = String(raw ?? '').split(/\r?\n/)
  const rows = []
  for (let i = 0; i < lines.length - 2; i++) {
    if (!header(cells(lines[i])) || !separator(cells(lines[i + 1]))) continue
    for (let j = i + 2; j < lines.length; j++) {
      const row = cells(lines[j])
      if (!row) break
      if (row.length !== 4) {
        rows.push({ kind: 'ambiguous', reason: 'wrong column count', line: j + 1 })
        continue
      }
      const [instance, asset, oldText, newText] = row
      const oldPct = percent(oldText)
      const newPct = percent(newText)
      if (
        !/^Aave V3 [A-Za-z][A-Za-z0-9 -]*$/.test(instance) ||
        !/^[A-Za-z][A-Za-z0-9-]*$/.test(asset) ||
        oldPct === null ||
        newPct === null
      ) {
        rows.push({ kind: 'ambiguous', reason: 'invalid identity or percent', line: j + 1 })
        continue
      }
      rows.push({
        kind: 'recommendation',
        instance,
        asset,
        oldPct,
        newPct,
        changePp: Number((newPct - oldPct).toFixed(4)),
        direction: newPct > oldPct ? 'up' : newPct < oldPct ? 'down' : 'unchanged',
        line: j + 1,
      })
    }
  }
  const byKey = new Map()
  for (const row of rows) {
    if (row.kind !== 'recommendation') continue
    const key = `${row.instance.toLowerCase()}:${row.asset.toLowerCase()}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(row)
  }
  for (const group of byKey.values()) {
    if (new Set(group.map((row) => `${row.oldPct}:${row.newPct}`)).size <= 1) continue
    for (const row of group) {
      row.kind = 'ambiguous'
      row.reason = 'conflicting rows for one instance/asset'
    }
  }
  return rows
}

export function extractIntents(checkpoint) {
  if (!Array.isArray(checkpoint?.postSnapshots)) throw new Error('Missing post snapshots')
  return checkpoint.postSnapshots.flatMap((post) =>
    extractRows(post.raw).map((row) => ({
      ...row,
      topicId: post.topicId,
      postId: post.postId,
      version: post.version,
      rawSha256: post.rawSha256,
      firstEvidenceAt: post.fetchedAt,
      forumCreatedAtNotEvidence: post.createdAt,
      concurrentChanges: 'unknown',
    })),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT
  const rows = extractIntents(readCheckpoint(path))
  console.log(
    JSON.stringify({
      status: 'offline-candidate-extraction-not-prediction',
      firstEvidenceRule: 'local fetchedAt only',
      rows,
      counts: {
        up: rows.filter((row) => row.kind === 'recommendation' && row.direction === 'up').length,
        down: rows.filter((row) => row.kind === 'recommendation' && row.direction === 'down')
          .length,
        ambiguous: rows.filter((row) => row.kind === 'ambiguous').length,
      },
    }),
  )
}
