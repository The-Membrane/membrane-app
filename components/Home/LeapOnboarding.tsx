import { Card, HStack, Modal, ModalBody, ModalCloseButton, ModalContent, ModalHeader, ModalOverlay, Stack, Text } from '@chakra-ui/react'
import React, { useMemo, useState } from 'react'
import useWallet from '@/hooks/useWallet'

import { Swaps, ElementsProvider, WalletType } from '@leapwallet/elements'
import '@leapwallet/elements/styles.css'
import useInitialVaultSummary from '../Mint/hooks/useInitialVaultSummary'



const OnboardModal = ({ isOpen, setOpen } : { isOpen: boolean, setOpen: any }) => {
  const { data } = useInitialVaultSummary()
  const { basketAssets } = data || {
    initialBorrowLTV: 0, 
    initialLTV: 0, 
    debtAmount: 0, 
    initialTVL: 0, 
    basketAssets: []
  }
  const basketDenoms = useMemo(() => {
    if (!basketAssets) return []
    return basketAssets.map((asset) => asset.asset.base)
   }, [basketAssets])

  const { connect,  wallet } = useWallet()
  const walletName = wallet?.prettyName

  const walletType = useMemo(() => {
    // based on the wallet you've connected, map it to the wallet type enum
    console.log(walletName)
    console.log(wallet?.name)
    // if (walletName === 'Keplr') return WalletType.KEPLR
    // if (walletName === 'Leap') return WalletType.LEAP 
    // if (walletName === 'Cosmostation') return WalletType.COSMOSTATION

    return walletName
  }, [walletName])

  const onCloseModal = () => {
    setOpen(false)
  }

  // leftIcon={<WalletIcon />} 
  return (
    <Modal isOpen={isOpen} onClose={onCloseModal} >
      <ModalOverlay backdropFilter="blur(50px)" />
      <Card as={ModalContent} bg="#141628" padding={"4"}>
      <ModalHeader w="full">
          <HStack justifyContent="space-between" w="full" alignItems="flex-end">
            <Text variant="title" fontSize="md">
            Onboard Collateral
            </Text>
            <Stack></Stack>
          </HStack>
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody paddingInlineStart="0"> 
            <div className="leap-ui" style={{borderRadius: ".75rem", top: "0%", left: "0%"}}>
            <ElementsProvider
                primaryChainId="cosmoshub-4"
                connectWallet={connect}
                connectedWalletType={walletType as WalletType}
            >
                <Swaps
                className='leap-dialog-content'
                showPoweredByBanner={false}
                allowedSourceChains={{ chainTypes: ['cosmos', 'evm', 'svm'] }}
                allowedDestinationChains={[{ 
                  chainId: 'osmosis-1',
                  assetDenoms: basketDenoms,
                }]}
                defaultValues={{ destinationChainId: 'osmosis-1' }}
                
                />
            </ElementsProvider>
            </div>
      </ModalBody>
      </Card>
    </Modal>
  )
}

export default OnboardModal
