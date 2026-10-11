import type { NextApiRequest, NextApiResponse } from 'next'

import {
  currentReadStatus,
  historicalCarryCashContext,
  withReadOnlyCurrentCash,
} from '@/lib/carry/historicalCashContext'
import type { CarryLiveCurrentCash } from '@/lib/carry/historicalCashContext'
import { readLocalCarryCashObservations } from '@/scripts/lib/localCarryCashStore.mjs'
import { buildSubjectManifest } from '@/scripts/record-carry-cash-issues.mjs'
import { readConfiguredLiveCurrentCash } from '@/scripts/research/carry-live-current-cash.mjs'

const LIVE_CURRENT_READ_DEADLINE_MS = 2_000

async function boundedLiveCurrentCashRead(
  query: { routeKey: string; destination: string },
  manifest: Awaited<ReturnType<typeof buildSubjectManifest>>,
): Promise<CarryLiveCurrentCash> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = readConfiguredLiveCurrentCash(query, { manifest, cache: true }).catch(
    (): CarryLiveCurrentCash => ({ status: 'unavailable', reason: 'live_read_failed' }),
  )
  try {
    return await Promise.race([
      read,
      new Promise<CarryLiveCurrentCash>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: 'unavailable', reason: 'live_read_timeout' }),
          LIVE_CURRENT_READ_DEADLINE_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const isLocalDevelopment = (req: NextApiRequest) =>
  process.env.NODE_ENV === 'development' &&
  (req.socket?.remoteAddress === '127.0.0.1' ||
    req.socket?.remoteAddress === '::1' ||
    req.socket?.remoteAddress === '::ffff:127.0.0.1')

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  if (!isLocalDevelopment(req))
    return res.status(503).json({ error: 'local_cash_context_unavailable' })
  const { routeKey, destination } = req.query
  if (
    typeof routeKey !== 'string' ||
    routeKey.length > 200 ||
    typeof destination !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(destination)
  )
    return res.status(400).json({ error: 'invalid_subject' })
  const includeLiveCurrent = req.query.includeLiveCurrent === '1'
  try {
    const manifest = await buildSubjectManifest()
    const subject = manifest.subjects.find(
      (row) => row.route_key === routeKey && row.destination === destination.toLowerCase(),
    )
    if (!subject) return res.status(404).json({ error: 'subject_not_tracked' })
    const observations = readLocalCarryCashObservations(manifest)
    const archived = historicalCarryCashContext(observations, subject)
    if (archived.status !== 'historical_context') return res.status(200).json(archived)
    if (!includeLiveCurrent) return res.status(200).json(archived)
    if (archived.current?.freshness === 'fresh') return res.status(200).json(archived)
    try {
      const live = await boundedLiveCurrentCashRead(
        { routeKey, destination: subject.destination },
        manifest,
      )
      const current = withReadOnlyCurrentCash(archived, subject, live)
      return res.status(200).json({
        ...current,
        currentRead: currentReadStatus(archived, current, live),
      })
    } catch {
      return res.status(200).json({
        ...archived,
        currentRead: { status: 'unavailable', reason: 'live_read_failed' },
      })
    }
  } catch {
    return res.status(503).json({ error: 'cash_context_unavailable' })
  }
}
