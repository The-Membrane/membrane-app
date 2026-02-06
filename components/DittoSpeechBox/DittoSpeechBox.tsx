import React from 'react'
import { Box } from '@chakra-ui/react'
import { useDittoSpeechBox } from './hooks/useDittoSpeechBox'
import { DittoSpeechBoxSection } from './DittoSpeechBoxSection'
import { DiscoSection } from './sections/DiscoSection'
import { TransmuterSection } from './sections/TransmuterSection'
import { ManicSection } from './sections/ManicSection'
import { TransmuterLockdropSection } from './sections/TransmuterLockdropSection'
import { BoostSection } from './sections/BoostSection'
import { UpdatesSection } from './sections/UpdatesSection'
import { TxConfirmationSection } from './sections/TxConfirmationSection'
import { TutorialSection } from './sections/TutorialSection'
import { FAQSection } from './sections/FAQSection'
import { useTutorialContext } from './TutorialContext'
import { useTutorialStore } from './hooks/useTutorialStore'

// Note: This is the legacy DittoSpeechBox component
// The new DittoPanel component is the recommended UI
// This component is kept for backwards compatibility

interface DittoSpeechBoxProps {
    isVisible?: boolean
    isHovered?: boolean
}

export const DittoSpeechBox: React.FC<DittoSpeechBoxProps> = ({ isVisible = true, isHovered = false }) => {
    const { currentView, returnToHub, close, isClosed, isOpen, openFAQ, openTutorial, returnToPreviousView } = useDittoSpeechBox()

    // Always render when stayShown/isVisible is true, check isOpen for actual display
    if (!isVisible) return null

    // When speech box is closed, show nothing
    if (isClosed || !isOpen) return null

    return (
        <Box
            transform={isHovered && isOpen ? "scale(1.02)" : "scale(1)"}
            transformOrigin="bottom left"
            transition="transform 0.3s ease-in-out, opacity 0.3s ease-in-out"
            bg="#23252B"
            color="#F5F5F5"
            px={4}
            py={3}
            borderRadius="md"
            w="353px"
            minH="300px"
            maxH="450px"
            boxShadow="0 4px 12px rgba(0,0,0,0.5), 0 0 20px rgba(105, 67, 255, 0.3)"
            border="1px solid"
            borderColor="#6943FF40"
            zIndex={10000}
            overflow="hidden"
            display="flex"
            flexDirection="column"
            position="relative"
            _after={{
                content: '""',
                position: 'absolute',
                bottom: '-8px',
                left: '50px',
                width: 0,
                height: 0,
                borderLeft: '8px solid transparent',
                borderRight: '8px solid transparent',
                borderTop: '8px solid #23252B',
            }}
            _before={{
                content: '""',
                position: 'absolute',
                bottom: '-9px',
                left: '49px',
                width: 0,
                height: 0,
                borderLeft: '9px solid transparent',
                borderRight: '9px solid transparent',
                borderTop: '9px solid #6943FF40',
            }}
        >
            {currentView === 'disco' && (
                <DiscoSectionWithTutorial
                    onBack={returnToHub}
                    onClose={close}
                    openTutorial={openTutorial}
                    openFAQ={openFAQ}
                />
            )}
            {currentView === 'transmuter' && (
                <DittoSpeechBoxSection
                    title="Transmuter"
                    onBack={returnToHub}
                    onClose={close}
                >
                    <TransmuterSection onBack={returnToHub} />
                </DittoSpeechBoxSection>
            )}
            {currentView === 'manic' && (
                <DittoSpeechBoxSection
                    title="Manic"
                    onBack={returnToHub}
                    onClose={close}
                    titleColor="cyan.400"
                >
                    <ManicSection onBack={returnToHub} />
                </DittoSpeechBoxSection>
            )}
            {currentView === 'transmuter-lockdrop' && (
                <DittoSpeechBoxSection
                    title="Transmuter Lockdrop"
                    onBack={returnToHub}
                    onClose={close}
                    titleColor="purple.400"
                >
                    <TransmuterLockdropSection onBack={returnToHub} />
                </DittoSpeechBoxSection>
            )}
            {currentView === 'boost' && (
                <DittoSpeechBoxSection
                    title="Boost Breakdown"
                    onBack={returnToHub}
                    onClose={close}
                    titleColor="cyan.400"
                >
                    <BoostSection onBack={returnToHub} />
                </DittoSpeechBoxSection>
            )}
            {currentView === 'updates' && (
                <DittoSpeechBoxSection
                    title="Updates"
                    onBack={returnToHub}
                    onClose={close}
                    titleColor="cyan.400"
                >
                    <UpdatesSection onBack={returnToHub} />
                </DittoSpeechBoxSection>
            )}
            {currentView === 'tx-confirmation' && (
                <Box flex={1} overflow="auto">
                    <TxConfirmationSection />
                </Box>
            )}
            {currentView === 'tutorial' && (
                <DittoSpeechBoxSection
                    title="Tutorial"
                    onBack={returnToPreviousView}
                    onClose={close}
                    titleColor="purple.400"
                    showTutorialButton={false}
                    onFAQClick={openFAQ}
                >
                    <TutorialSectionWrapper onBack={returnToPreviousView} onOpenFAQ={openFAQ} />
                </DittoSpeechBoxSection>
            )}
            {currentView === 'faq' && (
                <DittoSpeechBoxSection
                    title="FAQ"
                    onBack={returnToPreviousView}
                    onClose={close}
                    titleColor="purple.400"
                >
                    <FAQSectionWrapper onBack={returnToPreviousView} />
                </DittoSpeechBoxSection>
            )}
        </Box>
    )
}

// Wrapper components that use context
const TutorialSectionWrapper: React.FC<{ onBack: () => void; onOpenFAQ: () => void }> = ({ onBack, onOpenFAQ }) => {
    const tutorial = useTutorialContext()
    return (
        <TutorialSection
            steps={tutorial.steps}
            currentStep={tutorial.currentStep}
            isFirstStep={tutorial.isFirstStep}
            isLastStep={tutorial.isLastStep}
            totalSteps={tutorial.totalSteps}
            onNext={tutorial.onNext}
            onPrevious={tutorial.onPrevious}
            onFinish={tutorial.onFinish}
            onSkip={tutorial.onSkip}
            onBack={onBack}
            onOpenFAQ={onOpenFAQ}
        />
    )
}

const FAQSectionWrapper: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const tutorial = useTutorialContext()
    return <FAQSection faqItems={tutorial.faq} onBack={onBack} />
}

// Disco section with tutorial buttons
const DiscoSectionWithTutorial: React.FC<{
    onBack: () => void
    onClose: () => void
    openTutorial: () => void
    openFAQ: () => void
}> = ({ onBack, onClose, openTutorial, openFAQ }) => {
    const tutorialStore = useTutorialStore()

    const handleTutorialClick = () => {
        // Use the registered action from the hook
        tutorialStore.startTutorial()
        openTutorial()
    }

    return (
        <DittoSpeechBoxSection
            title="Disco"
            onBack={onBack}
            onClose={onClose}
            showTutorialButton={true}
            onTutorialClick={handleTutorialClick}
            onFAQClick={openFAQ}
        >
            <DiscoSection onBack={onBack} />
        </DittoSpeechBoxSection>
    )
}
