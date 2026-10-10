import { parseUnits } from 'viem'

export type WalletExitReading = {
  status: 'ok'
  source: {
    blockNumber: number
    blockTime: string
    observedAt: string
    ageSeconds: number
  }
  vault: { withdrawalsPaused: boolean }
  position: {
    sharesSgho: string
    maxRedeemSgho: string
    previewRedeemGho: string
    maxWithdrawGho: string
    maxWithdrawGhoRaw: string
    effectiveExitGho: string
    effectiveExitGhoRaw: string
  }
}

export const isWalletExitReading = (value: unknown): value is WalletExitReading => {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<WalletExitReading>
  return (
    data.status === 'ok' &&
    Number.isSafeInteger(data.source?.blockNumber) &&
    typeof data.source?.blockTime === 'string' &&
    typeof data.source?.observedAt === 'string' &&
    Number.isFinite(data.source?.ageSeconds) &&
    typeof data.vault?.withdrawalsPaused === 'boolean' &&
    ['sharesSgho', 'maxRedeemSgho', 'previewRedeemGho', 'maxWithdrawGho', 'effectiveExitGho'].every(
      (key) => {
        const amount = data.position?.[key as keyof WalletExitReading['position']]
        return (
          typeof amount === 'string' &&
          /^\d+(?:\.\d+)?$/.test(amount) &&
          Number.isFinite(Number(amount))
        )
      },
    ) &&
    typeof data.position?.maxWithdrawGhoRaw === 'string' &&
    /^\d+$/.test(data.position.maxWithdrawGhoRaw) &&
    typeof data.position?.effectiveExitGhoRaw === 'string' &&
    /^\d+$/.test(data.position.effectiveExitGhoRaw) &&
    BigInt(data.position.effectiveExitGhoRaw) <= BigInt(data.position.maxWithdrawGhoRaw) &&
    (!data.vault.withdrawalsPaused || BigInt(data.position.effectiveExitGhoRaw) === 0n)
  )
}

export const formatWalletGho = (amount: string) => {
  const [whole, fraction = ''] = amount.split('.')
  const shownFraction = fraction.slice(0, 6).replace(/0+$/, '')
  const hasHiddenDigits = /[1-9]/.test(fraction.slice(6))
  if (whole === '0' && !shownFraction && hasHiddenDigits) return '<0.000001 GHO'
  return `${hasHiddenDigits ? '≈' : ''}${BigInt(whole).toLocaleString('en-US')}${shownFraction ? `.${shownFraction}` : ''} GHO`
}

export const sizeWithinWalletExitLimit = (size: string, rawLimit: string): boolean | null => {
  if (!/^\d+(?:\.\d{1,18})?$/.test(size) || !/^\d+$/.test(rawLimit)) return null
  return parseUnits(size, 18) <= BigInt(rawLimit)
}
