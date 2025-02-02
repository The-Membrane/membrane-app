// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import { shiftDigits } from '@/helpers/num';
import { getBoundedTVL } from '@/services/earn';
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


        const [vaultTVL] = await Promise.all([
            getBoundedTVL()
        ]);

        if (!vaultTVL) {
            return res.status(500).json({ error: 'Failed to fetch required data.' });
        }

        const tvl = shiftDigits(vaultTVL, -6)

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
