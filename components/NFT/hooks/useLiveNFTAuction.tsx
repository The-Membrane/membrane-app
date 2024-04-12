// import { getRewards, getStaked } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'
import IPFS from 'ipfs-http-client';

const useIPFS = () => {
    //   const { address } = useWallet() //example fn
    //   const { ipfsLink } = getLiveAuction()
    const ipfsLink = "ipfs://bafybeid2chlkhoknrlwjycpzkiipqypo3x4awnuttdx6sex3kisr3rgfsm"

    return useQuery({
        queryKey: ['IPFS', ipfsLink],
        queryFn: async () => {



            // const response = await fetch(ipfsLink);
            // if (!response.ok)
            //     console.error('Error resolving IPFS link');

            // const json = await response.json();

            const ipfs = IPFS.create({ host: 'ipfs.infura.io', port: 5001, protocol: 'https' });

            //   const rewards = await getRewards(address) //example fn
            //   const { ipfsLink } = await getLiveAuction()
            const data = ipfs.cat(ipfsLink);
            try {
                const resolved = await ipfs.resolve(ipfsLink);
                console.log(resolved);
            } catch (error) {
                console.error('Error resolving IPFS link:', error);
                return null;
            }
            console.log(data)
            return { data }
        },
        enabled: true,
    })
}

export default useIPFS
