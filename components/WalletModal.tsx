import {
  Button,
  Card,
  HStack,
  Image,
  Link,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Stack,
  Switch,
  Text,
} from '@chakra-ui/react'
import { WalletModalComponentProps } from '@cosmos-kit/react'
import { Fragment, useMemo, useState } from 'react'

const WalletName = ({ name, isWalletNotExist }: { name: string; isWalletNotExist: boolean }) => {
  if (!name) return null

  return (
    <HStack justifyContent="space-between" w="full">
      <Text variant="light">{name}</Text>
      {isWalletNotExist && (
        <Text variant="light" fontSize="sm" color="#C445F0">
          Install
        </Text>
      )}
    </HStack>
  )
}

type WalletProps = {
  wallet: any
  onConnect: () => Promise<void>
}

const Wallet = ({ wallet, onConnect }: WalletProps) => {
  if (wallet.isWalletNotExist) return <InstallWallet wallet={wallet} />

  return <InstalledWallet wallet={wallet} onConnect={onConnect} />
}

const InstalledWallet = ({ wallet, onConnect }: WalletProps) => {
  return (
    <HStack
      variant="ghost"
      onClick={onConnect}
      as={Button}
      py="7"
      px="4"
      gap={5}
      w="full"
      cursor="pointer"
      justifyContent="start"
      borderRadius="12px"
      border="2px solid rgba(250, 129, 253, 0.37)"
      background="#05071B"
      boxShadow="0px 0px 24px 0px rgba(250, 129, 253, 0.32)"
    >
      <Image
        src={wallet?.walletInfo?.logo}
        boxSize="1.7rem"
        borderRadius="full"
        alt={wallet?.walletInfo.prettyName}
      />

      <WalletName
        name={wallet?.walletInfo.prettyName}
        isWalletNotExist={wallet?.isWalletNotExist}
      />
    </HStack>
  )
}
const InstallWallet = ({ wallet }: { wallet: any }) => {
  return (
    <HStack
      variant="unstyled"
      as={Link}
      href={wallet?.downloadInfo?.link}
      isExternal={true}
      py="4"
      px="4"
      gap={5}
      cursor="pointer"
      w="full"
      justifyContent="start"
      _hover={{ textDecoration: 'none' }}
      borderRadius="12px"
      border="2px solid rgba(250, 129, 253, 0.37)"
      background="#05071B"
      boxShadow="0px 0px 24px 0px rgba(250, 129, 253, 0.32)"
    >
      <Image
        src={wallet?.walletInfo?.logo}
        boxSize="1.7rem"
        borderRadius="full"
        alt={wallet?.walletInfo.prettyName}
      />

      <WalletName
        name={wallet?.walletInfo.prettyName}
        isWalletNotExist={wallet?.isWalletNotExist}
      />
    </HStack>
  )
}

const WalletModal = ({ isOpen, setOpen, walletRepo }: WalletModalComponentProps) => {
  const { mobileWallets, extensionWallets } = useMemo(() => {
    const w = walletRepo?.wallets
    const mobileWallets = w?.filter((wallet) => wallet?.isModeWalletConnect)

    // sort by isWalletNotExist
    const extensionWallets = w
      ?.filter((wallet) => !wallet?.isModeWalletConnect)
      .sort((a, b) => (a?.isWalletNotExist ? 1 : -1))

    return { mobileWallets, extensionWallets }
  }, [walletRepo?.wallets])

  const [isWallectconnect, setIsWalletConnect] = useState(false)

  const onCloseModal = () => {
    setOpen(false)
  }

  const onConnect = (connect: () => Promise<void>) => {
    connect?.()
    onCloseModal()
  }

  return (
    <Modal isOpen={isOpen} onClose={onCloseModal}>
      <ModalOverlay backdropFilter="blur(50px)" />
      <Card as={ModalContent}>
        <ModalHeader w="full">
          <HStack justifyContent="space-between" w="full" alignItems="flex-end">
            <Text variant="title" w="150px">
              Select Wallet
            </Text>
            <Stack>
              <HStack justifyContent="space-evenly">
                <Image src="/images/wallet-connect-logo.svg" alt="wallet" boxSize="5" />
                <Switch
                  id="email-alerts"
                  isChecked={isWallectconnect}
                  onChange={(e) => setIsWalletConnect(e.target.checked)}
                />
              </HStack>
              <Text fontSize="10px">Mobile wallet</Text>
            </Stack>
          </HStack>
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <Stack alignItems="flex-start">
            {!isWallectconnect && (
              <Fragment>
                {extensionWallets?.map((wallet: any) => (
                  <Wallet
                    key={wallet.walletName}
                    wallet={wallet}
                    onConnect={() => onConnect(wallet.connect)}
                  />
                ))}
              </Fragment>
            )}

            {isWallectconnect && (
              <Fragment>
                {mobileWallets?.map((wallet: any) => (
                  <Wallet
                    key={wallet.walletName}
                    wallet={wallet}
                    onConnect={() => onConnect(wallet.connect)}
                  />
                ))}
              </Fragment>
            )}
          </Stack>
        </ModalBody>
      </Card>
    </Modal>
  )
}

export default WalletModal
