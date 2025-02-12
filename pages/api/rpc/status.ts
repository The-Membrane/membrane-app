import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const API_KEY = process.env.EXTERNAL_API_KEY;
    const API_URL = `https://osmosis-rpc.numia.xyz/apikey/${process.env.EXTERNAL_API_KEY}`;

    console.log('Starting request with API_KEY:', API_KEY ? 'Present' : 'Missing');
    console.log('API URL:', API_URL);

    try {
        console.log('Making fetch request...');
        const response = await fetch(API_URL, {
            method: "GET",
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
            },
            redirect: "follow"
        });

        console.log('Response status:', response.status);
        console.log('Response headers:', Object.fromEntries(response.headers));

        if (!response.ok) {
            throw new Error(`RPC error: ${response.status} ${response.statusText}`);
        }

        // Log raw response first
        const rawResponse = await response.text();
        console.log('Raw response:', rawResponse);

        // Then parse as JSON
        const data = JSON.parse(rawResponse);
        console.log('Parsed data:', data);

        return res.status(200).json(data);
    } catch (error) {
        console.error('Detailed error:', error);
        return res.status(500).json({
            error: 'Internal Server Error',
            message: error instanceof Error ? error.message : 'Unknown error'
        });
    }
}