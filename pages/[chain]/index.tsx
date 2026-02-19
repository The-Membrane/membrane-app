import Home from '@/components/Home/Home'
import React from 'react'
import dynamic from 'next/dynamic'
import { useChainRoute } from '@/hooks/useChainRoute'
import { Box, Text, VStack } from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'

const NeutronHome = dynamic(() => import('@/components/NeutronHome').then(m => m.default || m.NeutronHome), { ssr: false })

// Base home page for non-neutron chains
const BaseHome = () => {
    return (
        <Box minH="100vh" bg="#091326" display="flex" alignItems="center" justifyContent="center">
            <VStack spacing={4}>
                <Text fontSize={TYPOGRAPHY.h1} fontWeight={TYPOGRAPHY.bold} color="white">Membrane Protocol</Text>
                <Text fontSize="md" color="gray.400">Welcome to the Membrane</Text>
            </VStack>
        </Box>
    )
}

const IndexPage = () => {
    const { chainName } = useChainRoute()
    if (chainName === 'neutron') {
    return <Home />
    }
    return <BaseHome />
}

export default IndexPage
