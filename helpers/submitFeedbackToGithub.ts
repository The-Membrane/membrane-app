// SECURITY: the GitHub PAT lives server-side only (pages/api/feedback.ts reads
// FEEDBACK_GITHUB_TOKEN). The client never sees the token — it just POSTs the
// feedback payload to our own API route.

export interface FeedbackData {
  feedback_text: string
  category: string
  sentiment_score?: number
  feature_area: string
}

export type FeedbackResult = { success: true } | { success: false; error: string }

export async function submitFeedbackToGithub(data: FeedbackData): Promise<FeedbackResult> {
  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    const json: FeedbackResult | null = await res.json().catch(() => null)
    if (json && typeof json === 'object' && 'success' in json) {
      return json
    }
    return { success: false, error: `Failed to submit feedback: ${res.status} ${res.statusText}` }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown network error' }
  }
}
