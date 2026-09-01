import React, { useState } from 'react'
import { Text } from '@chakra-ui/react'
import { Card } from '@/components/ui/Card'
import { ResponsiveTableContainer } from '@/components/ui/ResponsiveTable'
import { useCurrentlyLent } from './hooks/useCurrentlyLent'
import { CurrentlyLentDesktopTable } from './CurrentlyLentDesktopTable'
import { CurrentlyLentMobileCards } from './CurrentlyLentMobileCards'

export const CurrentlyLent: React.FC = () => {
    const [isExpanded, setIsExpanded] = useState(false)
    const data = useCurrentlyLent()

    if (!data.hasDeposits && !data.isLoading) return null

    const vestingLabel = data.vestingDaysRemaining > 0
        ? `${data.vestingDaysRemaining}d left`
        : 'Vested'

    return (
        <Card p={4}>
            <Text fontSize="lg" fontWeight="bold" mb={4} color="white">
                Currently Lent
            </Text>

            <ResponsiveTableContainer
                desktopTable={
                    <CurrentlyLentDesktopTable
                        data={data}
                        isExpanded={isExpanded}
                        setIsExpanded={setIsExpanded}
                        vestingLabel={vestingLabel}
                    />
                }
                mobileCards={
                    <CurrentlyLentMobileCards
                        data={data}
                        isExpanded={isExpanded}
                        setIsExpanded={setIsExpanded}
                        vestingLabel={vestingLabel}
                    />
                }
            />
        </Card>
    )
}

export default CurrentlyLent
