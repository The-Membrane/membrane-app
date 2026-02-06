import { WalletIcon } from '@/components/Icons'
import { colors } from '@/config/defaults'
import { truncate } from '@/helpers/truncate'
import useWallet from '@/hooks/useWallet'
import { Button, HStack, Icon, Stack, Text } from '@chakra-ui/react'
import { useMemo, useState } from 'react'
import { FaSignOutAlt } from 'react-icons/fa'
import ConnectButton from './ConnectButton'
import { useChainRoute } from '@/hooks/useChainRoute'

const hoverStyles = {
  borderRadius: '8px',
  border: '1px solid #C445F0',
  color: colors.walletIcon,
}

const WalletConnect = () => {
  const [isHovered, setIsHovered] = useState(false)
  const { chainName } = useChainRoute()
  const { connect, isWalletConnected, disconnect, username, address, chain } = useWallet(chainName)

  const shortAddress = useMemo(
    () => truncate(address, chain.bech32_prefix),
    [address, chain.bech32_prefix],
  )

  if (isWalletConnected) {
    return (
      <HStack
        as={Button}
        variant="unstyled"
        _hover={hoverStyles}
        justifyContent={{ base: "center", md: "start" }}
        fontWeight="normal"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={() => disconnect()}
        leftIcon={<Icon as={FaSignOutAlt} boxSize={5} color={isHovered ? colors.walletIcon : 'white'} />}
        color={isHovered ? colors.tabBG : 'white'}
        py="6"
        pl="2"
        bg="whiteAlpha.100"
      >
        <Stack gap="-2px" alignItems="flex-start" ml="-6px">
          <Text fontSize="sm">{username}</Text>
          <Text fontSize="xs" color={colors.noState}>
            {shortAddress}
          </Text>
        </Stack>
      </HStack>
    )
  }
  return <ConnectButton />
  // return (
  //   <HStack
  //     as={Button}
  //     variant="unstyled"
  //     _hover={hoverStyles}
  //     justifyContent={{ base: "center", md: "start" }}
  //     fontWeight="normal"
  //     onMouseEnter={() => setIsHovered(true)}
  //     onMouseLeave={() => setIsHovered(false)}
  //     onClick={connect}
  //   >
  //     <WalletIcon color={isHovered ? colors.walletIcon : 'white'} />
  //     <Text fontSize="lg">Wallet</Text>
  //   </HStack>
  // )
}

export default WalletConnect
