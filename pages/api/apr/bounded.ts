// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import { num } from '@/helpers/num';
import { getBasket, getCollateralInterest, cdpClient, getBasketPositions, getDebt } from '@/services/cdp';
import { getBoundedTVL } from '@/services/earn';
import type { NextApiRequest, NextApiResponse } from 'next'
import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math';
import { rpcUrl } from '@/config/defaults';

type Data = {
  apr?: number,
  error?: string
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', ['GET']);
      return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }
    const [basket, interest, vaultCDT, basketPositions, client] = await Promise.all([
      getBasket(rpcUrl),
      getCollateralInterest(rpcUrl),
      getBoundedTVL(rpcUrl),
      getBasketPositions(rpcUrl),
      cdpClient(rpcUrl),
    ]);

    if (!basket || !interest || !vaultCDT || !client || !basketPositions) {
      return res.status(500).json({ error: 'Failed to fetch required data.' });
    }


    const vaultCDPs = await client.getBasketPositions({
      user: contracts.earn,
    })
    const vaultCDP = vaultCDPs?.[0]?.positions?.[0]
    if (!vaultCDP) {
      return res.status(500).json({ error: 'Failed to fetch vault CDP.' });
    }

    // Get the total debt
    var cdpDebt = 0;
    basketPositions.forEach((basketPosition) => {
      if (!basketPosition || basketPosition.positions.length === 0) return;

      basketPosition.positions.forEach((position, posIndex) => {
        const debt = getDebt([basketPosition], posIndex);
        cdpDebt += debt;

      });
    });
    cdpDebt = shiftDigits(cdpDebt, 6).toNumber();


    //Get the lowest rate
    const sortedRates = interest.rates
      .filter(rate => !isNaN(Number(rate)))  // Ensure all elements are numbers
      .sort((a, b) => Number(a) - Number(b));


    //we subtract manic vault debt bc it gets discounts 
    const totalDebt = num(cdpDebt).minus(vaultCDP.credit_amount);
    const estimatedRate = sortedRates.length > 0 ? sortedRates[0] : null;
    const estimatedRevenue = estimatedRate ? num(estimatedRate).times(totalDebt) : num(0);

    const apr = num(estimatedRevenue)
      .times(1)
      .dividedBy(vaultCDT)
      .toNumber()

    return res.status(200).json({
      apr
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
