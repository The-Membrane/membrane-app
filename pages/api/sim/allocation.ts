import type { NextApiRequest, NextApiResponse } from 'next'
import { isAddress, getAddress } from 'viem'
import { sql } from 'drizzle-orm'

import { db } from '@/db'

// LAUNCH ALLOCATION claims — the one ask worth a contact, offered only after a
// real run showed the visitor a bad number.
//
//  POST {address, contact?} — UPSERT sim_allocation. Rank is the address's
//    FIRST sim read (sim_reads.first_seen), never the claim time, so nobody
//    jumps the queue by claiming twice; a claim without a prior read ranks at
//    claim time. Contact is free text (email / telegram / farcaster), ≤120
//    chars, optional — the address alone is a valid contact record on-chain.
//  GET — {claims, capped_at} for the page's honest counter. capped_at comes
//    from SIM_ALLOCATION_CAP; unset = no cap is stated anywhere.
//
// Address + the contact the visitor typed. No IP, no UA, no cookie.

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getSummary(res)
  if (req.method === 'POST') return postClaim(req, res)
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
}

function cap(): number | null {
  const n = Number(process.env.SIM_ALLOCATION_CAP)
  return Number.isFinite(n) && n > 0 ? n : null
}

async function getSummary(res: NextApiResponse) {
  const rows = (await db.execute(sql`SELECT count(*)::int AS claims FROM sim_allocation`)).rows as Array<
    Record<string, unknown>
  >
  res.setHeader('Cache-Control', 'private, max-age=60')
  return res.status(200).json({ claims: Number(rows[0]?.claims ?? 0), capped_at: cap() })
}

async function postClaim(req: NextApiRequest, res: NextApiResponse) {
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body ?? {}
  const addrStr = body?.address
  if (!addrStr || typeof addrStr !== 'string' || !isAddress(addrStr)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  const address = getAddress(addrStr)

  let contact: string | null = null
  if (body.contact != null) {
    if (typeof body.contact !== 'string') return res.status(400).json({ error: 'contact must be a string' })
    const t = body.contact.trim().slice(0, 120)
    contact = t.length > 0 ? t : null
  }

  const rows = (
    await db.execute(sql`
      INSERT INTO sim_allocation (address, contact, ranked_at, created_at)
      VALUES (
        ${address},
        ${contact},
        COALESCE((SELECT first_seen FROM sim_reads WHERE address = ${address}), now()),
        now()
      )
      ON CONFLICT (address) DO UPDATE
        SET contact = COALESCE(EXCLUDED.contact, sim_allocation.contact)
      RETURNING ranked_at,
        (SELECT count(*)::int FROM sim_allocation s WHERE s.ranked_at < sim_allocation.ranked_at) + 1 AS rank`)
  ).rows as Array<Record<string, unknown>>
  const row = rows[0]

  return res.status(200).json({
    address,
    rank: Number(row?.rank ?? 0) || null,
    ranked_at: row ? new Date(row.ranked_at as string).toISOString() : null,
    capped_at: cap(),
  })
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
