import { useQuery } from '@tanstack/react-query'
import { useUserBoost } from '@/components/Portfolio/PortPage/hooks/useUserBoost'
import { useStakingClient, getStaked, getConfig } from '@/services/staking'
import { getUserDeposits, getUserLockedDeposits } from '@/services/disco'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import useWallet from '@/hooks/useWallet'
import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'

const SECONDS_PER_DAY = 86400

interface LockedDeposit {
    amount: string
    lockedUntil: number
    boostAmount: string
    daysRemaining: number
}

interface BoostBreakdown {
    totalBoost: string
    staking: {
        baseMBRN: string
        lockedDeposits: LockedDeposit[]
        totalEffectiveMBRN: string
    }
    ltvDisco: {
        baseMBRN: string
        lockedDeposits: LockedDeposit[]
        totalEffectiveMBRN: string
    }
}

/**
 * Calculate boost for a locked deposit based on contract logic
 * Reference: contracts/system_discounts/src/contracts.rs calculate_locked_boost
 */
const calculateLockedBoost = (
    depositAmount: string,
    lockedUntil: number,
    startTime: number,
    currentTime: number,
    lockCeiling: number,
    perpetualLock?: number
): string => {
    // Handle virtual locked_until with perpetual_lock
    let virtualLockedUntil = lockedUntil
    if (perpetualLock) {
        const newLockedUntil = currentTime + perpetualLock * SECONDS_PER_DAY
        const maxLockTime = startTime + lockCeiling * SECONDS_PER_DAY
        virtualLockedUntil = Math.min(newLockedUntil, maxLockTime)
    }

    // Calculate lock duration and time since deposit
    const lockDuration = Math.max(0, virtualLockedUntil - startTime)
    const timeSinceDeposit = Math.max(0, currentTime - startTime)
    const lockCeilingSeconds = lockCeiling * SECONDS_PER_DAY

    if (lockCeilingSeconds === 0) {
        return depositAmount
    }

    // Calculate ratios
    const lockRatio = lockDuration / lockCeilingSeconds
    const timeRatio = timeSinceDeposit / lockCeilingSeconds

    // Add the ratios together instead of taking the max
    const combinedRatio = lockRatio + timeRatio
    const cappedRatio = Math.min(combinedRatio, 1.0)

    // Apply boost: boosted_amount = deposit_amount * (1 + ratio)
    const boostMultiplier = 1 + cappedRatio
    const boostedAmount = num(depositAmount).times(boostMultiplier)

    return boostedAmount.toString()
}

