import React, { useRef, useState, useEffect, useMemo } from 'react'
import {
    Modal,
    ModalOverlay,
    ModalContent,
    ModalHeader,
    ModalBody,
    ModalCloseButton,
    VStack,
    HStack,
    Button,
    Text,
    useToast,
    Box,
    Tabs,
    TabList,
    Tab,
    TabPanels,
    TabPanel,
} from '@chakra-ui/react'
import { DownloadIcon, CopyIcon } from '@chakra-ui/icons'
import { FaTwitter } from 'react-icons/fa'
import { RevenueCard } from './CardTypes/RevenueCard'
import { BoostCard } from './CardTypes/BoostCard'
import { ContributionCard } from './CardTypes/ContributionCard'
import { PointsCard } from './CardTypes/PointsCard'
import { PortfolioCard } from './CardTypes/PortfolioCard'
import useShareableCard from '@/hooks/useShareableCard'
import { exportElementAsImage, copyElementToClipboard, getTwitterShareUrl } from '@/services/shareableCard'
import type { CardType } from '@/services/shareableCard'

interface ShareModalProps {
    isOpen: boolean
    onClose: () => void
    initialCardType?: CardType
}

const cardTabs: { type: CardType; label: string }[] = [
    { type: 'revenue', label: 'Revenue' },
    { type: 'boost', label: 'Boost' },
    { type: 'contribution', label: 'Contribution' },
    { type: 'points', label: 'Points' },
    { type: 'portfolio', label: 'Portfolio' },
]

