// build-i3-record.mjs — the historical record of the oracle-gap indicator (Q25 T2, I3) as a
// small aggregate the public app may keep (board rule N18: "aggregate results that a doc
// cites, and files that a live page must serve").
//
//   node scripts/curator-feed/build-i3-record.mjs          write lib/curatorFeed/i3Record.generated.json
//   node scripts/curator-feed/build-i3-record.mjs --check  exit 1 when the committed file differs
//
// Reads <datasets>/validation/t2/results.json ($MEMBRANE_DATASETS_DIR or ../membrane-datasets,
// scripts/lib/datasetsDir.mjs) and copies, never recomputes, what T2 measured for I3:
// constants, per incident × asset status / first fire / lead / calm fires, the pass line and
// the verdict. The sha256 of results.json is computed here and must equal its row in
// validation/t2/PROVENANCE.md, else the build fails. The one fact taken from a CSV is
// AZND's oracle answer (AZND-I3.csv, also hashed against PROVENANCE.md): T2 records that it
// had one distinct answer (checks.AZND.oracleDistinctAnswers) but not its value.
//
// Words that are not in results.json, kept here with their source:
//   lane       'Q25'                    membrane-board design/VALIDATION_PREREG.md, title
//   T0 events  write-off / crash        same file, "T2.1 Incidents and loss time T0"

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { datasetsDir } from '../lib/datasetsDir.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const OUT = join(ROOT, 'lib', 'curatorFeed', 'i3Record.generated.json')
export const RESULTS = 'validation/t2/results.json'
const PROVENANCE = 'validation/t2/PROVENANCE.md'

