"""Asset classes for the shock (prereg C.1): 'E' moves with ETH/USD, 'B' with BTC/USD, 'O' fixed.

A collateral or debt asset is 'E' when its lender oracle is ETH/USD times a ratio (WETH and ETH LSTs/LRTs),
'B' when it is BTC/USD times a ratio. Ratios are held fixed during a shock (prereg C.1, C.11).
"""
ETH_SYMS = {"WETH", "ETH", "WSTETH", "STETH", "WEETH", "RETH", "CBETH", "OSETH", "ETHX", "RSETH", "EZETH",
            "SFRXETH", "FRXETH", "WRSETH", "WEETHS", "PUFETH", "METH", "SWETH", "ANKRETH", "OETH", "WOETH",
            "SUPEROETHB", "WSUPEROETHB", "TETH", "ETH+", "WETH.E", "SDETH", "LSETH"}
BTC_SYMS = {"WBTC", "CBBTC", "TBTC", "LBTC", "EBTC", "FBTC", "SOLVBTC", "BTCB", "WBTC.E", "UNIBTC",
            "SOLVBTC.BBN", "PUMPBTC", "SBTC", "BBTC"}


# lending receipt tokens carry their underlying's class (D5c): aEthWETH, aBascbBTC, aArbWBTC, spWETH ...
RECEIPT_PREFIXES = ("AETHLIDO", "AETHETHERFI", "AETH", "ABAS", "AARB", "AOPT", "AOP", "SP", "A")


def asset_class(chain: str, symbol: str) -> str:
    s = (symbol or "").upper().strip()
    if s in ETH_SYMS:
        return "E"
    if s in BTC_SYMS:
        return "B"
    for p in RECEIPT_PREFIXES:
        if s.startswith(p) and len(s) > len(p):
            r = s[len(p):]
            if r in ETH_SYMS:
                return "E"
            if r in BTC_SYMS:
                return "B"
    return "O"
