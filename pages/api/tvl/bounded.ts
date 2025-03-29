// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import { rpcUrl } from '@/config/defaults';
import { getCosmWasmClient } from '@/helpers/cosmwasmClient';
import { num, shiftDigits } from '@/helpers/num';
import { cdpClient, getBasket } from '@/services/cdp';
import { getBoundedTVL } from '@/services/earn';
import { getOraclePrices } from '@/services/oracle';
import type { NextApiRequest, NextApiResponse } from 'next'

type Data = {
    tvlUsd?: string,
    assets?: { coinMinimalDenom: string, tvl: string }[]
    error?: string
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
    try {
        if (req.method !== 'GET') {
            res.setHeader('Allow', ['GET']);
            return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
        }

        const client = await cdpClient(rpcUrl);


        const [vaultCDT, basket] = await Promise.all([
            getBoundedTVL(rpcUrl),
            getBasket(client)
        ]);

        if (!vaultCDT || !basket) {
            return res.status(500).json({ error: 'Failed to fetch required data.' });
        }

        const prices = await getOraclePrices(basket, rpcUrl)

        if (!prices) {
            return res.status(500).json({ error: 'Failed to fetch oracle prices.' });
        }

        const shiftedCDT = shiftDigits(vaultCDT, -6)
        const cdtPrice = parseFloat(prices?.find((price) => price.denom === "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt")?.price ?? "0")
        const tvl = num(shiftedCDT).times(cdtPrice).toFixed(2)

        return res.status(200).json({
            tvlUsd: tvl,
            assets: [
                {
                    coinMinimalDenom: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt',
                    tvl: tvl
                }
            ]
        });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
