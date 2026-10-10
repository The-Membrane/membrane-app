import { describe, expect, it, vi } from 'vitest'

import { makeTelegramHttpSender } from '@/lib/alerts/telegramHttpSender'

const token = `123456789:${'a'.repeat(35)}`
const chatId = '123456789'
const message = 'Membrane · protection delay started'

function fakeFetch(response: Response) {
  return vi.fn(async () => response) as unknown as typeof fetch
}

describe('inert one-attempt Telegram sender', () => {
  it('posts a private-chat message once and accepts only the matching API receipt', async () => {
    const fetcher = fakeFetch(
      Response.json({
        ok: true,
        result: { message_id: 42, chat: { id: 123456789, type: 'private' } },
      }),
    )
    const send = makeTelegramHttpSender(token, fetcher)
    await expect(send(chatId, message)).resolves.toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, options] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toMatch(/^https:\/\/api\.telegram\.org\/bot.*\/sendMessage$/)
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body as string)).toEqual({ chat_id: chatId, text: message })
  })

  it('treats errors, malformed replies, and wrong destination as uncertain failure', async () => {
    const responses = [
      Response.json({ ok: false }, { status: 429 }),
      Response.json({ ok: true, result: { message_id: 1, chat: { id: 99, type: 'private' } } }),
      Response.json({
        ok: true,
        result: { message_id: 1, chat: { id: 123456789, type: 'group' } },
      }),
      Response.json({ ok: true }),
      new Response('not json'),
    ]
    for (const response of responses)
      await expect(
        makeTelegramHttpSender(token, fakeFetch(response))(chatId, message),
      ).resolves.toBe(false)
    const throwing = vi.fn(async () => {
      throw new Error(`secret ${token}`)
    }) as unknown as typeof fetch
    await expect(makeTelegramHttpSender(token, throwing)(chatId, message)).resolves.toBe(false)
  })

  it('rejects unsafe configuration or invalid destination before a request', async () => {
    const fetcher = fakeFetch(Response.json({ ok: true }))
    expect(() => makeTelegramHttpSender('bad', fetcher)).toThrow('configuration')
    expect(() => makeTelegramHttpSender(token, fetcher, 31_000)).toThrow('timeout')
    await expect(makeTelegramHttpSender(token, fetcher)('-100', message)).resolves.toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
