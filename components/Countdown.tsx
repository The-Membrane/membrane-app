import { Text} from "@chakra-ui/react"
import useCountdown from "@/hooks/useCountdown"
import { memo } from "react"

type Props = {
    timestamp: number | undefined
}

const Countdown = memo(({ timestamp }: Props) => {    
  const timeLeft = useCountdown(timestamp).timeString

  return (
    <Text fontSize="16px" fontWeight="700">
        Time Left: {timeLeft}
    </Text>
  )
})

export default Countdown
