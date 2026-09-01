import React from 'react'
import { usePointsProgress } from './hooks/usePointsProgress'
import { PointsProgressCompactCard } from './PointsProgressCompactCard'
import { PointsProgressFullCard } from './PointsProgressFullCard'

interface PointsProgressCardProps {
    compact?: boolean
}

export const PointsProgressCard: React.FC<PointsProgressCardProps> = ({ compact = false }) => {
    const {
        totalPoints,
        level,
        rank,
        conversionRateRange,
        conversionRatesTooltip,
        progressPercentage,
    } = usePointsProgress()

    if (compact) {
        return (
            <PointsProgressCompactCard
                totalPoints={totalPoints}
                level={level}
                conversionRateRange={conversionRateRange}
                progressPercentage={progressPercentage}
            />
        )
    }

    return (
        <PointsProgressFullCard
            totalPoints={totalPoints}
            level={level}
            rank={rank}
            conversionRateRange={conversionRateRange}
            conversionRatesTooltip={conversionRatesTooltip}
            progressPercentage={progressPercentage}
        />
    )
}
