import React, { RefObject } from 'react'
import { Box } from '@chakra-ui/react'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

interface AcquisitionVisualizerCanvasProps {
    canvasRef: RefObject<HTMLCanvasElement>
}

export const AcquisitionVisualizerCanvas: React.FC<AcquisitionVisualizerCanvasProps> = ({
    canvasRef,
}) => {
    return (
        <Box
            position="relative"
            w="100%"
            bg={SEMANTIC_COLORS.bgSecondary}
            borderRadius={0}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            p={4}
            mb={6}
        >
            <canvas
                ref={canvasRef}
                style={{
                    width: '100%',
                    height: 'auto',
                    display: 'block',
                    imageRendering: 'crisp-edges',
                }}
            />
        </Box>
    )
}
