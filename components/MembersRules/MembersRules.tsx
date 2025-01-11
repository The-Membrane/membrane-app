import { Center } from '@chakra-ui/react'
import useMembersRulesState from './useRules'
import { RulesModal } from './RulesModal'

export const rules = [
  'Sovereign individuals only',
  "Your experience is your own responsibility/liability, not the website host's",
  "If your jurisdiction is banned, don't enter",
  "Once you're in, you're within",
]

const MembersRules = () => {
  const { show } = useMembersRulesState()
  if (!show) return null
  return (
    <Center
      style={{ zoom: "100%" }}
      w="1440px"
      h="1080px"
      margin="auto"
      bg="#111015"
      position="relative"
      zIndex={1}
      bgImg={`url("/images/backgrounds/rules_bg.svg")`}
      bgSize="contain"
      bgRepeat="no-repeat"
      bgPosition="center"
    >
      <RulesModal />
    </Center>
  )
}

export default MembersRules
