// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import { num } from '@/helpers/num';
import { getBasket, getBasketPositions, getCollateralInterest, getUserDiscount } from '@/services/cdp';
import { getBoundedTVL, getEstimatedAnnualInterest } from '@/services/earn';
import { getOraclePrices } from '@/services/oracle';
import type { NextApiRequest, NextApiResponse } from 'next'

type Data = {
  apr?: string,
  error?: string
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', ['GET']);
      return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }
    console.time("bulk queries");
    const [allPositions, basket, interest, vaultTVL] = await Promise.all([
      getBasketPositions(),
      getBasket(),
      getCollateralInterest(),
      getBoundedTVL()
    ]);
    const prices = await getOraclePrices(basket);
    console.timeEnd("bulk queries");


    if (!prices || !allPositions || !basket || !interest || !vaultTVL) {
      return res.status(500).json({ error: 'Failed to fetch required data.' });
    }

    console.time("getEstimatedAnnualInterest");
    const cdpCalcs = getEstimatedAnnualInterest(allPositions, prices, basket, interest, []);
    console.timeEnd("getEstimatedAnnualInterest");

    const apr = num(cdpCalcs.totalExpectedRevenue)
      .times(0.80)
      .dividedBy(vaultTVL)
      .toString()

    return res.status(200).json({
      apr
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