export const useBoostBreakdown = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { address } = useWallet()
    const { data: boostData } = useUserBoost()
    const { data: stakingClient } = useStakingClient()

    return useQuery({
        queryKey: ['boost_breakdown', address, appState.rpcUrl],
        queryFn: async (): Promise<BoostBreakdown | null> => {
            if (!address || !client || !stakingClient) {
                return null
            }

            const currentTime = Math.floor(Date.now() / 1000)
            const totalBoost = boostData?.boost || '0'

            // Get staking data
            let stakingBaseMBRN = '0'
            let stakingLockedDeposits: LockedDeposit[] = []
            let stakingTotalEffectiveMBRN = '0'

            try {
                const stakerResponse = await getStaked(address, stakingClient)
                const stakingConfig = await getConfig(stakingClient)
                const rewards = await stakingClient.userRewards({ user: address }).catch(() => ({
                    accrued_interest: '0',
                    claimables: [],
                }))

                // Base MBRN: total_staked + accrued_interest
                const baseMBRN = num(stakerResponse.total_staked)
                    .plus(rewards.accrued_interest || '0')
                stakingBaseMBRN = baseMBRN.toString()

                // Process locked deposits
                let totalBoosted = baseMBRN
                for (const deposit of stakerResponse.deposit_list || []) {
                    if (deposit.locked && deposit.locked.locked_until > currentTime) {
                        const boostedAmount = calculateLockedBoost(
                            deposit.amount,
                            deposit.locked.locked_until,
                            deposit.stake_time,
                            currentTime,
                            stakingConfig.lock_duration_ceiling,
                            deposit.locked.perpetual_lock
                        )

                        const boostAmount = num(boostedAmount).minus(deposit.amount)
                        const daysRemaining = Math.floor(
                            (deposit.locked.locked_until - currentTime) / SECONDS_PER_DAY
                        )


                        stakingLockedDeposits.push({
                            amount: deposit.amount,
                            lockedUntil: deposit.locked.locked_until,
                            boostAmount: boostAmount.toString(),
                            daysRemaining,
                        })

                        totalBoosted = totalBoosted.plus(boostAmount)
                    }
                }

                stakingTotalEffectiveMBRN = totalBoosted.toString()
            } catch (error) {
                console.error('Error fetching staking data:', error)
            }

            // Get LTV Disco data
            let discoBaseMBRN = '0'
            let discoLockedDeposits: LockedDeposit[] = []
            let discoTotalEffectiveMBRN = '0'

            try {
                const discoContract = (contracts as any).ltv_disco
                if (discoContract) {
                    // Get total deposits (base)
                    const totalDepositsResponse = await client.queryContractSmart(discoContract, {
                        user_total_deposits: { user: address },
                    })
                    discoBaseMBRN = totalDepositsResponse?.total_deposits || '0'

                    // Get locked deposits
                    const lockedDepositsResponse = await getUserLockedDeposits(client, address, discoContract)

                    if (lockedDepositsResponse?.locked_deposits) {
                        // Get disco config for lock_ceiling
                        const discoConfig = await client.queryContractSmart(discoContract, {
                            config: {},
                        })

                        let totalBoosted = num(discoBaseMBRN)

                        for (const lockedDeposit of lockedDepositsResponse.locked_deposits) {
                            const deposit = lockedDeposit.deposit
                            if (deposit.locked && deposit.locked.locked_until > currentTime) {
                                // Convert vault tokens to deposit tokens
                                let depositTokens: string
                                try {
                                    const conversionResponse = await client.queryContractSmart(discoContract, {
                                        vault_token_conversion: {
                                            asset: lockedDeposit.asset,
                                            ltv: lockedDeposit.ltv,
                                            max_borrow_ltv: lockedDeposit.max_borrow_ltv,
                                            vault_tokens: deposit.vault_tokens,
                                        },
                                    })
                                    depositTokens = conversionResponse || deposit.vault_tokens
                                } catch (error) {
                                    console.error('Error converting vault tokens:', error)
                                    depositTokens = deposit.vault_tokens
                                }

                                const boostedAmount = calculateLockedBoost(
                                    depositTokens,
                                    deposit.locked.locked_until,
                                    deposit.start_time,
                                    currentTime,
                                    discoConfig.lock_duration_ceiling,
                                    deposit.locked.perpetual_lock
                                )

                                const boostAmount = num(boostedAmount).minus(depositTokens)
                                const daysRemaining = Math.floor(
                                    (deposit.locked.locked_until - currentTime) / SECONDS_PER_DAY
                                )

                                discoLockedDeposits.push({
                                    amount: depositTokens,
                                    lockedUntil: deposit.locked.locked_until,
                                    boostAmount: boostAmount.toString(),
                                    daysRemaining,
                                })

                                totalBoosted = totalBoosted.plus(boostAmount)
                            }
                        }

                        discoTotalEffectiveMBRN = totalBoosted.toString()
                    } else {
                        discoTotalEffectiveMBRN = discoBaseMBRN
                    }
                }
            } catch (error) {
                console.error('Error fetching LTV Disco data:', error)
                discoTotalEffectiveMBRN = discoBaseMBRN
            }

            return {
                totalBoost,
                staking: {
                    baseMBRN: stakingBaseMBRN,
                    lockedDeposits: stakingLockedDeposits,
                    totalEffectiveMBRN: stakingTotalEffectiveMBRN,
                },
                ltvDisco: {
                    baseMBRN: discoBaseMBRN,
                    lockedDeposits: discoLockedDeposits,
                    totalEffectiveMBRN: discoTotalEffectiveMBRN,
                },
            }
        },
        enabled: !!address && !!client && !!stakingClient,
        staleTime: 1000 * 60 * 2, // 2 minutes
    })
}

