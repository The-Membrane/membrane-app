// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import { Asset, getAssets } from '@/helpers/chain';
import { num, shiftDigits } from '@/helpers/num';
import { useAssetBySymbol } from '@/hooks/useAssets';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { getBasket, getBasketAssets, getBasketPositions, getCollateralInterest, getUserDiscount } from '@/services/cdp';
import { getBoundedTVL, getBoundedUnderlyingCDT, getEstimatedAnnualInterest } from '@/services/earn';
import { getOraclePrices } from '@/services/oracle';
import type { NextApiRequest, NextApiResponse } from 'next'
import { osmosis } from 'osmojs';
import { useMemo } from 'react';

type Data = {
    balance?: string,
    error?: string
}

const getBalances = async (address: string) => {
    const client = await osmosis.ClientFactory.createRPCQueryClient({ rpcEndpoint: "https://rpc.cosmos.directory/osmosis" })

    return client.cosmos.bank.v1beta1
        .allBalances({
            address,
            pagination: {
                key: new Uint8Array(),
                offset: BigInt(0),
                limit: BigInt(1000),
                countTotal: false,
                reverse: false,
            },
        })
        .then((res) => {
            return res.balances
        })
}

const getBalanceByAsset = async (balances: any, address: string, asset: Asset) => {
    const balance = balances.find((b: any) => b.denom === asset.base)?.amount
    const denom = asset.base
    const decimals = asset.decimal || 6

    if (!balance || !decimals || !denom) return '0'
    return shiftDigits(balance, -decimals).toString()
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
    try {
        if (req.method !== 'GET') {
            res.setHeader('Allow', ['GET']);
            return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
        }
        const address = req.query.address as string

        const [assets, balances] = await Promise.all([
            getAssets(),
            getBalances(address)
        ]);

        if (!assets || !balances) {
            return res.status(500).json({ error: 'Failed to fetch asset or balances.' });
        }

        const boundCDTAsset = assets.find((asset) => asset.symbol === 'range-bound-CDT') as Asset
        const boundCDTBalance = await getBalanceByAsset(balances, address, boundCDTAsset) ?? "1"
        const underlyingData = await getBoundedUnderlyingCDT(num(shiftDigits(boundCDTBalance, 6)).toFixed(0))

        if (!assets || !underlyingData || !balances) {
            return res.status(500).json({ error: 'Failed to fetch required underlyingData.' });
        }

        const underlyingCDT = useMemo(() =>
            shiftDigits(underlyingData, -6).toString() ?? "0"
            , [underlyingData])


        return res.status(200).json({
            balance: underlyingCDT
        });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
