import React from 'react'
import { Box, VStack, Text, Image } from '@chakra-ui/react'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'

interface StorefrontRulesSectionProps {
    scanComplete: boolean
    isScanning: boolean
    scannerRef: React.RefObject<HTMLDivElement>
    onTOSOpen: () => void
    handleScannerMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => void
    handleScannerMouseLeave: () => void
    handleScannerClick: (e: React.MouseEvent<HTMLDivElement>) => void
    handleScannerKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
}

// The pre-scan "rules" panel: neon sign, the vow / TOS text, scan
// instructions, and the hoverable/clickable/keyboard-activatable scanner.
// Rendered by StorefrontView only while !scanComplete.
export const StorefrontRulesSection = ({
    scanComplete,
    isScanning,
    scannerRef,
    onTOSOpen,
    handleScannerMouseEnter,
    handleScannerMouseLeave,
    handleScannerClick,
    handleScannerKeyDown,
}: StorefrontRulesSectionProps) => {
    return (
        <VStack spacing={4} position="relative" zIndex={2} mb={8} maxW="800px" w="100%" px={4} mt={8}>
            <Box
                bg="#09090a"
                border="2px solid"
                borderColor="#9bdc4f50"
                borderRadius="md"
                py={24}
                px={6}
                w="fit-content"
                mx="auto"
            >
                <VStack spacing={8} align="stretch">
                    {/* Neon Sign */}
                    <VStack spacing={4} position="relative" zIndex={2} mb={{ base: 12, md: 24 }}>
                        <Box
                            className="neonSignon"
                            letterSpacing="wider"
                            textAlign="center"
                            display="flex"
                            flexDirection={{ base: "column" }}
                            justifyContent="center"
                            alignItems="center"
                            gap={{ base: 0, md: "0.2em" }}
                            as="div"
                        >
                            <b style={{ display: "flex" }}>
                                <span>T</span>
                                <span>H</span>
                                <span>E</span>
                                <span style={{ marginRight: '0.2em', width: '0.2em' }}> </span>
                            </b>
                            <b style={{ display: "flex" }}>
                                <i style={{ display: "inline-block", fontSize: "clamp(75px, 4vh, 4vh)", fontStyle: "normal" }}>M</i>
                                <span>E</span>
                                <span>M</span>
                                <i style={{ display: "inline-block", fontSize: "clamp(75px, 4vh, 4vh)", fontStyle: "normal" }}>B</i>
                                <i style={{ display: "inline-block", fontSize: "clamp(75px, 4vh, 4vh)", fontStyle: "normal" }}>R</i>
                                <span>A</span>
                                <i style={{ display: "inline-block", fontSize: "clamp(75px, 4vh, 4vh)", fontStyle: "normal" }}>N</i>
                                <span>E</span>
                            </b>
                        </Box>
                    </VStack>

                    {/* TOS Text */}
                    <VStack spacing={1} align="stretch" position="relative" zIndex={2}>
                        <Text
                            fontSize={{ base: "sm", md: "md" }}
                            color="#ece6d8"
                            textAlign="left"
                            lineHeight="1.8"
                            fontFamily="mono"
                            letterSpacing="0.08em"
                            textShadow="0 0 8px rgba(70, 211, 154, 0.8), 0 0 15px rgba(155, 220, 79, 0.6)"
                        >
                            I approach as a sovereign soul, claiming my own risks and severing foreign ties.
                        </Text>
                        <Text
                            fontSize={{ base: "sm", md: "md" }}
                            color="#ece6d8"
                            textAlign="left"
                            lineHeight="1.8"
                            fontFamily="mono"
                            letterSpacing="0.08em"
                            textShadow="0 0 8px rgba(70, 211, 154, 0.8), 0 0 15px rgba(155, 220, 79, 0.6)"
                        >
                            I accept that every action I take becomes an immutable ripple through time.
                        </Text>
                        <Text
                            fontSize={{ base: "sm", md: "md" }}
                            color="#ece6d8"
                            textAlign="left"
                            lineHeight="1.8"
                            fontFamily="mono"
                            letterSpacing="0.08em"
                            textShadow="0 0 8px rgba(70, 211, 154, 0.8), 0 0 15px rgba(155, 220, 79, 0.6)"
                        >
                            If I break this vow, the consequences fall solely upon me.
                        </Text>
                        <Text
                            fontSize={{ base: "sm", md: "md" }}
                            color="#ece6d8"
                            textAlign="left"
                            lineHeight="1.8"
                            fontFamily="mono"
                            letterSpacing="0.08em"
                            textShadow="0 0 8px rgba(70, 211, 154, 0.8), 0 0 15px rgba(155, 220, 79, 0.6)"
                        >
                            My steps are my fingerprint.
                        </Text>
                        <Text
                            fontSize={{ base: "sm", md: "md" }}
                            color="#ece6d8"
                            textAlign="left"
                            lineHeight="1.8"
                            fontFamily="mono"
                            letterSpacing="0.08em"
                            textShadow="0 0 8px rgba(70, 211, 154, 0.8), 0 0 15px rgba(155, 220, 79, 0.6)"
                        >
                            Once inside, there is no return.
                        </Text>
                        <Text
                            fontSize={{ base: "sm", md: "md" }}
                            color="#ece6d8"
                            textAlign="left"
                            lineHeight="1.8"
                            fontFamily="mono"
                            letterSpacing="0.08em"
                            textShadow="0 0 8px rgba(70, 211, 154, 0.8), 0 0 15px rgba(155, 220, 79, 0.6)"
                        >
                            Within, we are the Membrane.
                        </Text>
                    </VStack>

                    {/* Scan Instructions */}
                    <VStack spacing={0} mt={6}>
                        <Text
                            fontSize={{ base: "md", md: "lg" }}
                            color="#46d39a"
                            textAlign="center"
                            letterSpacing="wider"
                            fontWeight="bold"
                            mb={2}
                        >
                            Initiate Scan to Accept the{' '}
                            <Text
                                as="span"
                                color="#46d39a"
                                cursor="pointer"
                                textDecoration="underline"
                                _hover={{
                                    color: '#9bdc4f',
                                    textShadow: '0 0 10px #46d39a',
                                }}
                                onClick={onTOSOpen}
                                transition="all 0.3s"
                            >
                                Terms
                            </Text>
                        </Text>
                        <Text
                            fontSize={{ base: "xs", md: "sm" }}
                            color="#8d877b"
                            fontStyle="italic"
                            textAlign="end"
                        >
                            Scan completion activates the Contract.
                        </Text>
                        <Text
                            fontSize={{ base: "xs", md: "sm" }}
                            color="#8d877b"
                            fontStyle="italic"
                            textAlign="end"
                        >
                            Includes acceptance of essential, analytics, and functional cookies.
                        </Text>
                    </VStack>

                    {/* Cursor Scanner - Inside rules box */}
                    <Box
                        position="relative"
                        zIndex={3}
                        w="100%"
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                    // mt={4}
                    >
                        <Box
                            position="relative"
                            css={{
                                animation: 'scannerGlow 2s ease-in-out infinite',
                            }}
                        >
                            <Image
                                src="/images/cursor-scanner.svg"
                                alt="Scanner"
                                w="75px"
                                h="75px"
                                objectFit="contain"
                                pointerEvents="none"
                            />
                        </Box>
                        {/* 40px activation area in the center - hoverable, clickable/tappable,
                                and keyboard-activatable (Enter/Space) so the scan is reliably completable */}
                        <Box
                            ref={scannerRef}
                            position="absolute"
                            w="16px"
                            h="24px"
                            cursor="pointer"
                            tabIndex={scanComplete ? -1 : 0}
                            role="button"
                            aria-label={
                                scanComplete
                                    ? 'Identity scan complete'
                                    : isScanning
                                        ? 'Scanning in progress'
                                        : 'Hover, click, or press Enter to scan and accept the vow'
                            }
                            aria-pressed={isScanning || scanComplete}
                            onMouseEnter={handleScannerMouseEnter}
                            onMouseLeave={handleScannerMouseLeave}
                            onClick={handleScannerClick}
                            onKeyDown={handleScannerKeyDown}
                            left="50%"
                            top="50%"
                            transform="translate(-50%, -50%)"
                            borderRadius="sm"
                            transition={TRANSITIONS.shadow}
                            _focus={FOCUS_STYLES.ringCyan}
                            _focusVisible={FOCUS_STYLES.ringCyan}
                        />
                    </Box>
                </VStack>
            </Box>
        </VStack>
    )
}
