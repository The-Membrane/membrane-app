# sdeUSD/USDC write-offs (2025) — archive reads

Scripts behind `curator-incidents/sdeusd-2025/` in the private datasets repo (board rule
N18: data there, code here). RPC: the curator collector's endpoints
(`scripts/lib/curator-feed-rpc.ts`; every log chunk read from two endpoints and unioned;
labels only are printed).

| script                                   | writes                                                                                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zombie.ts 0x0f9563…b129 21777653 <out>` | `sdeusd-usdc-market.json`: every market event since creation, positions at the head with interest accrued to the head (IRM `borrowRateView`, Taylor compounding), oracle path, `price()` revert onset, weekly series |
| `zombie.ts 0xbd1ad3…  <block> <out>`     | `deusd-usdc-86-market.json`: the same for deUSD/USDC (86 %)                                                                                                                                                          |
| `ids.ts <market.json>`                   | `lenders.json`: who each position holder is                                                                                                                                                                          |
| `removals.ts <out>`                      | `vault-config.json`: each lender vault's cap / removal / queue / reallocation events on the market, `lostAssets`, state before and at each                                                                           |
| `runs.ts <out>`                          | `vault-runs.json`: ERC-4626 deposits / withdrawals of Relend, Usual Boosted, Avantgarde USDC, 2025-10-28 → 11-19                                                                                                     |
| `vaults.ts <out>`                        | `adpend-1337-vaults.json`: depositor history of the two vaults that kept the market                                                                                                                                  |
| `trace.ts`, `comp.ts`, `nov13.ts`        | stdout only: the borrower's token flows, its Compound v3 position, the 2025-11-13 Relend exit                                                                                                                        |

`docs/CURATOR_ACTION_FEED.md` ("Flags", "Exposure") gives what the feed took from it.
