import type { NextApiRequest,NextApiResponse } from 'next'
import { readAvailablePinnedForecastArtifacts } from '@/lib/carry/pinnedForecastArtifacts.server'
export default function handler(req:NextApiRequest,res:NextApiResponse) {
  res.setHeader('Cache-Control','private, max-age=60')
  if(req.method!=='GET') {res.setHeader('Allow','GET');return res.status(405).json({error:'method_not_allowed'})}
  return res.status(200).json({artifacts:readAvailablePinnedForecastArtifacts()})
}
