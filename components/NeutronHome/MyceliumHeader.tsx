import React from 'react';
import { VStack, Stack, HStack, Text, Image } from '@chakra-ui/react';

interface MyceliumHeaderProps {
    large?: boolean;
    logoToShow: string;
    symbol: string;
}

const MyceliumHeader: React.FC<MyceliumHeaderProps> = ({ large, logoToShow, symbol }) => {
    return (
        <VStack>
            <Stack direction={{ base: 'column', md: 'row' }} align="center" spacing={large ? 5 : 3} mb={large ? 0 : 0} w="auto" minW="fit-content">
                {logoToShow && <Image src={logoToShow} alt={symbol} boxSize={large ? "48px" : "32px"} flexShrink={0} loading="lazy" decoding="async" />}
                <Text fontWeight="bold" fontSize={large ? "4xl" : "2xl"} color="white" textAlign={{ base: 'center', md: undefined }} whiteSpace={{ base: 'nowrap', md: 'normal' }}>Mycelium</Text>
            </Stack>
            {/* Helper text under title */}
            <HStack spacing={2} align="center" justify="center">
                <Text color="whiteAlpha.700" fontSize="sm" mt={1} mb={-2} display={{ base: 'block', md: 'block' }}>
                    Boost your yield bearing collateral to compound exponentially faster
                </Text>
                <Text
                    color="#3b82f6"
                    fontSize="sm"
                    cursor="pointer"
                    mt={1}
                    mb={-2}
                    _hover={{ textDecoration: 'underline' }}
                    onClick={() => {
                        const faqSection = document.getElementById('faq-section');
                        if (faqSection) {
                            faqSection.scrollIntoView({ behavior: 'smooth' });
                        }
                    }}
                >
                    FAQ
                </Text>
            </HStack>
        </VStack>
    );
};

export default MyceliumHeader;
