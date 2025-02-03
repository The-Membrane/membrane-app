// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import { denoms } from '@/config/defaults';
import { Asset, getAssets } from '@/helpers/chain';
import { num, shiftDigits } from '@/helpers/num';
import { getBasket } from '@/services/cdp';
import { getBoundedUnderlyingCDT } from '@/services/earn';
import { getOraclePrices } from '@/services/oracle';
import type { NextApiRequest, NextApiResponse } from 'next'
import { osmosis } from 'osmojs';

type Data = {
    strategy?: string,
    balance?: {
        amount: string,
        usd: number
    },
    unclaimed_rewards?: {
        total_usd: number,
    }
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

        const [assets, balances, basket] = await Promise.all([
            getAssets(),
            getBalances(address),
            getBasket()
        ]);

        if (!assets || !balances || !basket) {
            return res.status(500).json({ error: 'Failed to fetch asset, basket or balances.' });
        }

        const prices = await getOraclePrices(basket)

        if (!prices) {
            return res.status(500).json({ error: 'Failed to fetch prices.' });
        }

        const cdtMarketPrice = prices?.find((price) => price.denom === denoms.CDT[0])?.price || basket?.credit_price.price || "1"

        const boundCDTAsset = assets.find((asset) => asset.symbol === 'range-bound-CDT') as Asset
        const boundCDTBalance = await getBalanceByAsset(balances, address, boundCDTAsset) ?? "1"
        const underlyingData = await getBoundedUnderlyingCDT(num(shiftDigits(boundCDTBalance, 6)).toFixed(0))

        if (!assets || !underlyingData || !balances) {
            return res.status(500).json({ error: 'Failed to fetch required underlyingData.' });
        }

        const underlyingCDT = Number(shiftDigits(underlyingData, -6)) ?? 0

        return res.status(200).json({
            strategy: "cdt-usdc-cl-lp-vault",
            balance: {
                amount: underlyingCDT.toString(),
                usd: num(underlyingCDT).times(cdtMarketPrice).toNumber()
            },
            unclaimed_rewards: {
                total_usd: 0
            }
        });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
