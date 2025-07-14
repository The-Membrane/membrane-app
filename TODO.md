Next Steps:
- Create Market Action

Make the Control Room...
- Mobile Friendly
- & Contain all searcher fulfillments that can make money (Place the "Make Money" buttons on the same card)
- Manage market intent & liquidation fulfillment
-- Add these to the Control Room and the individual management pages
-- Control Room button will be for all markets so a lot more logic to run
---------------------------------

- liq bot, arb bot, redemption bot, intent bot

Permissionless Iso-Market Growth Aid
- No fees (add fees later past a borrow threshold)
- Revenue somewhere (?)
- Sort UI by APR

- Show slippage of a full collateral -> debt swap
- Add socials and manager names. add flag if there is none of either.
---------

- If liquidations error with our "False positive" parse, remove that position from the liquidation execution. This will require us to sim each liquidation separately or randomize which one gets removed to test.

- //FIX SUPPLY CAP ERRORS FOR EXPUNGED ASSETS/MAKE A MODAL TO ALERT EXPUNGED ASSETS.

FOR CONTRACTS:
To risk tranche:
- Add junior vault token state
- Add a junior denom to config
- Add a senior yield goal to config
- Add a total_debt / bad_debt struct for Junior Tranche tracking
- Add an execution choice for debt supply to be senior or junior (toggle)
- Make sure get_total_debt_tokens can work for either or both debt pools
- Make sure rate_assurance works for junior/senior
- Debt withdrawal needs to specifiy which tranche with its denom sent
- dynamic mint denom and config debt updates using helper functions
- Make sure dynamic vault token state loads are used everywhere
- Create junior denom in instantiation

- (Does the rate assurance in the accrue need to run for both vault tokens?)(It might not need to run at all, only for supply and withdrawing
 debt)

- Add accrue method yield distribution for tranches
- Senior yield caps at the config field but underneath that value, only gets 80%. So if they are directed to get 6% and costs go down to 6%, tranche groups will do 80 to seniors & remainder to juniors bc they can't get nothing.


- Add bad debt distribution to junior first
- Make sure the debt supply caps use total debt from both tranches

- Make sure this worls for multi-collateral types

Tweets:
- Personal: Intro to multiplying your position
- Protocol: Next steps -> collateral removal & lowering rates













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