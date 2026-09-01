import React from 'react'
import { Text } from '@chakra-ui/react'
import { m } from 'framer-motion'
import { PRIMARY_PURPLE } from './LTVCarouselConstants'

interface LTVCarouselSelectedFrameProps {
    selectedLTV: number
}

// The fixed, centered frame that displays the currently selected LTV value.
export const LTVCarouselSelectedFrame: React.FC<LTVCarouselSelectedFrameProps> = ({
    selectedLTV,
}) => {
    return (
        <m.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2 }}
            style={{
                width: '80px',
                height: '60px',
                border: `2px solid ${PRIMARY_PURPLE}`,
                borderRadius: '8px',
                background: 'rgba(10, 10, 10, 0.95)',
                boxShadow: `0 0 20px ${PRIMARY_PURPLE}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <Text
                fontSize="xl"
                fontWeight="bold"
                color={PRIMARY_PURPLE}
                fontFamily="mono"
            >
                {Math.round(selectedLTV * 100)}%
            </Text>
        </m.div>
    )
}
