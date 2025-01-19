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

    const useDiscounts = true;
    //req.query.useDiscounts === 'true';

    const allPositions = await getBasketPositions();
    const basket = await getBasket();
    const prices = await getOraclePrices(basket);
    const interest = await getCollateralInterest();
    const vaultTVL = await getBoundedTVL();

    if (!prices || !allPositions || !basket || !interest || !vaultTVL) {
      return res.status(500).json({ error: 'Failed to fetch required data.' });
    }

    const userDiscountPromises = useDiscounts
      ? allPositions.map(async (basketPosition) => {
        const totalCredit = basketPosition.positions.reduce(
          (acc, position) => acc + parseInt(position.credit_amount, 10),
          0
        );
        if (totalCredit <= 1000) return { discount: 0 };
        return getUserDiscount(basketPosition.user);
      })
      : [];

    const userDiscounts = await Promise.allSettled(userDiscountPromises);

    const userDiscountResults = userDiscounts.map((result) =>
      result.status === 'fulfilled' ? result.value : { discount: 0 }
    );

    const cdpCalcs = getEstimatedAnnualInterest(allPositions, prices, basket, interest, userDiscountResults);

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