const LANE = 'Q25'
/** What happened at each incident's T0 (prereg T2.1). */
const T0_EVENT = {
  'sdeUSD 2025': 'write-off',
  'msY/AZND 2026': 'write-off',
  'Oct 10 2025': 'crash',
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** sha256 of `file` as listed in a PROVENANCE.md table (`| \`file\` | bytes | \`sha\` |`). */
function provenanceSha(provenance, file) {
  const row = provenance.split('\n').find((l) => l.startsWith(`| \`${file}\` |`))
  const m = row?.match(/\|\s*`([0-9a-f]{64})`\s*\|\s*$/)
  if (!m) throw new Error(`${PROVENANCE}: no sha256 row for ${file}`)
  return m[1]
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

/** Distinct oracle answers over the observed rows of an I3 CSV (column `oracle_usdc`). */
function csvOracleAnswers(text) {
  const [head, ...rows] = text.trim().split(/\r?\n/)
  const cols = head.split(',')
  const iObs = cols.indexOf('observed')
  const iOr = cols.indexOf('oracle_usdc')
  if (iObs < 0 || iOr < 0) throw new Error('I3 csv: missing observed / oracle_usdc columns')
  return [
    ...new Set(
      rows
        .map((r) => r.split(','))
        .filter((c) => c[iObs] === '1')
        .map((c) => Number(c[iOr])),
    ),
  ]
}

/**
 * The record, without `generatedAt` (the only field that changes when nothing else does).
 * Throws when an input is missing or does not match its provenance row.
 */
export function buildI3Record(dir = datasetsDir(ROOT)) {
  const resultsBuf = readFileSync(join(dir, RESULTS))
  const provenance = readFileSync(join(dir, PROVENANCE), 'utf8')
  const sha = sha256(resultsBuf)
  const listed = provenanceSha(provenance, 'results.json')
  if (sha !== listed) throw new Error(`${RESULTS}: sha256 ${sha} ≠ ${PROVENANCE} row ${listed}`)
  const r = JSON.parse(resultsBuf.toString('utf8'))
  const c = r.constants
  if (typeof c?.I3Gap !== 'number' || typeof c?.I3Persistence?.hourly !== 'number')
    throw new Error(`${RESULTS}: constants.I3Gap / I3Persistence missing`)

  const incidents = []
  for (const [incident, assets] of Object.entries(r.incidents)) {
    const event = T0_EVENT[incident]
    if (!event) throw new Error(`no T0 event word for incident "${incident}" (prereg T2.1)`)
    for (const [asset, x] of Object.entries(assets)) {
      const i3 = x?.I3
      if (!i3) continue
      const row = {
        incident,
        asset,
        T0: i3.T0,
        event,
        status: i3.status,
        firstFire: i3.firstFire ?? null,
        leadDays: i3.leadDays ?? null,
        warned9d: Boolean(i3.warned9d),
        calmDays: i3.calmDays,
        calmEpisodeStarts: i3.calmEpisodeStarts,
        falseFireRatePerQuarter: i3.falseFireRatePerQuarter,
        /** Start of each episode that began in the calm period (a false alarm). */
        calmFireStarts: (i3.episodes ?? []).filter((e) => e.startsInCalm).map((e) => e.start),
        inputs: i3.inputs ?? i3.reason,
      }
      const checks = r.checks?.[asset]
      if (checks?.oracleDistinctAnswers === 1) {
        const csv = `validation/t2/${asset}-I3.csv`
        const buf = readFileSync(join(dir, csv))
        const csvSha = sha256(buf)
        if (csvSha !== provenanceSha(provenance, `${asset}-I3.csv`))
          throw new Error(`${csv}: sha256 does not match ${PROVENANCE}`)
        const answers = csvOracleAnswers(buf.toString('utf8'))
        if (answers.length !== 1)
          throw new Error(`${csv}: ${answers.length} oracle answers, T2 says 1`)
        // D5: price() / 1e24 = USDC per collateral token (1 USDC taken as $1).
        row.oracleFixed = { value: answers[0], unit: 'USDC', csv, sha256: csvSha }
      }
      incidents.push(row)
    }
  }
  const p = r.passLine?.indicators?.I3
  if (!p) throw new Error(`${RESULTS}: passLine.indicators.I3 missing`)
  return {
    indicator: 'I3',
    name: 'oracle-vs-market gap',
    lane: LANE,
    test: r.test,
    kind: r.kind,
    verdict: r.verdict,
    constants: {
      gap: c.I3Gap,
      persistenceHours: c.I3Persistence.hourly,
      persistenceDailyPoints: c.I3Persistence.dailyPoints,
      warnDays: c.windowDays[1],
      windowDays: c.windowDays[0],
      quarterDays: c.quarterDays,
      minCalmDays: c.minCalmDays,
    },
    incidentCount: Object.keys(r.incidents).length,
    incidents,
    passLine: {
      verdict: r.passLine.verdict,
      incidentsWarned: p.incidentsWarned,
      warnedIncidents: p.warnedIncidents,
      warningCarriers: p.warningCarriers,
      allCarriersFfrOk: p.allCarriersFfrOk,
      byIncident: p.byIncident,
    },
    decisions: (r.decisions ?? [])
      .filter((d) => ['D2', 'D3', 'D5', 'D7', 'D9'].includes(d.id))
      .map((d) => ({ id: d.id, topic: d.topic })),
    source: {
      repo: 'triccs/membrane-datasets',
      // The last commit that changed results.json: stable while unrelated datasets move.
      commit: git(dir, ['log', '-1', '--format=%H', '--', RESULTS]) || null,
      path: RESULTS,
      sha256: sha,
      computedAt: r.computedAt,
      prereg: r.prereg,
    },
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const rec = buildI3Record()
  const text = (obj) => JSON.stringify(obj, null, 2) + '\n'
  if (process.argv.includes('--check')) {
    const cur = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
    const { generatedAt: _g, ...body } = cur ?? {}
    if (text(body) !== text(rec)) {
      console.error(`${OUT} is out of date — run node scripts/curator-feed/build-i3-record.mjs`)
      process.exit(1)
    }
    console.log('i3 record up to date')
  } else {
    writeFileSync(OUT, text({ ...rec, generatedAt: new Date().toISOString() }))
    console.log(
      `wrote ${OUT.slice(ROOT.length + 1)}: ${rec.incidents.length} incident rows, I3 verdict ${rec.passLine.verdict}, results.json ${rec.source.sha256.slice(0, 12)}…`,
    )
  }
}
