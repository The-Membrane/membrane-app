import React, { useState, useMemo } from 'react'
import { VStack, Box, Text, HStack, Collapse, Icon, Tabs, TabList, Tab } from '@chakra-ui/react'
import { ChevronDownIcon } from '@chakra-ui/icons'
import { Music, Zap, ArrowLeftRight, Lock, Wallet } from 'lucide-react'
import { FAQItem } from '../hooks/usePageTutorial'

// Consolidated FAQs from all pages
const allFAQs: Record<string, { icon: any; color: string; items: FAQItem[] }> = {
    disco: {
        icon: Music,
        color: 'purple.400',
        items: [
            {
                id: 'what-is-disco',
                question: 'What is Disco and LTV Discovery?',
                answer: 'Disco is the LTV Discovery protocol that allows users to deposit collateral at different LTV (Loan-to-Value) levels. The protocol discovers optimal LTV ratios through market dynamics, and users who participate in discovery and absorb bad debt first are rewarded with CDT tokens.',
            },
            {
                id: 'how-liquidation-works',
                question: 'How does liquidation work?',
                answer: 'When the value of your collateral drops below the liquidation LTV threshold, your position can be liquidated. Liquidators can claim a portion of your collateral as a reward. Higher liquidation LTV means positions are liquidated earlier, which provides more protection but may reduce potential yield.',
            },
            {
                id: 'what-are-risks-disco',
                question: 'What are the risks?',
                answer: 'The main risks include liquidation if collateral value drops below the liquidation LTV, smart contract risks, and market volatility. Higher LTV positions offer higher potential yield but come with increased liquidation risk. Always understand the risks before depositing.',
            },
            {
                id: 'how-to-deposit-disco',
                question: 'How do I deposit to Disco?',
                answer: 'Select your desired LTV pair (liquidation LTV and borrow LTV) using the carousels. Click on a deposit form and specify the amount you want to deposit. Your deposit will be allocated to the selected LTV tranche.',
            },
            {
                id: 'yield-calculation',
                question: 'How is yield calculated?',
                answer: 'Yield is generated from various sources including protocol revenue, liquidation fees, and other mechanisms. The yield range shown represents the estimated annual percentage rate (APR) based on historical performance. Actual yields may vary based on market conditions.',
            },
        ],
    },
    manic: {
        icon: Zap,
        color: 'cyan.400',
        items: [
            {
                id: 'what-is-manic',
                question: 'What is Manic?',
                answer: 'Manic is a leveraged yield vault that automatically loops your USDC deposits to maximize returns. It uses the Transmuter for efficient looping and compounds your position automatically.',
            },
            {
                id: 'how-looping-works',
                question: 'How does looping work?',
                answer: 'Looping increases your exposure by borrowing against your collateral and redepositing. Each loop level multiplies your yield but also increases risk. The system automatically manages the loop levels based on your settings.',
            },
            {
                id: 'manic-risks',
                question: 'What are the risks of Manic?',
                answer: 'Higher loop levels mean higher APR but also higher liquidation risk if rates change unfavorably. The position can be liquidated if your collateral value drops below the required threshold. Monitor your risk score regularly.',
            },
            {
                id: 'manic-capacity',
                question: 'What is loop capacity?',
                answer: 'Loop capacity is the amount of liquidity available in the Transmuter for looping operations. If capacity is low, new loops may fail or be limited. Capacity is restored as users swap or deposit.',
            },
            {
                id: 'manic-boost',
                question: 'How does boost work?',
                answer: 'Your boost level increases your Manic yields based on your total MBRN locked in LTV Disco. The boost percentage equals your MBRN amount as a percentage of 100M MBRN (e.g., 30M MBRN = 30% boost).',
            },
        ],
    },
    transmuter: {
        icon: ArrowLeftRight,
        color: 'blue.400',
        items: [
            {
                id: 'what-is-transmuter',
                question: 'What is the Transmuter?',
                answer: 'The Transmuter is a swap facility that allows 1:1 exchanges between CDT (the protocol stablecoin) and USDC. It provides liquidity for Manic looping and other protocol operations.',
            },
            {
                id: 'transmuter-capacity',
                question: 'What is swap capacity?',
                answer: 'Swap capacity represents the available liquidity for swaps in each direction. When capacity is depleted, swaps in that direction are unavailable until liquidity is restored through reverse swaps or deposits.',
            },
            {
                id: 'transmuter-fees',
                question: 'Are there fees for swapping?',
                answer: 'The Transmuter typically offers 1:1 swaps with minimal fees. Any fees collected go to protocol revenue and are distributed to stakers.',
            },
        ],
    },
    lockdrop: {
        icon: Lock,
        color: 'purple.400',
        items: [
            {
                id: 'what-is-lockdrop',
                question: 'What is the Lockdrop?',
                answer: 'The Lockdrop is a special event where users can lock USDC to earn MBRN allocations. The longer you lock, the more MBRN you receive. Lockdrop allocations vest over time.',
            },
            {
                id: 'lockdrop-claiming',
                question: 'When can I claim my MBRN?',
                answer: 'MBRN from the lockdrop can be claimed after the vesting period ends. You will receive a notification when your allocation is ready to claim.',
            },
            {
                id: 'lockdrop-withdrawing',
                question: 'Can I withdraw early?',
                answer: 'Locked USDC cannot be withdrawn before the lock period ends. Make sure you understand the lock duration before participating in the lockdrop.',
            },
        ],
    },
    portfolio: {
        icon: Wallet,
        color: 'green.400',
        items: [
            {
                id: 'what-is-portfolio',
                question: 'What does the Portfolio show?',
                answer: 'The Portfolio page shows an overview of all your positions across the protocol, including Manic, Disco, and Transmuter. It displays your total value, earnings, and boost level.',
            },
            {
                id: 'revenue-tracking',
                question: 'How is revenue tracked?',
                answer: 'Revenue is tracked in real-time as your positions generate yield. The revenue chart shows your historical earnings and current rate.',
            },
            {
                id: 'boost-level',
                question: 'What is boost level?',
                answer: 'Your boost level is determined by your MBRN locked in LTV Disco. Higher boost levels increase your yields across the protocol. The boost percentage equals your MBRN as a percentage of 100M MBRN.',
            },
        ],
    },
}

