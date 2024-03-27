import { WalletIcon } from '@/components/Icons'
import { truncate } from '@/helpers/truncate'
import useWallet from '@/hooks/useWallet'
import { Button, HStack, Icon, Stack, Text } from '@chakra-ui/react'
import { useMemo, useState } from 'react'
import { RxExit } from 'react-icons/rx'

const hoverStyles = {
  borderRadius: '8px',
  border: '1px solid #C445F0',
  background: '#290A34',
  boxShadow: '0px 0px 16px 0px rgba(196, 69, 240, 0.32)',
  color: '#C445F0',
}

const WalletConnect = () => {
  const [isHovered, setIsHovered] = useState(false)
  const { connect, isWalletConnected, disconnect, username, address, chain } = useWallet()

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
        justifyContent="start"
        fontWeight="normal"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={() => disconnect()}
        leftIcon={<Icon as={RxExit} boxSize={5} color={isHovered ? '#C445F0' : 'white'} />}
        color={isHovered ? '#C445F0' : 'white'}
        py="6"
        pl="2"
        bg="whiteAlpha.100"
      >
        <Stack gap="-2px" alignItems="flex-start" ml="-6px">
          <Text fontSize="sm">{username}</Text>
          <Text fontSize="xs" color="gray">
            {shortAddress}
          </Text>
        </Stack>
      </HStack>
    )
  }

  return (
    <HStack
      as={Button}
      variant="unstyled"
      _hover={hoverStyles}
      justifyContent="start"
      fontWeight="normal"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={connect}
    >
      <WalletIcon color={isHovered ? '#C445F0' : 'white'} />
      <Text fontSize="lg">Wallet</Text>
    </HStack>
  )
}

export default WalletConnect
