// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import { shiftDigits } from '@/helpers/num';
import { getBoundedTVL } from '@/services/earn';
import type { NextApiRequest, NextApiResponse } from 'next'

type Data = {
    tvl?: string,
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

        const tvl = shiftDigits(vaultTVL, -6).toString()

        return res.status(200).json({
            tvl,
        });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
