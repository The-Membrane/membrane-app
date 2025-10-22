import React, { useState } from 'react';
import { Box, VStack, Text, HStack, Collapse, Icon } from '@chakra-ui/react';
import { ChevronDownIcon } from '@chakra-ui/icons';

const FAQ: React.FC = () => {
    // FAQ state for collapsible functionality
    const [openFaqItems, setOpenFaqItems] = useState<Set<number>>(new Set());

    const toggleFaqItem = (index: number) => {
        setOpenFaqItems(prev => {
            const newSet = new Set(prev);
            if (newSet.has(index)) {
                newSet.delete(index);
            } else {
                newSet.add(index);
            }
            return newSet;
        });
    };

    return (
        <Box id="faq-section" w="100%" maxW="700px" mt={6} mb={16}>
            <VStack spacing={4} w="100%">
                <Text color="white" fontSize="lg" fontWeight="semibold" textAlign="center" py={2}>
                    Frequently Asked Questions
                </Text>

                <VStack spacing={3} w="100%">
                    {/* FAQ Item 1 */}
                    <Box w="100%" bg="#1a2330" borderRadius="md" border="1px solid #2b3544">
                        <Box
                            p={4}
                            cursor="pointer"
                            _hover={{ bg: '#1f2937' }}
                            onClick={() => toggleFaqItem(0)}
                        >
                            <HStack justify="space-between" align="center">
                                <Text color="white" fontWeight="semibold">
                                    What is Mycelium and how does it work?
                                </Text>
                                <Icon
                                    as={ChevronDownIcon}
                                    color="whiteAlpha.600"
                                    boxSize={4}
                                    transform={openFaqItems.has(0) ? 'rotate(180deg)' : 'rotate(0deg)'}
                                    transition="transform 0.2s"
                                />
                            </HStack>
                        </Box>
                        <Collapse in={openFaqItems.has(0)}>
                            <Box p={4} pt={0}>
                                <Text color="whiteAlpha.700" fontSize="sm" lineHeight="1.6">
                                    Mycelium is a yield-boosting protocol that allows you to leverage your yield-bearing collateral
                                    to compound your returns exponentially faster. By borrowing against your assets at optimal LTV ratios,
                                    you can deploy additional capital into high-yield venues while maintaining your original position.
                                </Text>
                            </Box>
                        </Collapse>
                    </Box>

                    {/* FAQ Item 2 */}
                    <Box w="100%" bg="#1a2330" borderRadius="md" border="1px solid #2b3544">
                        <Box
                            p={4}
                            cursor="pointer"
                            _hover={{ bg: '#1f2937' }}
                            onClick={() => toggleFaqItem(1)}
                        >
                            <HStack justify="space-between" align="center">
                                <Text color="white" fontWeight="semibold">
                                    What are the risks involved?
                                </Text>
                                <Icon
                                    as={ChevronDownIcon}
                                    color="whiteAlpha.600"
                                    boxSize={4}
                                    transform={openFaqItems.has(1) ? 'rotate(180deg)' : 'rotate(0deg)'}
                                    transition="transform 0.2s"
                                />
                            </HStack>
                        </Box>
                        <Collapse in={openFaqItems.has(1)}>
                            <Box p={4} pt={0}>
                                <Text color="whiteAlpha.700" fontSize="sm" lineHeight="1.6">
                                    The main risks include liquidation if your collateral value drops below the minimum health factor,
                                    smart contract risks, and market volatility. We recommend starting with conservative LTV ratios
                                    and monitoring your positions regularly.
                                </Text>
                            </Box>
                        </Collapse>
                    </Box>

                    {/* FAQ Item 3 */}
                    <Box w="100%" bg="#1a2330" borderRadius="md" border="1px solid #2b3544">
                        <Box
                            p={4}
                            cursor="pointer"
                            _hover={{ bg: '#1f2937' }}
                            onClick={() => toggleFaqItem(2)}
                        >
                            <HStack justify="space-between" align="center">
                                <Text color="white" fontWeight="semibold">
                                    How do I choose the right venue?
                                </Text>
                                <Icon
                                    as={ChevronDownIcon}
                                    color="whiteAlpha.600"
                                    boxSize={4}
                                    transform={openFaqItems.has(2) ? 'rotate(180deg)' : 'rotate(0deg)'}
                                    transition="transform 0.2s"
                                />
                            </HStack>
                        </Box>
                        <Collapse in={openFaqItems.has(2)}>
                            <Box p={4} pt={0}>
                                <Text color="whiteAlpha.700" fontSize="sm" lineHeight="1.6">
                                    Consider factors like APR, TVL (Total Value Locked), protocol reputation, and your risk tolerance.
                                    Higher APRs often come with higher risks. The chart above shows projected returns over 10 years
                                    to help you make informed decisions.
                                </Text>
                            </Box>
                        </Collapse>
                    </Box>

                    {/* FAQ Item 4 */}
                    <Box w="100%" bg="#1a2330" borderRadius="md" border="1px solid #2b3544">
                        <Box
                            p={4}
                            cursor="pointer"
                            _hover={{ bg: '#1f2937' }}
                            onClick={() => toggleFaqItem(3)}
                        >
                            <HStack justify="space-between" align="center">
                                <Text color="white" fontWeight="semibold">
                                    Can I withdraw my funds anytime?
                                </Text>
                                <Icon
                                    as={ChevronDownIcon}
                                    color="whiteAlpha.600"
                                    boxSize={4}
                                    transform={openFaqItems.has(3) ? 'rotate(180deg)' : 'rotate(0deg)'}
                                    transition="transform 0.2s"
                                />
                            </HStack>
                        </Box>
                        <Collapse in={openFaqItems.has(3)}>
                            <Box p={4} pt={0}>
                                <Text color="whiteAlpha.700" fontSize="sm" lineHeight="1.6">
                                    Yes, you can withdraw your collateral and close your position at any time, subject to paying back
                                    the borrowed amount plus any accrued interest. Keep in mind that closing positions may incur
                                    transaction fees and gas costs.
                                </Text>
                            </Box>
                        </Collapse>
                    </Box>
                </VStack>
            </VStack>
        </Box>
    );
};

export default FAQ;