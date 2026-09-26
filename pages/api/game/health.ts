import type { NextApiRequest, NextApiResponse } from 'next'
import { sql } from 'drizzle-orm'

import { db } from '@/db'

type HealthResult = { ok: true } | { ok: false; error: string }

export default async function handler(req: NextApiRequest, res: NextApiResponse<HealthResult>) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' })
  }

  try {
    await db.execute(sql`select 1`)
    return res.status(200).json({ ok: true })
  } catch {
    // Never leak env values or connection details (host, credentials, driver error
    // text) into the response or logs — just the fact that the db is unreachable.
    return res.status(500).json({ ok: false, error: 'db_unreachable' })
  }
}
