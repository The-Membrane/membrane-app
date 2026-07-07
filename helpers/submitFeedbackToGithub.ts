// SECURITY: never hardcode the PAT — GitHub push protection blocks it, and anything
// NEXT_PUBLIC_* ships in the client bundle anyway (scope the token to the feedback
// repo only, contents:write, nothing else). Unset => feedback submission no-ops.
const GITHUB_TOKEN = process.env.NEXT_PUBLIC_FEEDBACK_GITHUB_TOKEN ?? ''
const REPO = 'triccs/membrane-app-feedback'
const FILE_PATH = 'membrane-app-feedback/feedback.csv'
const API_URL = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`

const CSV_HEADERS = 'timestamp,feedback_text,category,sentiment_score,feature_area,status'

export interface FeedbackData {
  feedback_text: string
  category: string
  sentiment_score?: number
  feature_area: string
}

export type FeedbackResult = { success: true } | { success: false; error: string }

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

const headers = () => ({
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
})

export async function submitFeedbackToGithub(data: FeedbackData): Promise<FeedbackResult> {
  if (!GITHUB_TOKEN) {
    return { success: false, error: 'Feedback disabled: NEXT_PUBLIC_FEEDBACK_GITHUB_TOKEN not set' }
  }
  try {
    // 1. GET existing file (or detect 404)
    const getRes = await fetch(API_URL, { headers: headers() })

    let existingContent = ''
    let sha: string | undefined

    if (getRes.ok) {
      const json = await getRes.json()
      sha = json.sha
      existingContent = atob(json.content.replace(/\n/g, ''))
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
      content: btoa(updatedContent),
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
