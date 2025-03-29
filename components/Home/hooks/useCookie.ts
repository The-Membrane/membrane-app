import { getCookie } from '@/helpers/cookies'
import { useQuery } from '@tanstack/react-query'

const useCookie = (name: string) => {

  return useQuery({
    queryKey: ['cookie', name],
    queryFn: async () => {
      // console.log("attempting to get cookie: " + name)
      return getCookie(name)
    },
  })
}

export default useCookie
