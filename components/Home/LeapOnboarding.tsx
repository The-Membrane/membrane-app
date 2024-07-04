import { Card, HStack, Modal, ModalBody, ModalCloseButton, ModalContent, ModalHeader, ModalOverlay, Stack, Text } from '@chakra-ui/react'
import React, { useMemo, useState } from 'react'
import useWallet from '@/hooks/useWallet'

import { Swaps, ElementsProvider, WalletType } from '@leapwallet/elements'
import '@leapwallet/elements/styles.css'


const OnboardModal = ({ isOpen, setOpen } : { isOpen: boolean, setOpen: any }) => {
  const { connect,  wallet } = useWallet()
  const walletName = wallet?.prettyName

  const walletType = useMemo(() => {
    // based on the wallet you've connected, map it to the wallet type enum
    return WalletType.KEPLR
  }, [walletName])

  const onCloseModal = () => {
    setOpen(false)
  }

  // leftIcon={<WalletIcon />} 
  return (
    <Modal isOpen={isOpen} onClose={onCloseModal} >
      <ModalOverlay backdropFilter="blur(50px)" />
      <ModalContent padding={"4"}>
      <Card as={ModalContent} bg="#141628">
      <ModalHeader w="full">
          <HStack justifyContent="space-between" w="full" alignItems="flex-end">
            <Text variant="title" fontSize="md">
              Onboard to Osmosis
            </Text>
            <Stack></Stack>
          </HStack>
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody paddingInlineStart="0"> 
            <div className="leap-ui" style={{borderRadius: ".75rem"}}>
            <ElementsProvider
                primaryChainId="cosmoshub-4"
                connectWallet={connect}
                connectedWalletType={walletType}
            >
                <Swaps
                allowedSourceChains={{ chainTypes: ['cosmos', 'evm', 'svm'] }}
                allowedDestinationChains={[{ chainId: 'osmosis-1' }]}
                defaultValues={{ destinationChainId: 'osmosis-1' }}
                />
            </ElementsProvider>
            </div>
      </ModalBody>
      </Card>
      </ModalContent>
    </Modal>
  )
}

export default OnboardModal
