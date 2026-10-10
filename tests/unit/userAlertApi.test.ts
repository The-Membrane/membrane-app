import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'

const store = vi.hoisted(() => ({
  readPreference: vi.fn(),
  savePreference: vi.fn(),
  createTelegramLink: vi.fn(),
}))
vi.mock('@/lib/alerts/store', () => store)
const database = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/db', () => ({ db: database }))

import { createConsentChallenge } from '@/lib/alerts/challenge'
import { consentStatement, normalizeChoices } from '@/lib/alerts/consent'
import handler from '@/pages/api/alerts/preferences'

const SECRET = 'alert-consent-secret-for-tests-only-000001'
const OWNER = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)
const OTHER = privateKeyToAccount(('0x' + '22'.repeat(32)) as `0x${string}`)

function response() {
  const state: { status: number; body: any } = { status: 0, body: null }
  const res = {
    setHeader: vi.fn(),
    status: vi.fn((status: number) => {
      state.status = status
      return res
    }),
    json: vi.fn((body: any) => {
      state.body = body
      return res
    }),
  }
  return { state, res: res as any }
}

async function request(
  action: 'subscribe' | 'pause' | 'inspect',
  signer = OWNER,
  issuedAt = new Date(),
) {
  const challenge = createConsentChallenge(OWNER.address, SECRET, issuedAt)
  const choice = normalizeChoices({
    address: OWNER.address,
    action,
    events: action === 'subscribe' ? ['delay_started', 'position_kept'] : [],
    channels: action === 'subscribe' ? ['telegram'] : [],
    ...challenge,
  })!
  const signature = await signer.signMessage({ message: consentStatement(choice) })
  return { method: 'POST', body: { ...choice, signature } } as any
}

beforeEach(() => {
  process.env.ALERT_CONSENT_SECRET = SECRET
  process.env.TELEGRAM_ALERTS_BOT_TOKEN = 'fake-token'
  process.env.TELEGRAM_ALERTS_BOT_USERNAME = 'MembraneAlertBot'
  process.env.TELEGRAM_ALERTS_INBOUND_VERIFIED = '1'
  store.savePreference.mockResolvedValue({
    replay: false,
    preference: { exists: true, deliveryEnabled: false },
  })
  store.readPreference.mockResolvedValue({ exists: true, deliveryEnabled: false })
  store.createTelegramLink.mockResolvedValue('https://t.me/MembraneAlertBot?start=opaque')
  database.execute.mockResolvedValue({ rows: [{ ready: true }] })
})
afterEach(() => {
  vi.clearAllMocks()
  delete process.env.ALERT_CONSENT_SECRET
  delete process.env.TELEGRAM_ALERTS_BOT_TOKEN
  delete process.env.TELEGRAM_ALERTS_BOT_USERNAME
  delete process.env.TELEGRAM_ALERTS_INBOUND_VERIFIED
})

describe('alert preference API', () => {
  it('accepts only wallet-signed consent and still reports delivery disabled', async () => {
    const { state, res } = response()
    await handler(await request('subscribe'), res)
    expect(state.status).toBe(200)
    expect(store.savePreference).toHaveBeenCalledTimes(1)
    expect(store.createTelegramLink).toHaveBeenCalledTimes(1)
    expect(state.body.preference.deliveryEnabled).toBe(false)
  })

  it('does not offer a Telegram link until inbound receipt is operator-verified', async () => {
    delete process.env.TELEGRAM_ALERTS_INBOUND_VERIFIED
    const { state, res } = response()
    await handler(await request('subscribe'), res)
    expect(state.status).toBe(200)
    expect(state.body.telegramLink).toBeNull()
    expect(store.createTelegramLink).not.toHaveBeenCalled()
  })

  it('reports saved consent when optional Telegram-link creation fails', async () => {
    store.createTelegramLink.mockRejectedValueOnce(new Error('link storage unavailable'))
    const { state, res } = response()
    await handler(await request('subscribe'), res)
    expect(state.status).toBe(200)
    expect(state.body.preference).toMatchObject({ exists: true, deliveryEnabled: false })
    expect(state.body.telegramLink).toBeNull()
    expect(store.savePreference).toHaveBeenCalledTimes(1)
  })

  it('rejects a signature from another wallet before any write', async () => {
    const { state, res } = response()
    await handler(await request('subscribe', OTHER), res)
    expect(state.status).toBe(401)
    expect(store.savePreference).not.toHaveBeenCalled()
  })

  it('rejects replacing the email address after signing before any write', async () => {
    const req = await request('subscribe')
    const signed = normalizeChoices({
      ...req.body,
      channels: ['email'],
      emailAddress: 'alice@example.com',
    })!
    req.body = {
      ...signed,
      emailAddress: 'bob@example.com',
      signature: await OWNER.signMessage({ message: consentStatement(signed) }),
    }
    const { state, res } = response()
    await handler(req, res)
    expect(state.status).toBe(401)
    expect(store.savePreference).not.toHaveBeenCalled()
  })

  it('rejects an expired challenge before any write', async () => {
    const { state, res } = response()
    await handler(await request('subscribe', OWNER, new Date(Date.now() - 11 * 60 * 1000)), res)
    expect(state.status).toBe(400)
    expect(store.savePreference).not.toHaveBeenCalled()
  })

  it('uses a signed inspect without changing consent', async () => {
    const { state, res } = response()
    await handler(await request('inspect'), res)
    expect(state.status).toBe(200)
    expect(store.readPreference).toHaveBeenCalledWith(OWNER.address)
    expect(store.savePreference).not.toHaveBeenCalled()
  })

  it('fails closed when the nonce was already used', async () => {
    store.savePreference.mockResolvedValue({ replay: true })
    const { state, res } = response()
    await handler(await request('subscribe'), res)
    expect(state.status).toBe(409)
    expect(store.createTelegramLink).not.toHaveBeenCalled()
  })
})
