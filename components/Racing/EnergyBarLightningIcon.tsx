import React from 'react'
import { Box } from '@chakra-ui/react'

// Simple lightning icon using SVG
export const LightningIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
    <Box as="span" display="inline-block" w={`${size}px`} h={`${size}px`} mr={2}>
        <svg viewBox="0 0 24 24" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" fill="#7CFF00" xmlns="http://www.w3.org/2000/svg">
            <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
        </svg>
    </Box>
)

export default LightningIcon
