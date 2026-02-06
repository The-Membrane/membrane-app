import React from 'react'
import { Box, Text, VStack } from '@chakra-ui/react'

interface EditTabProps {
    onClick: () => void
    isPanelOpen: boolean
}

export const EditTab: React.FC<EditTabProps> = ({ onClick, isPanelOpen }) => {
    return (
        <Box
            position="absolute"
            right="-60px"
            top="15%"
            transform="translateY(-50%)"
            w="43px"
            h="88px"
            bg="#0F1117"
            borderTopRightRadius="lg"
            borderBottomRightRadius="lg"
            borderTop="1px solid"
            borderBottom="1px solid"
            borderRight="1px solid"
            // borderLeft="1px solid"
            borderColor="purple.400"
            cursor="pointer"
            display="flex"
            alignItems="center"
            justifyContent="center"
            zIndex={0}
            opacity={isPanelOpen ? 0 : 1}
            pointerEvents={isPanelOpen ? 'none' : 'auto'}
            transition="all 0.2s ease-in-out"
            boxShadow="0 0 0px rgba(0, 191, 255, 0)"
            _hover={{
                bg: '#101722',
                borderColor: '#9F7AEA',
                boxShadow: '0 0 12px #9F7AEA, 0 0 20px #9F7AEA',
            }}
            onClick={onClick}
        >
            <VStack spacing={1} transform="rotate(90deg)" transformOrigin="center center">
                <Text
                    fontSize="xs"
                    fontWeight="semibold"
                    color="#A9D8FF"
                    lineHeight="1"
                >
                    ✎
                </Text>
                <Text
                    fontSize="sm"
                    fontWeight={700}
                    letterSpacing="0.1em"
                    color="#F5F5F5"
                    whiteSpace="nowrap"
                >
                    EDIT
                </Text>
            </VStack>
        </Box>
    )
}

