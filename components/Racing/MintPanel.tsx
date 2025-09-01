import React, { useState } from 'react'
import { Button, Flex, HStack, Input, Text, VStack, Box, Spinner, useBreakpointValue } from '@chakra-ui/react'
import { ChevronDownIcon } from '@chakra-ui/icons'
import useWallet from '@/hooks/useWallet'
import { useMintCar } from '@/components/Racing/hooks'
import { usePaymentSelection } from './hooks/usePaymentSelection'
import PaymentOptionsSheet from './PaymentOptionsSheet'
import ConfirmModal from '../ConfirmModal'

const MintPanel: React.FC = () => {
  const { address } = useWallet()
  const [inputName, setInputName] = useState('')
  const [name, setName] = useState('')
  const isMobile = useBreakpointValue({ base: true, md: false })

  // Create mint car hook for free minting
  const freeMintHook = useMintCar({ extension: { name } })

  // Create mint car hook for paid minting (will be updated when option selected)
  const [currentPaymentOption, setCurrentPaymentOption] = useState<any>(null)
  const paidMintHook = useMintCar({ extension: { name }, paymentOption: currentPaymentOption })

  const {
    isOptionsOpen,
    isLoading,
    statusMessage,
    lastUsedPaymentMethod,
    paymentOptions,
    openOptions,
    closeOptions,
    executePayment,
    quickMint
  } = usePaymentSelection()

  const handleQuickMint = () => {
    // This function is no longer used since we only open the menu
    // All execution happens in handleOptionSelect
  }

  const handleOptionSelect = (option: any) => {
    if (option.denom && option.amount !== '0') {
      // Paid option
      setCurrentPaymentOption({
        denom: option.denom,
        amount: option.amount
      })
      executePayment(option, () => paidMintHook.action.tx.mutate())
    } else {
      // Free option
      executePayment(option, () => freeMintHook.action.tx.mutate())
    }
  }

  return (
    <VStack align="start" spacing={4} p={{ base: 3, md: 4 }} border="2px solid #0033ff" bg="#0b0e17" borderRadius={6} w={{ base: "100%", lg: "33vw" }}>
      <Text fontFamily='"Press Start 2P", monospace' color="#fff" fontSize={{ base: '12px', sm: '14px' }}>
        Mint New Car
      </Text>
      <Flex direction={{ base: 'column', sm: 'row' }} gap={2} w="100%" align={{ base: 'stretch', sm: 'center' }}>
        <Text w={{ base: 'auto', sm: '140px' }} fontSize={{ base: '10px', sm: '12px' }} fontFamily='"Press Start 2P", monospace' color="#b8c1ff">Name</Text>
        <Input
          value={inputName}
          onChange={(e) => setInputName(e.target.value)}
          size="sm"
          bg="#0a0f1e"
          borderColor="#2a3550"
          color="#e6e6e6"
          minH={{ base: '44px', sm: 'auto' }}
          flex="1"
        />
      </Flex>
      {/* Mint Button with Payment Options */}
      <Box position="relative" w="100%">
        <Button
          leftIcon={isLoading ? <Spinner size="sm" /> : undefined}
          rightIcon={<ChevronDownIcon />}
          onClick={() => {
            setName(inputName)
            openOptions()
          }}
          disabled={!address || isLoading || !inputName.trim()}
          bg="#274bff"
          color="white"
          _hover={{ bg: '#1a3bff' }}
          _active={{ bg: '#0f2bff' }}
          borderRadius="md"
          size="sm"
          w="100%"
          minH={{ base: "44px", sm: "auto" }}
          fontFamily='"Press Start 2P", monospace'
          fontSize={{ base: "10px", sm: "12px" }}
          aria-label="Mint car"
          onContextMenu={(e) => {
            e.preventDefault()
            setName(inputName)
            openOptions()
          }}
        >
          {isLoading ? 'Minting...' : 'Mint Car'}
        </Button>

        {/* Payment Options Sheet */}
        <PaymentOptionsSheet
          isOpen={isOptionsOpen}
          onClose={closeOptions}
          paymentOptions={paymentOptions}
          onSelectOption={handleOptionSelect}
          isLoading={isLoading}
          lastUsedPaymentMethod={lastUsedPaymentMethod}
        />
      </Box>

      {statusMessage && (
        <Text
          fontSize={{ base: '8px', md: '10px' }}
          fontFamily='"Press Start 2P", monospace'
          color="#7cffa0"
          textAlign="center"
          w="100%"
        >
          {statusMessage}
        </Text>
      )}
      {!address && (
        <Text fontSize="11px" color="#ff6b6b" fontFamily='"Press Start 2P", monospace'>Connect wallet to mint</Text>
      )}
    </VStack>
  )
}

export default MintPanel 