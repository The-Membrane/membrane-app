import React from 'react'
import { Box, VStack, Text, HStack } from '@chakra-ui/react'
import { motion, AnimatePresence } from 'framer-motion'

interface FunnelAnimationProps {
    deposit: any
    asset: string
    onClose: () => void
}

export const FunnelAnimation = React.memo(({ deposit, asset, onClose }: FunnelAnimationProps) => {
    const ltv = deposit.ltv || deposit.max_ltv || '0'
    const maxBorrowLtv = deposit.max_borrow_ltv || '0'

    // Convert to strings if they're objects (BigNumber, etc.)
    const ltvStr = typeof ltv === 'object' ? (ltv?.toString?.() || String(ltv)) : String(ltv)
    const maxBorrowLtvStr = typeof maxBorrowLtv === 'object' ? (maxBorrowLtv?.toString?.() || String(maxBorrowLtv)) : String(maxBorrowLtv)

    return (
        <AnimatePresence>
            <Box
                position="absolute"
                right="-400px"
                top="0"
                w="350px"
                p={4}
                bg="whiteAlpha.100"
                border="1px solid"
                borderColor="whiteAlpha.300"
                borderRadius="md"
                zIndex={10}
            >
                <VStack align="start" spacing={3}>
                    <Text fontSize="lg" fontWeight="bold">
                        Distribution Group
                    </Text>
                    <Text fontSize="sm" color="whiteAlpha.700">
                        LTV: {ltvStr} | Max Borrow: {maxBorrowLtvStr}
                    </Text>

                    {/* Funnel visualization */}
                    <Box w="100%" position="relative" h="200px">
                        <motion.div
                            initial={{ scaleX: 0, originX: 0 }}
                            animate={{ scaleX: 1 }}
                            exit={{ scaleX: 0 }}
                            transition={{ duration: 0.5, ease: "easeOut" }}
                            style={{
                                position: 'absolute',
                                left: 0,
                                top: '50%',
                                width: '100%',
                                height: '2px',
                                background: 'linear-gradient(to right, #3182ce, transparent)',
                                transform: 'translateY(-50%)',
                            }}
                        />

                        {/* Distribution bars */}
                        <VStack spacing={2} mt={4}>
                            <Box w="100%" h="20px" bg="blue.400" borderRadius="sm">
                                <Text fontSize="xs" p={1}>Your Deposit</Text>
                            </Box>
                            <Box w="80%" h="20px" bg="blue.300" borderRadius="sm" opacity={0.7}>
                                <Text fontSize="xs" p={1}>Other Deposits</Text>
                            </Box>
                            <Box w="60%" h="20px" bg="blue.200" borderRadius="sm" opacity={0.5}>
                                <Text fontSize="xs" p={1}>Locked Deposits</Text>
                            </Box>
                        </VStack>
                    </Box>

                    <Text fontSize="xs" color="whiteAlpha.600" mt={4}>
                        This shows how your deposit fits within the LTV/borrow LTV group distribution
                    </Text>
                </VStack>
            </Box>
        </AnimatePresence>
    )
})

FunnelAnimation.displayName = 'FunnelAnimation'

