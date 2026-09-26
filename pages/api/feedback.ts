import type { NextApiRequest, NextApiResponse } from 'next'
import type { FeedbackData, FeedbackResult } from '@/helpers/submitFeedbackToGithub'

// SECURITY: server-only env var (no NEXT_PUBLIC_ prefix) so the PAT never enters
// a client bundle. Scope the token to the feedback repo only, contents:write,
// nothing else. Unset => feedback submission no-ops.
const GITHUB_TOKEN = process.env.FEEDBACK_GITHUB_TOKEN ?? ''
const REPO = 'triccs/membrane-app-feedback'
const FILE_PATH = 'membrane-app-feedback/feedback.csv'
const API_URL = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`

const CSV_HEADERS = 'timestamp,feedback_text,category,sentiment_score,feature_area,status'

const MAX_FIELD_LENGTH = 5000

/**
 * Strip leading =, +, -, @ to prevent CSV injection,
 * escape internal double-quotes, and wrap in double-quotes.
 */
function sanitizeCSVValue(value: string): string {
  let sanitized = String(value)
  while (/^[=+\-@]/.test(sanitized)) {
    sanitized = sanitized.slice(1)
  }
  sanitized = sanitized.replace(/"/g, '""')
  return `"${sanitized}"`
}

function buildCSVRow(data: FeedbackData): string {
  const timestamp = new Date().toISOString()
  const fields = [
    timestamp,
    data.feedback_text,
    data.category,
    data.sentiment_score != null ? String(data.sentiment_score) : '',
    data.feature_area,
    'new',
  ]
  return fields.map(sanitizeCSVValue).join(',')
}

function parseBody(body: unknown): FeedbackData | null {
  if (typeof body !== 'object' || body === null) return null
  const { feedback_text, category, sentiment_score, feature_area } = body as Record<string, unknown>
  if (typeof feedback_text !== 'string' || feedback_text.trim().length === 0) return null
  if (typeof category !== 'string' || category.length === 0) return null
  if (typeof feature_area !== 'string' || feature_area.length === 0) return null
  if (sentiment_score != null && typeof sentiment_score !== 'number') return null
  if ([feedback_text, category, feature_area].some((f) => f.length > MAX_FIELD_LENGTH)) return null
  return {
    feedback_text: feedback_text.trim(),
    category,
    feature_area,
    ...(typeof sentiment_score === 'number' ? { sentiment_score } : {}),
  }
}

const headers = () => ({
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
})

async function appendFeedbackToGithub(data: FeedbackData): Promise<FeedbackResult> {
  try {
    // 1. GET existing file (or detect 404)
    const getRes = await fetch(API_URL, { headers: headers() })

    let existingContent = ''
    let sha: string | undefined

    if (getRes.ok) {
      const json = await getRes.json()
      sha = json.sha
      existingContent = Buffer.from(json.content, 'base64').toString('utf-8')
    } else if (getRes.status === 404) {
      existingContent = CSV_HEADERS
    } else {
      return { success: false, error: `Failed to read file: ${getRes.status} ${getRes.statusText}` }
    }

    // 2. Append new row
    const row = buildCSVRow(data)
    const updatedContent = existingContent.trimEnd() + '\n' + row + '\n'

    // 3. PUT updated file
    const putBody: Record<string, string> = {
      message: 'Add feedback entry',
      content: Buffer.from(updatedContent, 'utf-8').toString('base64'),
    }
    if (sha) putBody.sha = sha

    const putRes = await fetch(API_URL, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(putBody),
    })

    if (putRes.ok) {
      return { success: true }
    }

    const errBody = await putRes.json().catch(() => null)
    const errMsg = errBody?.message || `${putRes.status} ${putRes.statusText}`
    return { success: false, error: `Failed to write file: ${errMsg}` }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown network error' }
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<FeedbackResult>) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' })
  }

  if (!GITHUB_TOKEN) {
    return res.status(503).json({ success: false, error: 'Feedback disabled: FEEDBACK_GITHUB_TOKEN not set' })
  }

  const data = parseBody(req.body)
  if (!data) {
    return res.status(400).json({ success: false, error: 'Invalid feedback payload' })
  }

  const result = await appendFeedbackToGithub(data)
  return res.status(result.success ? 200 : 502).json(result)
}
