Next Steps:

Make the Control Room... (Make Money Room)  
- MM liquidation fulfillment
---------------------------------

- Make the Portfolio page easily shareable on twitter, see Nolus for inspo

- liq bot, arb bot, redemption bot, intent bot

- If liquidations error with our "False positive" parse, remove that position from the liquidation execution. This will require us to sim each liquidation separately or randomize which one gets removed to test.

- //FIX SUPPLY CAP ERRORS FOR EXPUNGED ASSETS/MAKE A MODAL TO ALERT EXPUNGED ASSETS.

FOR CONTRACTS:
- Upgrade MM contracts & check collateral rate assurance works

- Volatility List Upgrades
-- Remove unused collateral from contract state
-- Test Vol Index > 1 for a dynamic LTV future (will likely cap max LTV change per week)
-- Use for individualized rates (Make sure IR and Cap shrinks aren't multiplicative)(Maybe just shift IR calcs to use the rate from vol OR cap overages, not both)
-- Create query for vol state

- Abstract debt token logic
-- Oracle contract
-- Swap contract

- Fuzzing 
- MM Vault enforces 50/50 LP ratio on deposits (ensures revenue is efficiently incentivizing deeper liquidity)
- Neutron migration 

- Add limit order price to Loop intent
- Add "take initial out" strat


Permissionless Iso-Market Growth Aid
- No fees (add fees later past a borrow threshold)
- Revenue somewhere (?)
- Sort UI by APR

- Show slippage of a full collateral -> debt swap
- Add socials and manager names. add flag if there is none of either.
---------














Free Money Generation Kit
- Level 1: Titled card with intent & liquidation searching
- Level 2: 1-click Akash deployments for Intent & Liquidation Fulfillment
-- (docker chat start: https://chatgpt.com/share/681a5280-6834-8009-afa4-10551a061202)
-- open source Akash webapp: https://github.com/akash-network/console
-- example: https://github.com/akash-network/console/wiki/Managed-wallet-API
-- js link: https://github.com/akash-network/akashjs

User Research
- https://library.gv.com/gv-guide-to-research-847cfb08fcef?gi=8442fb786167
- Ask GPT to mimic agents and send it screenshots
- We want to give the user space to grow into the product. Not too complicated that there is no starting point and not too simple that there is no way to grow.