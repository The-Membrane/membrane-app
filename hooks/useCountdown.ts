import { useState, useEffect } from 'react'
import dayjs from 'dayjs'

export const useCountdown = (timestamp: number | null | undefined) => {
  const [isEnded, setIsEnded] = useState(false)
  const [timeString, setTimeString] = useState('0d 0h 0m')

  useEffect(() => {
    if (!timestamp) return
    const intervalId = setInterval(() => {
      const currentTime = dayjs()
      const endTime = dayjs.unix(timestamp)
      const remainingTime = endTime.diff(currentTime, 'second')

      if (remainingTime <= 0) {
        setIsEnded(true)
        setTimeString('0d 0h 0m')
        clearInterval(intervalId)
      } else {
        const days = Math.floor(remainingTime / 86400)
        const hours = Math.floor((remainingTime % 86400) / 3600)
        const minutes = Math.floor((remainingTime % 3600) / 60)

        setTimeString(`${days}d ${hours}h ${minutes}m`)
      }
    }, 1000)

    return () => clearInterval(intervalId)
  }, [timestamp])

  return { isEnded, timeString }
}

export default useCountdown
