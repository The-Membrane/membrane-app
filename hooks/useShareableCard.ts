import { useRef, useCallback, useMemo } from 'react'
import { usePortMetrics } from '@/components/Portfolio/PortPage/hooks/usePortMetrics'
import { useUserBoost } from '@/components/Portfolio/PortPage/hooks/useUserBoost'
import { useContributionPercentage } from '@/components/Portfolio/PortPage/hooks/useContributionPercentage'
import { useUserPoints, useSoloLevel, useUserRank } from '@/hooks/usePoints'
import {
    exportElementAsImage,
    copyElementToClipboard,
    getTwitterShareUrl,
    type ShareableCardData,
    type CardType,
} from '@/services/shareableCard'

const MAX_MBRN = 100_000_000 // 100M MBRN

export const useShareableCard = (cardType?: CardType) => {
    const cardRef = useRef<HTMLDivElement>(null)

    // Fetch all relevant data
    const { data: portMetrics } = usePortMetrics()
    const { data: boostData } = useUserBoost()
    const contributionData = useContributionPercentage()
    const { data: pointsData } = useUserPoints()
    const { data: levelData } = useSoloLevel()
    const { data: rank } = useUserRank()

    // Calculate boost values
    const boostPercentage = useMemo(() => {
        if (!boostData?.boost) return 0
        return parseFloat(boostData.boost) * 100
    }, [boostData])

    const mbrnAmount = useMemo(() => {
        return (boostPercentage / 100) * MAX_MBRN
    }, [boostPercentage])

    // Calculate milestones
    const milestones = useMemo(() => {
        const milestoneValues = [1, 10, 100, 1000, 10000, 100000, 1000000]
        const currentRevenue = portMetrics?.totalRevenue || 0
        return milestoneValues.map((m) => ({
            value: m,
            achieved: m <= currentRevenue,
        }))
    }, [portMetrics])

    // Next milestone for boost
    const nextMilestone = useMemo(() => {
        const milestones = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
        const nextMilestoneValue = milestones.find((m) => m * 1_000_000 > mbrnAmount)
        return nextMilestoneValue ? nextMilestoneValue * 1_000_000 : MAX_MBRN
    }, [mbrnAmount])

    // Aggregate card data
    const cardData: ShareableCardData = useMemo(() => ({
        // Revenue data
        totalRevenue: portMetrics?.totalRevenue || 0,
        revenuePerSecond: portMetrics?.revenuePerSecond || 0,
        milestones,

        // Boost data
        boostPercentage,
        mbrnAmount,
        nextMilestone,

        // Contribution data
        contributionPercentage: contributionData.percentage,
        tvlContribution: contributionData.tvlContribution,
        revenueContribution: contributionData.revenueContribution,
        tier: contributionData.tier,

        // Points data
        rank: rank || 0,
        totalPoints: pointsData?.stats?.total_points ? parseFloat(pointsData.stats.total_points) : 0,
        level: levelData?.level || 1,
        pointsInLevel: levelData?.points_in_level || 0,
        levelUpMaxPoints: levelData?.levelup_max_points || 10,
    }), [portMetrics, boostPercentage, mbrnAmount, nextMilestone, contributionData, pointsData, levelData, rank, milestones])

    // Export functions
    const exportAsImage = useCallback(async (filename?: string) => {
        if (!cardRef.current) return
        const defaultFilename = `membrane-${cardType || 'card'}-${Date.now()}.png`
        await exportElementAsImage(cardRef.current, filename || defaultFilename)
    }, [cardType])

    const copyToClipboard = useCallback(async () => {
        if (!cardRef.current) return false
        return copyElementToClipboard(cardRef.current)
    }, [])

    // Share functions
    const shareOnTwitter = useCallback((customText?: string) => {
        const defaultTexts: Record<CardType, string> = {
            revenue: `I've earned $${cardData.totalRevenue?.toFixed(2)} on Membrane! 🚀`,
            boost: `My Membrane boost is at ${cardData.boostPercentage?.toFixed(2)}%! 📈`,
            contribution: `I'm a ${cardData.tier} on Membrane with ${cardData.contributionPercentage?.toFixed(2)}% contribution! 💪`,
            points: `Rank #${cardData.rank} on Membrane with ${cardData.totalPoints?.toFixed(0)} points! 🏆`,
            portfolio: `Check out my Membrane portfolio! 🔥`,
        }
        const text = customText || (cardType ? defaultTexts[cardType] : 'Check out my Membrane stats!')
        window.open(getTwitterShareUrl(text, 'https://membrane.fi'), '_blank')
    }, [cardData, cardType])

    return {
        cardRef,
        cardData,
        exportAsImage,
        copyToClipboard,
        shareOnTwitter,
    }
}

export default useShareableCard