const categoryOrder = ['disco', 'manic', 'transmuter', 'lockdrop', 'portfolio']

export const LearnTab: React.FC = () => {
    const [selectedCategory, setSelectedCategory] = useState<string>('disco')
    const [openItems, setOpenItems] = useState<Set<string>>(new Set())

    const currentFAQs = useMemo(() => {
        return allFAQs[selectedCategory]?.items || []
    }, [selectedCategory])

    const toggleItem = (id: string) => {
        setOpenItems(prev => {
            const newSet = new Set(prev)
            if (newSet.has(id)) {
                newSet.delete(id)
            } else {
                // Close others, open this one
                newSet.clear()
                newSet.add(id)
            }
            return newSet
        })
    }

    return (
        <VStack spacing={3} align="stretch" p={3} h="100%" overflowY="auto">
            {/* Category Tabs */}
            <Box overflowX="auto" pb={2}>
                <Tabs
                    variant="unstyled"
                    index={categoryOrder.indexOf(selectedCategory)}
                    onChange={(index) => setSelectedCategory(categoryOrder[index])}
                >
                    <TabList gap={1}>
                        {categoryOrder.map((category) => {
                            const config = allFAQs[category]
                            const isSelected = selectedCategory === category
                            return (
                                <Tab
                                    key={category}
                                    px={3}
                                    py={1.5}
                                    borderRadius="md"
                                    fontSize="xs"
                                    fontWeight="medium"
                                    textTransform="capitalize"
                                    color={isSelected ? config.color : '#F5F5F580'}
                                    bg={isSelected ? `${config.color}20` : 'transparent'}
                                    border="1px solid"
                                    borderColor={isSelected ? config.color : 'transparent'}
                                    _hover={{
                                        bg: isSelected ? undefined : '#6943FF10',
                                    }}
                                    transition="all 0.2s"
                                >
                                    <HStack spacing={1}>
                                        <Icon as={config.icon} w={3} h={3} />
                                        <Text>{category}</Text>
                                    </HStack>
                                </Tab>
                            )
                        })}
                    </TabList>
                </Tabs>
            </Box>

            {/* FAQ Items */}
            <VStack spacing={2} align="stretch">
                {currentFAQs.map((item) => {
                    const isOpen = openItems.has(item.id)
                    return (
                        <Box
                            key={item.id}
                            bg="#1A1D26"
                            border="1px solid"
                            borderColor={isOpen ? '#6943FF60' : '#6943FF20'}
                            borderRadius="lg"
                            overflow="hidden"
                            transition="all 0.2s"
                        >
                            <HStack
                                p={3}
                                justify="space-between"
                                align="center"
                                cursor="pointer"
                                onClick={() => toggleItem(item.id)}
                                _hover={{ bg: '#1E2130' }}
                            >
                                <Text fontSize="sm" color="#F5F5F5" fontWeight="medium" flex={1}>
                                    {item.question}
                                </Text>
                                <Icon
                                    as={ChevronDownIcon}
                                    w={5}
                                    h={5}
                                    color="#F5F5F540"
                                    transform={isOpen ? 'rotate(180deg)' : 'rotate(0deg)'}
                                    transition="transform 0.2s"
                                />
                            </HStack>
                            <Collapse in={isOpen} animateOpacity>
                                <Box
                                    p={3}
                                    pt={0}
                                    borderTop="1px solid"
                                    borderColor="#6943FF20"
                                >
                                    <Text fontSize="xs" color="#F5F5F580" lineHeight="1.6">
                                        {item.answer}
                                    </Text>
                                </Box>
                            </Collapse>
                        </Box>
                    )
                })}
            </VStack>

            {currentFAQs.length === 0 && (
                <Box textAlign="center" py={6}>
                    <Text fontSize="sm" color="#F5F5F580">
                        No FAQs available for this category
                    </Text>
                </Box>
            )}
        </VStack>
    )
}

export default LearnTab





