// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import { shiftDigits } from '@/helpers/math';
import { getBasket } from '@/services/cdp';
import { getBoundedConfig } from '@/services/earn';
import { getOraclePrices } from '@/services/oracle';
import { getCLPosition } from '@/services/osmosis';
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


        const [config, basket] = await Promise.all([
            getBoundedConfig(),
            getBasket(),
        ]);

        if (!basket || !config) {
            return res.status(500).json({ error: 'Failed to fetch required data.' });
        }

        const prices = await getOraclePrices(basket);

        if (!prices) {
            return res.status(500).json({ error: 'Failed to fetch required data.' });
        }


        const cdtPrice = parseFloat(prices?.find((price) => price.denom === "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt")?.price ?? "0")
        const usdcPrice = parseFloat(prices?.find((price) => price.denom === "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4")?.price ?? "0")

        const positions = { ceiling: config.range_position_ids.ceiling, floor: config.range_position_ids.floor }
        const ceilingPosition = await getCLPosition(positions.ceiling.toString())
        const floorPosition = await getCLPosition(positions.floor.toString())

        //Find ceiling amounts
        const ceilingAmounts = ceilingPosition.asset0.denom == "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt"
            ? { cdt: ceilingPosition.asset0.amount, usdc: ceilingPosition.asset1.amount } : { cdt: ceilingPosition.asset1.amount, usdc: ceilingPosition.asset0.amount }
        //Find floor amounts
        const floorAmounts = floorPosition.asset0.denom == "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt"
            ? { cdt: floorPosition.asset0.amount, usdc: floorPosition.asset1.amount } : { cdt: floorPosition.asset1.amount, usdc: floorPosition.asset0.amount }

        //Calc Ceiling TVL
        const ceilingTVL = shiftDigits(ceilingAmounts.cdt, -6).times(cdtPrice).plus(shiftDigits(ceilingAmounts.usdc, -6).times(usdcPrice))
        //Calc Floor TVL
        const floorTVL = shiftDigits(floorAmounts.cdt, -6).times(cdtPrice).plus(shiftDigits(floorAmounts.usdc, -6).times(usdcPrice))

        const positionsTVL = { ceilingTVL, floorTVL }
        //Calc CDT TVL
        const cdtTVL = shiftDigits(ceilingAmounts.cdt, -6).times(cdtPrice).plus(shiftDigits(floorAmounts.cdt, -6).times(cdtPrice))
        //Calc USDC TVL
        const usdcTVL = shiftDigits(ceilingAmounts.usdc, -6).times(usdcPrice).plus(shiftDigits(floorAmounts.usdc, -6).times(usdcPrice))
        //Calc total TVL
        const totalTVL = cdtTVL.plus(usdcTVL)
        const assetRatios = {
            cdt: cdtTVL.dividedBy(totalTVL).toNumber(),
            usdc: usdcTVL.dividedBy(totalTVL).toNumber()
        }

        const calculatedPositions = { ceiling: ceilingPosition, floor: floorPosition, positionsTVL, assetRatios }


        const tvl = calculatedPositions.positionsTVL.ceilingTVL.plus(calculatedPositions.positionsTVL.floorTVL).toString() ?? "0"


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
