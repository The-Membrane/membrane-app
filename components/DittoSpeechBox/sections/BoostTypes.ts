export interface SelectedDeposit {
    type: 'staking' | 'disco'
    index: number
}

export type ActiveForm = 'deposit' | 'withdraw' | 'edit' | null

export interface BoostDeposit {
    amount: string
    lockedUntil: number
    boostAmount: string
    daysRemaining: number
}
