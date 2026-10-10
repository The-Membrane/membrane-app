// Read-only retrospective qualification. Backfilled rows never become prospective receipts.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import projectionModule from '../../lib/carry/historicalCashProjection.ts'
import { readEnv } from '../lib/venue-reads.mjs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { readRows, study } from './carry-cash-backfill-study.mjs'

const { projectHistoricalCash } = projectionModule

export function evaluate(modelStudy, now = new Date().toISOString()) {
  if (
    modelStudy.captureKind !== 'backfilled' ||
    modelStudy.whollyMissingArchiveAnchors !== 0 ||
    modelStudy.missingSubjectAnchorRows !== 0 ||
    modelStudy.subjectCount !== 67
  )
    throw new Error('historical_model_corpus_incomplete')
  const results = []
  for (const subject of modelStudy.subjects) {
    const subjectKey = `${subject.routeKey}\0${subject.destination}`
    for (const horizon of subject.horizons) {
      const pairs = horizon.pairs
      if (!Array.isArray(pairs) || pairs.length !== horizon.counts.independentPairs)
        throw new Error('historical_model_pairs_missing')
      const result = projectHistoricalCash({
        subjectKey,
        horizonHours: horizon.horizonHours,
        currentAt: now,
        currentCashRaw: pairs.at(-1)?.targetCashRaw ?? '0',
        pairs,
      })
      results.push({
        routeKey: subject.routeKey,
        destination: subject.destination,
        horizonHours: horizon.horizonHours,
        status: result.status,
        reason: result.reason,
        counts: result.counts,
        holdout: result.holdout,
        baselineBand: result.baselineBand,
      })
    }
  }
  const summary = [1, 24].map((hours) => {
    const rows = results.filter((result) => result.horizonHours === hours)
    return {
      horizonHours: hours,
      subjects: rows.length,
      historicallyQualified: rows.filter((result) => result.status === 'historical_projection')
        .length,
      insufficientHistory: rows.filter((result) => result.reason === 'insufficient_history').length,
      noSkillOverPersistence: rows.filter((result) => result.reason === 'no_skill_over_persistence')
        .length,
      historicallyCoveredBaselineBands: rows.filter((result) => result.baselineBand?.coveragePassed)
        .length,
    }
  })
  return {
    kind: 'historical_model_qualification_only',
    prospectiveValidated: false,
    holderExecutableExit: false,
    subjectManifestSha256: modelStudy.subjectManifestSha256,
    archiveAnchorCount: modelStudy.archiveAnchorCount,
    summary,
    results,
  }
}

async function main() {
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('database_url_required')
  const manifest = await buildSubjectManifest()
  const corpus = study(await readRows(neon(url)), manifest, { includePairs: true })
  process.stdout.write(JSON.stringify(evaluate(corpus)) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Carry historical model evaluation failed closed.\n')
    process.exitCode = 1
  })
}
