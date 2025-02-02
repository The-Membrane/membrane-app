import { getCDTDailyVolume } from "@/services/numia";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    try {
        if (req.method !== 'GET') {
            res.setHeader('Allow', ['GET']);
            return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
        }

        const response = await getCDTDailyVolume();

        const data = await response.json();
        res.setHeader("Access-Control-Allow-Origin", "*"); // Allow frontend requests
        res.status(response.status).json(data);
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
