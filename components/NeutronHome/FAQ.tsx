import React, { useState, useRef, useEffect } from 'react';
import { Box, VStack, Text, HStack, Collapse, Icon } from '@chakra-ui/react';
import { ChevronDownIcon } from '@chakra-ui/icons';

const FAQ: React.FC = () => {
    // FAQ state for collapsible functionality
    const [openFaqItems, setOpenFaqItems] = useState<Set<number>>(new Set());
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);

    const toggleFaqItem = (index: number) => {
        // Clear any existing timeout
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }

        setOpenFaqItems(prev => {
            const newSet = new Set<number>();

            // If clicking on the same item that's open, close it
            if (prev.has(index)) {
                return newSet;
            }

            // If there's an item currently open, close it first
            if (prev.size > 0) {
                // Start closing animation immediately
                setOpenFaqItems(new Set<number>());

                // After closing animation completes, open the new item
                timeoutRef.current = setTimeout(() => {
                    setOpenFaqItems(new Set([index]));
                }, 200); // Match the Collapse transition duration

                return prev; // Return current state for immediate close
            } else {
                // No item is open, open the clicked item immediately
                newSet.add(index);
                return newSet;
            }
        });
    };

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, []);

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
                                    to compound your returns exponentially faster. By borrowing against your assets and deploying through Mycelium,
                                    your debt becomes automatically retractable to protect you from liquidations, converting debt risk into boosted yield earning potential.
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
                                    The main risk is liquidation, which is your collateral value dropping below the minimum health factor. In normal situations for Mycelium, liquidation risk is non-existent. But in the event that Mycelium's retraction fails to cover the debt, your collateral will be liquidated instead of simply retriving the deployed CDT.
                                    <br />
                                    <br />
                                    The debt retrieval can fail if the transmuter that is used to convert from CDT {'<>'} USDC is low on CDT due to withdrawals.
                                    <br />
                                    <br />
                                    For safety, we recommend starting with LTVs below 100% of the max in order to protect you from being scalped by ping-ponged liquidations. In the event of a ping-pong, even if Mycelium retracts and repays for you, your position still owes the liquidation executor a small fee.
                                    <br />
                                    <br />
                                    Additionally, the usual smart contract risks and market volatility.
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