import { useState, useCallback, useMemo } from 'react'
import useAppState from '@/persisted-state/useAppState'
import { TrainingPaymentOption } from '@/persisted-state/useAppState'
import { useBalance } from '@/hooks/useBalance'
import { getAssetByDenom } from '@/helpers/chain'
import { DEFAULT_CHAIN } from '@/config/chains'
import router from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'

export type PaymentOption = TrainingPaymentOption & {
    label: string
    sublabel: string
    isAvailable: boolean
    unavailableReason?: string
    walletBalance?: string
    formattedBalance?: string
}

export const usePaymentSelection = (tokenId?: string) => {
    const { appState, setAppState } = useAppState()

    // Check wallet connection
    const { chainName } = useChainRoute()
    // const { address, chain } = useWallet(chainName)

    const [isOptionsOpen, setIsOptionsOpen] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [statusMessage, setStatusMessage] = useState<string | null>(null)

    const lastUsedPaymentMethod = appState.lastUsedRacingPaymentMethod
    // Get wallet balances for the current chain (Neutron for minting, Osmosis for racing)
    const { data: balances, isLoading: balancesLoading, error: balancesError } = useBalance(chainName)

    const paymentOptions = useMemo((): PaymentOption[] => {
        // Default options with balance checking
        const baseOptions: PaymentOption[] = [
            {
                denom: "factory/neutron1r5qx58l3xx2y8gzjtkqjndjgx69mktmapl45vns0pa73z0zpn7fqgltnll/TAB",
                amount: '50000000', //50 TAB
                label: 'Pay 50 TAB',
                sublabel: '10% is burned',
                isAvailable: true
            },
            {
                denom: "ibc/B559A80D62249C8AA07A380E2A2BEA6E5CA9A6F079C912C3A9E9B494105E4F81",
                amount: '10000000',
                label: 'Pay 1 USDC',
                sublabel: '10% is sent to JSD yields.',
                isAvailable: true
            },
            {
                denom: "untrn",
                amount: '30000000',
                label: 'Pay 20 NTRN',
                sublabel: 'Nothing special.',
                isAvailable: true
            }
        ]

        // Add free option if available
        const freeOption: PaymentOption = {
            denom: '',
            amount: '0',
            label: 'Free refill',
            sublabel: 'No cost, limited availability',
            isAvailable: true
        }

        // Check balances and update availability
        if (balances) {
            baseOptions.forEach(option => {
                const balance = balances.find((b: any) => b.denom === option.denom)

                if (balance) {
                    const balanceAmount = BigInt(balance.amount)
                    const requiredAmount = BigInt(option.amount)
                    const asset = getAssetByDenom(option.denom, chainName)

                    option.walletBalance = balance.amount
                    option.formattedBalance = asset ?
                        (Number(balance.amount) / Math.pow(10, asset.decimal || 6)).toLocaleString() + ' ' + asset.symbol :
                        balance.amount + ' ' + option.denom

                    if (balanceAmount < requiredAmount) {
                        option.isAvailable = false
                        option.unavailableReason = `Insufficient balance: ${option.formattedBalance}`
                    }
                } else {
                    // Always show balance, default to 0 if not found
                    const asset = getAssetByDenom(option.denom, chainName)
                    option.walletBalance = '0'
                    option.formattedBalance = asset ?
                        '0 ' + asset.symbol :
                        '0 ' + option.denom
                    option.isAvailable = false
                    option.unavailableReason = 'No balance found'
                }
            })
        } else {
            baseOptions.forEach(option => {
                const asset = getAssetByDenom(option.denom, chainName)
                option.walletBalance = '0'
                option.formattedBalance = asset ?
                    '0 ' + asset.symbol :
                    '0 ' + option.denom
                option.isAvailable = false
                option.unavailableReason = 'Balance data not available'
            })
        }

        // If balance query failed, still show options but mark them as unavailable
        if (balancesError) {
            baseOptions.forEach(option => {
                const asset = getAssetByDenom(option.denom, chainName)
                option.walletBalance = '0'
                option.formattedBalance = asset ?
                    '0 ' + asset.symbol :
                    '0 ' + option.denom
                option.isAvailable = false
                option.unavailableReason = 'Unable to fetch balance'
            })
        }

        return [...baseOptions]
    }, [balances, chainName, balancesError])

    const setLastUsedPaymentMethod = useCallback((option: TrainingPaymentOption | null) => {
        setAppState({ lastUsedRacingPaymentMethod: option })
    }, [setAppState])

    const openOptions = useCallback(() => {
        setIsOptionsOpen(true)
    }, [])

    const closeOptions = useCallback(() => {
        setIsOptionsOpen(false)
    }, [])

    const executePayment = useCallback((option: PaymentOption, action: () => void, onSuccess?: () => void) => {
        if (!option.isAvailable) return

        setIsLoading(true)
        setStatusMessage('Processing...')

        try {
            // Execute the action using the provided function
            action()

            // Set as last used method if it's not the free option
            if (option.denom && option.amount !== '0') {
                setLastUsedPaymentMethod({
                    denom: option.denom,
                    amount: option.amount
                })
            }

            setStatusMessage('Complete!')

            // Clear status after 2 seconds
            setTimeout(() => {
                setStatusMessage(null)
            }, 2000)

            onSuccess?.()
        } catch (error) {
            console.error('Action error:', error)
            setStatusMessage('Failed')
            setTimeout(() => {
                setStatusMessage(null)
            }, 2000)
        } finally {
            setIsLoading(false)
        }
    }, [setLastUsedPaymentMethod])

    const quickRefill = useCallback((refillAction: () => void, onSuccess?: () => void) => {
        if (lastUsedPaymentMethod) {
            const option = paymentOptions.find(opt =>
                opt.denom === lastUsedPaymentMethod.denom &&
                opt.amount === lastUsedPaymentMethod.amount
            )

            if (option && option.isAvailable) {
                executePayment(option, refillAction, onSuccess)
                return
            }
        }

        // If no last used method or it's unavailable, open options
        openOptions()
    }, [lastUsedPaymentMethod, paymentOptions, executePayment, openOptions])

    const quickMint = useCallback((mintAction: () => void, onSuccess?: () => void) => {
        if (lastUsedPaymentMethod) {
            const option = paymentOptions.find(opt =>
                opt.denom === lastUsedPaymentMethod.denom &&
                opt.amount === lastUsedPaymentMethod.amount
            )

            if (option && option.isAvailable) {
                executePayment(option, mintAction, onSuccess)
                return
            }
        }

        // If no last used method or it's unavailable, open options
        openOptions()
    }, [lastUsedPaymentMethod, paymentOptions, executePayment, openOptions])

    return {
        isOptionsOpen,
        isLoading,
        statusMessage,
        lastUsedPaymentMethod,
        paymentOptions,
        openOptions,
        closeOptions,
        executePayment,
        quickRefill,
        quickMint
    }
}
