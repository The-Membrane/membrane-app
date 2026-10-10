import type { TelegramDeliveryPorts } from './telegramDelivery'

const BOT_TOKEN = /^[0-9]{5,20}:[A-Za-z0-9_-]{20,}$/
const PRIVATE_CHAT_ID = /^[1-9][0-9]{0,19}$/

/** One attempt only. The outbox quarantines every ambiguous post-begin result. */
export function makeTelegramHttpSender(
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs = 10_000,
): TelegramDeliveryPorts['send'] {
  if (!BOT_TOKEN.test(token)) throw new Error('invalid Telegram sender configuration')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000)
    throw new Error('invalid Telegram sender timeout')
  return async (chatId, text) => {
    if (!PRIVATE_CHAT_ID.test(chatId) || !text || text.length > 4096) return false
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return false
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object') return false
      const reply = body as {
        ok?: unknown
        result?: { message_id?: unknown; chat?: { id?: unknown; type?: unknown } }
      }
      return (
        reply.ok === true &&
        typeof reply.result?.message_id === 'number' &&
        Number.isSafeInteger(reply.result.message_id) &&
        reply.result.message_id >= 0 &&
        reply.result.chat?.type === 'private' &&
        String(reply.result.chat.id) === chatId
      )
    } catch {
      // Never log the request URL (which contains the bot token), response
      // body, or error. After begin/send ambiguity the row stays uncertain.
      return false
    }
  }
}
