import { getAddress, isAddress } from 'viem'

export const ALERT_EVENTS = [
  'delay_started',
  'position_kept',
  'curator_vault_action',
  'venue_capacity_change',
] as const
export type AlertEvent = (typeof ALERT_EVENTS)[number]
export const ALERT_CHANNELS = ['telegram', 'email'] as const
export type AlertChannel = (typeof ALERT_CHANNELS)[number]
export type ConsentAction = 'subscribe' | 'pause' | 'inspect'

export type ConsentChoices = {
  address: `0x${string}`
  action: ConsentAction
  events: AlertEvent[]
  channels: AlertChannel[]
  emailAddress?: string
  issuedAt: string
  nonce: string
}

const TOKEN_RE = /^[a-f0-9]{32}\.[a-f0-9]{64}$/

export function normalizeEmailAddress(value: unknown): string | null {
  if (typeof value !== 'string' || /[^\x20-\x7e]/.test(value)) return null
  const email = value.trim()
  if (email.length === 0 || email.length > 254 || /\s/.test(email)) return null
  const parts = email.split('@')
  if (parts.length !== 2) return null
  const [local, domain] = parts
  if (
    local.length === 0 ||
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  )
    return null
  const labels = domain.toLowerCase().split('.')
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  )
    return null
  return `${local}@${labels.join('.')}`
}

export function normalizeChoices(value: unknown): ConsentChoices | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (typeof input.address !== 'string' || !isAddress(input.address)) return null
  if (input.action !== 'subscribe' && input.action !== 'pause' && input.action !== 'inspect')
    return null
  if (!Array.isArray(input.events) || !Array.isArray(input.channels)) return null
  if (typeof input.issuedAt !== 'string' || !Number.isFinite(Date.parse(input.issuedAt)))
    return null
  if (typeof input.nonce !== 'string' || !TOKEN_RE.test(input.nonce)) return null
  const events = ALERT_EVENTS.filter((event) => input.events.includes(event))
  const channels = ALERT_CHANNELS.filter((channel) => input.channels.includes(channel))
  if (events.length !== input.events.length || channels.length !== input.channels.length)
    return null
  if (
    new Set(input.events).size !== events.length ||
    new Set(input.channels).size !== channels.length
  )
    return null
  if (input.action === 'subscribe' && (events.length === 0 || channels.length === 0)) return null
  if (input.action !== 'subscribe' && (events.length !== 0 || channels.length !== 0)) return null
  const wantsEmail = input.action === 'subscribe' && channels.includes('email')
  if (!wantsEmail && Object.prototype.hasOwnProperty.call(input, 'emailAddress')) return null
  const emailAddress = wantsEmail ? normalizeEmailAddress(input.emailAddress) : null
  if (wantsEmail && emailAddress === null) return null
  return {
    address: getAddress(input.address),
    action: input.action,
    events,
    channels,
    ...(emailAddress === null ? {} : { emailAddress }),
    issuedAt: new Date(input.issuedAt).toISOString(),
    nonce: input.nonce,
  }
}

export function consentStatement(choice: ConsentChoices): string {
  const wantsEmail = choice.action === 'subscribe' && choice.channels.includes('email')
  return [
    'Membrane alert preference consent',
    `Version: ${wantsEmail ? 2 : 1}`,
    'Chain: Ethereum',
    `Address: ${choice.address}`,
    `Action: ${choice.action}`,
    `Events: ${choice.events.join(',') || 'none'}`,
    `Requested channels: ${choice.channels.join(',') || 'none'}`,
    ...(wantsEmail ? [`Email address: ${choice.emailAddress}`] : []),
    ...(choice.action === 'pause'
      ? ['Pause preserves previously saved event choices and confirmed channels.']
      : []),
    'Delivery requires separate channel confirmation and supported event sources.',
    `Issued at: ${choice.issuedAt}`,
    `Nonce: ${choice.nonce}`,
  ].join('\n')
}
