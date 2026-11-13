// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice TEST DOUBLE of an Aave V3 Pool, limited to the calls the Bundler3 AaveV3MigrationAdapter
///         makes (repay, withdraw) and the calls a test needs to open a position (supply, borrow).
///         Aave is an EXTERNAL protocol, so a double is legitimate here; the semantics it copies are
///         the ones the migration depends on, each from aave-v3-core:
///           - repay on behalf with amount == type(uint).max reverts           ValidationLogic.validateRepay (error 40)
///           - repay is capped at the debt; only the capped amount is pulled   BorrowLogic.executeRepay
///           - withdraw(type(uint).max) withdraws the caller's whole aToken balance  SupplyLogic.executeWithdraw
///           - withdraw and aToken transfer revert if the sender's health factor drops below 1
///           - aTokens implement ERC-2612 permit                               AToken / EIP712Base
///         Interest: `accrueDebt` moves a user's debt the way the variable index would between a
///         read and the signature. 1 aToken == 1 underlying (index 1).
contract MockAToken is ERC20, ERC20Permit {
    MockAaveV3Pool public immutable pool;
    address public immutable UNDERLYING_ASSET_ADDRESS;

    uint8 private immutable _decimals;

    constructor(address underlying, string memory name_)
        ERC20(name_, name_)
        ERC20Permit(name_)
    {
        pool = MockAaveV3Pool(msg.sender);
        UNDERLYING_ASSET_ADDRESS = underlying;
        _decimals = ERC20(underlying).decimals();
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function POOL() external view returns (address) {
        return address(pool);
    }

    function mint(address to, uint256 a) external {
        require(msg.sender == address(pool), "only pool");
        _mint(to, a);
    }

    function burn(address from, uint256 a) external {
        require(msg.sender == address(pool), "only pool");
        _burn(from, a);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        // AToken.transfer → Pool.finalizeTransfer validates the sender's HF after a transfer.
        if (from != address(0) && to != address(0)) pool.requireHealthy(from);
    }
}

/// @notice Variable debt token double: balanceOf reads the pool's debt book (as Aave's scaled
///         balance × index would). Non-transferable, like Aave's.
contract MockVariableDebtToken {
    MockAaveV3Pool public immutable pool;
    address public immutable UNDERLYING_ASSET_ADDRESS;

    constructor(address underlying) {
        pool = MockAaveV3Pool(msg.sender);
        UNDERLYING_ASSET_ADDRESS = underlying;
    }

    function balanceOf(address user) external view returns (uint256) {
        return pool.variableDebt(UNDERLYING_ASSET_ADDRESS, user);
    }
}

/// @notice Aave V3's legacy `getReserveData` return layout (IPool.getReserveData, v3.0-v3.3).
struct ReserveDataLegacy {
    uint256 configuration;
    uint128 liquidityIndex;
    uint128 currentLiquidityRate;
    uint128 variableBorrowIndex;
    uint128 currentVariableBorrowRate;
    uint128 currentStableBorrowRate;
    uint40 lastUpdateTimestamp;
    uint16 id;
    address aTokenAddress;
    address stableDebtTokenAddress;
    address variableDebtTokenAddress;
    address interestRateStrategyAddress;
    uint128 accruedToTreasury;
    uint128 unbacked;
    uint128 isolationModeTotalDebt;
}

contract MockAaveV3Pool {
    struct Reserve {
        MockAToken aToken;
        MockVariableDebtToken vToken;
        uint256 priceUsd; // USD per whole token, 1e18
        uint256 liquidationThreshold; // 1e4 bps
    }

    mapping(address => Reserve) public reserves;
    address[] public assets;
    mapping(address => mapping(address => uint256)) public variableDebt; // asset => user => debt

    function addReserve(address asset, uint256 priceUsd, uint256 ltBps) external returns (address aToken) {
        MockAToken a = new MockAToken(asset, string.concat("a", ERC20(asset).symbol()));
        reserves[asset] = Reserve(a, new MockVariableDebtToken(asset), priceUsd, ltBps);
        assets.push(asset);
        return address(a);
    }

    function setPrice(address asset, uint256 priceUsd) external {
        reserves[asset].priceUsd = priceUsd;
    }

    function aTokenOf(address asset) external view returns (address) {
        return address(reserves[asset].aToken);
    }

    function getReserveData(address asset) external view returns (ReserveDataLegacy memory d) {
        Reserve storage r = reserves[asset];
        d.liquidityIndex = 1e27;
        d.variableBorrowIndex = 1e27;
        d.lastUpdateTimestamp = uint40(block.timestamp);
        d.aTokenAddress = address(r.aToken);
        d.variableDebtTokenAddress = address(r.vToken);
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
        reserves[asset].aToken.mint(onBehalfOf, amount);
    }

    function borrow(address asset, uint256 amount, uint256 mode, uint16, address onBehalfOf) external {
        require(mode == 2, "variable only");
        require(onBehalfOf == msg.sender, "no credit delegation in mock");
        variableDebt[asset][onBehalfOf] += amount;
        requireHealthy(onBehalfOf);
        IERC20(asset).transfer(msg.sender, amount);
    }

    function repay(address asset, uint256 amount, uint256 mode, address onBehalfOf) external returns (uint256) {
        require(mode == 2, "variable only");
        // ValidationLogic.validateRepay: NO_EXPLICIT_AMOUNT_TO_REPAY_ON_BEHALF
        require(amount != type(uint256).max || msg.sender == onBehalfOf, "40");
        uint256 debt = variableDebt[asset][onBehalfOf];
        require(debt != 0, "39"); // NO_DEBT_OF_SELECTED_TYPE
        uint256 payback = amount < debt ? amount : debt;
        variableDebt[asset][onBehalfOf] = debt - payback;
        IERC20(asset).transferFrom(msg.sender, address(this), payback);
        return payback;
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        MockAToken a = reserves[asset].aToken;
        uint256 bal = a.balanceOf(msg.sender);
        uint256 w = amount == type(uint256).max ? bal : amount;
        require(w <= bal, "32"); // NOT_ENOUGH_AVAILABLE_USER_BALANCE
        a.burn(msg.sender, w);
        requireHealthy(msg.sender);
        IERC20(asset).transfer(to, w);
        return w;
    }

    /// @notice Test hook: interest accrued on the variable index between a read and execution.
    function accrueDebt(address asset, address user, uint256 extra) external {
        variableDebt[asset][user] += extra;
    }

    function debtOf(address user) public view returns (uint256 usd) {
        for (uint256 i; i < assets.length; ++i) {
            usd += variableDebt[assets[i]][user] * reserves[assets[i]].priceUsd / 10 ** ERC20(assets[i]).decimals();
        }
    }

    function requireHealthy(address user) public view {
        uint256 debt = debtOf(user);
        if (debt == 0) return;
        uint256 adjColl;
        for (uint256 i; i < assets.length; ++i) {
            Reserve storage r = reserves[assets[i]];
            adjColl += r.aToken.balanceOf(user) * r.priceUsd / 10 ** ERC20(assets[i]).decimals() * r.liquidationThreshold / 1e4;
        }
        require(adjColl >= debt, "35"); // HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD
    }
}
