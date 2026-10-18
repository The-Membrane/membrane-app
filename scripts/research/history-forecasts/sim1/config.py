"""Slice-1 configuration: markets, collateral families, oracle feed parameters, demo vault, horizons.

membrane-board design/q26-curator-simulator-2026-10-18.md section 6 (first build slice) and section 8 (owner
decisions 2026-10-18: research build only, q95 tails first, confidence filter, BLIND TEST labels).
Contract identities live only in this file and in chain reads; no output file carries an address.
"""
from __future__ import annotations

DESIGN = {"repo": "triccs/membrane-board", "path": "design/q26-curator-simulator-2026-10-18.md",
          "sections": "1, 2, 3.1a, 3.3, 6, 8", "inventory": "design/q26-blind-set-inventory-2026-10-17.md section 11"}

MARKETS = {
    "core": {
        "label": "Aave V3 Ethereum Core USDC",
        "chain": "ethereum",
        "call_url": "https://eth.drpc.org",
        "log_urls": ["https://rpc.mevblocker.io"],
        "pool": "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
        "oracle": "0x54586be62e3c3580375ae3723c145253060ca0c2",
        "usdc": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "atoken": "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c",
        "pool_deploy_block": 16_291_127,
        "block_s": 12.0,
        "log_range": 50_000,
        "gas_usd": 1.50,           # ~500k gas per liquidation at ~1 gwei (2026 base fees); config, scenario input
        "dust_usd": 6.43,          # R11.1-v3 D dust minimum (D-R11.1e)
        # Chainlink ETH/USD and BTC/USD on Ethereum: deviation 0.5 %, heartbeat 1 h (Chainlink feed docs)
        "feeds": {"ETH": (0.005, 3600), "BTC": (0.005, 3600)},
        "sentinel": False,
    },
    "arb": {
        "label": "Aave V3 Arbitrum native USDC",
        "chain": "arbitrum",
        "call_url": "https://arbitrum.gateway.tenderly.co",
        "log_urls": ["https://arbitrum.gateway.tenderly.co", "https://arb1.arbitrum.io/rpc"],
        "pool": "0x794a61358d6845594f94dc1db02a252b5b4814ad",
        "oracle": "0xb56c2f0b653b2e0b10c9b928c8580ac5df02c7c7",
        "usdc": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        "atoken": "0x724dc807b04555b71ed48a6896b6f41593b8c637",
        "pool_deploy_block": 105_740_626,   # the aUSDCn deployment block (C1 builder); first possible Borrow
        "block_s": 0.25,
        "log_range": 1_000_000,
        "gas_usd": 0.05,
        "dust_usd": 6.43,
        # Chainlink ETH/USD and BTC/USD on Arbitrum: deviation 0.05 %, heartbeat 24 h (Chainlink feed docs)
        "feeds": {"ETH": (0.0005, 86400), "BTC": (0.0005, 86400)},
        "sentinel": True,          # PriceOracleSentinel: sequencer assumed up in every path (no grace window)
    },
}

# Collateral families. Aave prices LST/LRT collateral by exchange-rate oracles on the ETH/USD (or BTC/USD) feed,
# so inside the horizon a family moves with its base feed. Depeg and exploit moves are stress lines only
# (design 2.1), not in the generator.
FAMILY_SYMBOLS = {
    "E": {"WETH", "WSTETH", "WEETH", "RSETH", "EZETH", "OSETH", "ETHX", "CBETH", "RETH", "TETH", "RSWETH",
          "PUFETH", "SWETH"},
    "B": {"WBTC", "CBBTC", "TBTC", "LBTC", "EBTC", "FBTC"},
}

# Demo vault (fixture, not a real curator). USD allocations; the idle balance is held outside the markets.
DEMO_VAULT = {"name": "demo USDC vault (fixture)", "alloc_usd": {"core": 15_000_000.0, "arb": 10_000_000.0},
              "idle_usd": 0.0, "withdrawal_usd": 5_000_000.0}

HORIZONS_H = {"1d": 24, "3d": 72}
PATHS = 10_000
SEED = 20261018
MAX_CALLS = 6                    # R11.1-v3 MAX_CALLS per account per evaluation
REPAY_FRACTIONS = (1.0, 0.5, 0.25, 0.1)   # liquidator search when the full call is unprofitable (C1 rule)

# R8.5 depth impairment (design 2.6): x0.5 when ETH falls >= 10 % within 24 h, linear recovery over 72 h.
DEPTH_IMPAIR = {"drop": 0.10, "window": 24, "impaired": 0.5, "recovery_h": 72}
DEPTH_GRID = (0.25, 0.5, 1.0, 2.0)      # alternative scenario lines (multipliers on the measured DEX depth)

# Joint-day pool: shared calendar days need prices for both assets and flows for both reserves.
JOINT_FIRST_DAY = "2023-07-01"
