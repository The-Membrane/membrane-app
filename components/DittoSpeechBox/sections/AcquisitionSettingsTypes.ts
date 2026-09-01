export interface IntentConfig {
    type: 'stake' | 'deposit' | 'send'
    enabled: boolean
    ratio: number // 0-100
    lockDays: number // 0-365
    // For deposit
    asset?: string
    slot?: number // 1-9
    // For send
    address?: string
}
