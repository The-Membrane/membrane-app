# Membrane-CDT System Overview

## 🪙 CDT: The Stable Token

CDT is a decentralized, floating-peg debt token designed to support scalable, collateral-backed growth.

- **Floating Peg**: CDT is soft-pegged to USD, enabling organic price discovery and dynamic utility. Peg can accrue change but is currently disabled.
- **Growth-Optimized**: Minting costs are intentionally low to encourage adoption and liquidity expansion.
- **Core Collaterals Supported**:
  - Major assets: `BTC`, `ETH`, `TIA`, `SOL`, `ATOM`, `OSMO`, `USDC`, `USDT`
  - Liquid Staking Tokens (LSTs) for the above assets

---

## 🧪 Minting Mechanism

CDT minting uses an autonomous, risk-aware system with bundled collateral types and an optional collateral protected liquidation path.

- **Collateral Bundles**: Users mint CDT by depositing any combination of approved assets to form collateral bundles.
- **Volatility-Aware Risk Management**: Automatic collateral specific interest rate increases & supply restrictions during volatility spikes. Base parameters gradually recover as volatility gains normality.
- **Liquidation Recovery System**:
  - Collateral is distributed to liquidation bidders to repay debt instead of needing the liquidation executors to bring CDT.
  - CDT within various Membrane venues can be recovered to repay debt instead of selling collateral.
- **Peg-Aware Interest Rates**: Rates adjust dynamically based on CDT’s peg conditions

---

## 🧠 Isolated Collateral Markets

Each collateral type has its own individuallymanaged, isolated CDT debt market with programmable automation.

- **Intent System**:
  - Supports strategies like **looping**, **stop-loss/take-profit**, and **arbitrage**
- **Risk Tranching**: CDT lenders can opt into senior/junior tranches depending on risk appetite
- **Debt Token**: All loans use CDT as the borrowed asset

---

## 💥 Liquidation Bids System

All minting liquidations flow through this unified bidding mechanism.

- **Bid Options**:
  - **Global (Omni) Bids**: One pool, one premium, for all collateral types
  - **Individual Bids**: Separate bids per collateral, with variedpremium options
- **Bid Vaults**: Users can deposit capital into the Omni-Bid vault to automatically compound their bids over time

---

## 🧪 Market Making Vault

Designed to stabilize CDT and generate yield.

- **CL Pool**: CDT/USDC concentrated liquidity pool
- **Fee**: 0.05% swap fee
- **Revenue Streams**:
  - CDT minting fees
  - Swap/LP fees
  - Ecosystem points

---

## 🧩 MBRN Token Utility

MBRN captures system value and controls protocol direction.

- **Staking Benefits**:
  - Interest rate discounts on CDT minting
  - Share in system revenue
- **Revenue Distribution Options**:
  - Buy assets via auctions
  - Distribute to stakers
  - Send to any address (used for the Market Making Vault)

---

## 🗳 Governance Framework

- **MBRN Staking = Voting Power**
- **Quadratic Voting**: Promotes decentralization
- **Proposal Requirements**:
  - 1,000 MBRN required to create a proposal
- **Contract Control**:
  - Governance owns the major protocol contracts
- **POL Holdings**:
  - 1% of MBRN is held as protocol-owned liquidity (POL) paired with OSMO on Osmosis