export const ShareModal: React.FC<ShareModalProps> = ({ isOpen, onClose, initialCardType = 'portfolio' }) => {
    const [activeTab, setActiveTab] = useState(cardTabs.findIndex(t => t.type === initialCardType) || 0)
    const [isExporting, setIsExporting] = useState(false)
    const [isCopying, setIsCopying] = useState(false)
    const [isCardReady, setIsCardReady] = useState(false)
    const cardRef = useRef<HTMLDivElement>(null)
    const toast = useToast()

    // Always call hook with a stable value to ensure hooks are called consistently
    const { cardData } = useShareableCard('portfolio')

    // Check if card is ready after render
    useEffect(() => {
        if (isOpen) {
            // Wait for card to be fully rendered
            const timer = setTimeout(() => {
                // The cardRef should be attached to the ShareableCard Box element
                if (cardRef.current && cardRef.current.offsetWidth > 0 && cardRef.current.offsetHeight > 0) {
                    setIsCardReady(true)
                } else {
                    setIsCardReady(false)
                }
            }, 200)
            return () => clearTimeout(timer)
        } else {
            setIsCardReady(false)
        }
    }, [isOpen, activeTab, cardRef])

    const handleExport = async () => {
        // cardRef should be attached to the ShareableCard Box element
        if (!cardRef.current) {
            toast({
                title: 'Error',
                description: 'Card element not found. Please wait for the card to load.',
                status: 'error',
                duration: 3000,
            })
            return
        }

        // Verify card has dimensions
        if (cardRef.current.offsetWidth === 0 || cardRef.current.offsetHeight === 0) {
            toast({
                title: 'Error',
                description: 'Card is not visible. Please wait for the card to render.',
                status: 'error',
                duration: 3000,
            })
            return
        }
        
        setIsExporting(true)
        try {
            // Wait a bit more to ensure everything is rendered
            await new Promise(resolve => setTimeout(resolve, 300))
            
            const filename = `membrane-${cardTabs[activeTab].type}-${Date.now()}.png`
            await exportElementAsImage(cardRef.current, filename)
            toast({
                title: 'Image downloaded!',
                description: 'Your achievement card has been saved.',
                status: 'success',
                duration: 3000,
            })
        } catch (error) {
            console.error('Export error:', error)
            toast({
                title: 'Export failed',
                description: 'Could not export the image. Please try again.',
                status: 'error',
                duration: 3000,
            })
        } finally {
            setIsExporting(false)
        }
    }

    const handleCopy = async () => {
        // cardRef should be attached to the ShareableCard Box element
        if (!cardRef.current) {
            toast({
                title: 'Error',
                description: 'Card element not found. Please wait for the card to load.',
                status: 'error',
                duration: 3000,
            })
            return
        }

        // Verify card has dimensions
        if (cardRef.current.offsetWidth === 0 || cardRef.current.offsetHeight === 0) {
            toast({
                title: 'Error',
                description: 'Card is not visible. Please wait for the card to render.',
                status: 'error',
                duration: 3000,
            })
            return
        }
        
        setIsCopying(true)
        try {
            // Wait a bit more to ensure everything is rendered
            await new Promise(resolve => setTimeout(resolve, 300))
            
            const success = await copyElementToClipboard(cardRef.current)
            if (success) {
                toast({
                    title: 'Copied to clipboard!',
                    description: 'Paste the image anywhere.',
                    status: 'success',
                    duration: 3000,
                })
            } else {
                throw new Error('Copy failed')
            }
        } catch (error) {
            console.error('Copy error:', error)
            toast({
                title: 'Copy failed',
                description: 'Could not copy to clipboard. Try downloading instead.',
                status: 'error',
                duration: 3000,
            })
        } finally {
            setIsCopying(false)
        }
    }

    const handleTwitterShare = () => {
        const currentCardType = cardTabs[activeTab].type
        const defaultTexts: Record<CardType, string> = {
            revenue: `I've earned $${cardData.totalRevenue?.toFixed(2)} on Membrane! 🚀`,
            boost: `My Membrane boost is at ${cardData.boostPercentage?.toFixed(2)}%! 📈`,
            contribution: `I'm a ${cardData.tier} on Membrane with ${cardData.contributionPercentage?.toFixed(2)}% contribution! 💪`,
            points: `Rank #${cardData.rank} on Membrane with ${cardData.totalPoints?.toFixed(0)} points! 🏆`,
            portfolio: `Check out my Membrane portfolio! 🔥`,
        }
        const text = defaultTexts[currentCardType] || 'Check out my Membrane stats!'
        window.open(getTwitterShareUrl(text, 'https://membrane.fi'), '_blank')
    }

    // Track previous data to avoid logging spam
    const prevDataRef = useRef<string>('')
    
    // Only log when data actually changes
    useEffect(() => {
        if (process.env.NODE_ENV === 'development') {
            const dataString = JSON.stringify(cardData)
            if (prevDataRef.current !== dataString) {
                const currentType = cardTabs[activeTab].type
                console.log('Rendering card:', currentType, 'Data:', cardData)
                prevDataRef.current = dataString
            }
        }
    }, [cardData, activeTab])

    const renderCard = useMemo(() => {
        const currentType = cardTabs[activeTab].type
        const props = { data: cardData, cardRef }

        switch (currentType) {
            case 'revenue':
                return <RevenueCard {...props} />
            case 'boost':
                return <BoostCard {...props} />
            case 'contribution':
                return <ContributionCard {...props} />
            case 'points':
                return <PointsCard {...props} />
            case 'portfolio':
            default:
                return <PortfolioCard {...props} />
        }
    }, [activeTab, cardData])

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="2xl" isCentered>
            <ModalOverlay bg="blackAlpha.800" backdropFilter="blur(10px)" />
            <ModalContent 
                bg="gray.900" 
                border="1px solid" 
                borderColor="purple.500" 
                borderRadius="xl"
                maxW="800px"
            >
                <ModalHeader color="white" fontFamily="mono" textTransform="uppercase" letterSpacing="wide">
                    Share Achievement
                </ModalHeader>
                <ModalCloseButton color="gray.400" />
                <ModalBody pb={6}>
                    <VStack spacing={4}>
                        {/* Card type tabs */}
                        <Tabs
                            index={activeTab}
                            onChange={setActiveTab}
                            variant="soft-rounded"
                            colorScheme="purple"
                            w="100%"
                        >
                            <TabList justifyContent="center" flexWrap="wrap" gap={1}>
                                {cardTabs.map((tab) => (
                                    <Tab
                                        key={tab.type}
                                        fontSize="xs"
                                        fontFamily="mono"
                                        px={3}
                                        py={1}
                                        color="gray.400"
                                        _selected={{ color: 'white', bg: 'purple.600' }}
                                    >
                                        {tab.label}
                                    </Tab>
                                ))}
                            </TabList>
                            <TabPanels>
                                {cardTabs.map((tab) => (
                                    <TabPanel key={tab.type} p={0} pt={4}>
                                        {/* Card is rendered below, outside tabs */}
                                    </TabPanel>
                                ))}
                            </TabPanels>
                        </Tabs>

                        {/* Card preview - rendered directly for capture */}
                        <Box
                            w="100%"
                            display="flex"
                            justifyContent="center"
                            alignItems="center"
                            overflow="visible"
                            borderRadius="xl"
                            p={2}
                            bg="gray.900"
                            minH="350px"
                        >
                            {renderCard}
                        </Box>

                        {/* Action buttons */}
                        <VStack spacing={3} w="100%">
                            <HStack spacing={3} w="100%">
                                <Button
                                    flex={1}
                                    leftIcon={<DownloadIcon />}
                                    colorScheme="purple"
                                    variant="solid"
                                    onClick={handleExport}
                                    isLoading={isExporting}
                                    fontFamily="mono"
                                    size="sm"
                                    isDisabled={!isCardReady}
                                >
                                    Download
                                </Button>
                                <Button
                                    flex={1}
                                    leftIcon={<CopyIcon />}
                                    colorScheme="cyan"
                                    variant="outline"
                                    onClick={handleCopy}
                                    isLoading={isCopying}
                                    fontFamily="mono"
                                    size="sm"
                                    isDisabled={!isCardReady}
                                >
                                    Copy
                                </Button>
                            </HStack>

                            <Button
                                w="100%"
                                leftIcon={<FaTwitter />}
                                bg="#1DA1F2"
                                color="white"
                                _hover={{ bg: '#1a8cd8' }}
                                onClick={handleTwitterShare}
                                fontFamily="mono"
                                size="md"
                            >
                                Share on Twitter
                            </Button>

                            <Text fontSize="xs" color="gray.500" fontFamily="mono" textAlign="center">
                                Download or copy the image, then paste it into your Twitter post
                            </Text>
                        </VStack>
                    </VStack>
                </ModalBody>
            </ModalContent>
        </Modal>
    )
}

export default ShareModal


