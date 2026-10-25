// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  MembraneBundlerAdapterV2 — DEPENDS ON THE DRAFT CORE PATCH Q41-M2
/// @notice The Membrane leg WITHOUT an operator grant and WITHOUT a proceeds permit. Requires
///         `Cdp.transferPosition` (membrane-board inbox/patches/membrane-solidity/0001-…). Against an
///         unpatched Cdp the final transfer reverts and nothing moves.
///
///         Inside the flash-loan callback: deposit the collateral into a position OWNED BY THIS
///         ADAPTER, peg-borrow as owner (the payout lands here, Cdp STEP 9 pays the owner), check the
///         LTV at Membrane's prices, send exactly the payout to GeneralAdapter1 (immutable) to repay
///         the flash loan, then `transferPosition` to the bundle's initiator.
///
///         Plain-EOA prompts: Aave = aToken permit + bundle (2); Morpho = authorization signature +
///         bundle (2, or 1 with the authorization standing). No Membrane grant exists at any time.
interface IBundler3Initiator {
    function initiator() external view returns (address);
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

struct Fund {
    bytes32 denom;
    uint256 amount;
}

interface ICdpV2 {
    function deposit(uint256 positionId, address positionOwner, Fund[] calldata funds) external returns (uint256);
    function increaseDebt(uint256 positionId, bytes32 borrowAsset, uint256 amount, bool pegDebt) external;
    function assetToken(bytes32 denom) external view returns (address);
    function transmuterForPeg() external view returns (address);
    function collateral() external view returns (address);
    function positionCollateralValue(uint256 positionId) external view returns (uint256);
    function positionDebt(uint256 positionId) external view returns (uint256);
    function creditPriceSource() external view returns (uint8 source, uint256 price);
    function transferPosition(uint256 positionId, address newOwner) external;
}

interface ICollateralLtv {
    function currentMaxLTV(bytes32 asset) external view returns (uint256);
}

interface ITransmuterPaired {
    function pairedAsset() external view returns (address);
    function pairedScale() external view returns (uint256);
}

contract MembraneBundlerAdapterV2 {
    uint256 public constant BORROW_LTV_GAP = 3e16;
    uint256 internal constant WAD = 1e18;

    address public immutable BUNDLER3;
    ICdpV2 public immutable CDP;
    address public immutable REPAY_TO;

    error UnauthorizedSender();
    error UnregisteredCollateral(bytes32 denom);
    error NoCollateral(bytes32 denom);
    error ZeroBorrow();
    error NotPegPaired(address repayToken, address paired);
    error PayoutMismatch(uint256 received, uint256 expected);
    error LtvAboveCap(uint256 ltvWad, uint256 capWad);
    error ZeroAddress();

    event MembraneLegExecuted(address indexed owner, uint256 indexed positionId, uint256 collateralDeposited, uint256 borrowedCdt, uint256 ltvWad);

    constructor(address bundler3, address cdp, address repayTo) {
        if (bundler3 == address(0) || cdp == address(0) || repayTo == address(0)) revert ZeroAddress();
        BUNDLER3 = bundler3;
        CDP = ICdpV2(cdp);
        REPAY_TO = repayTo;
    }

    function openBorrowAndTransfer(bytes32 collateralDenom, uint256 borrowCdt, address repayToken, uint256 maxLtvWad)
        external
        returns (uint256 positionId)
    {
        if (msg.sender != BUNDLER3) revert UnauthorizedSender();
        address owner = IBundler3Initiator(BUNDLER3).initiator();
        if (borrowCdt == 0) revert ZeroBorrow();

        address token = CDP.assetToken(collateralDenom);
        if (token == address(0)) revert UnregisteredCollateral(collateralDenom);
        uint256 amount = IERC20Min(token).balanceOf(address(this));
        if (amount == 0) revert NoCollateral(collateralDenom);
        _approve(token, address(CDP), amount);
        Fund[] memory funds = new Fund[](1);
        funds[0] = Fund({denom: collateralDenom, amount: amount});
        positionId = CDP.deposit(0, address(this), funds);
        _approve(token, address(CDP), 0);

        ITransmuterPaired tm = ITransmuterPaired(CDP.transmuterForPeg());
        address paired = address(tm) == address(0) ? address(0) : tm.pairedAsset();
        if (paired != repayToken) revert NotPegPaired(repayToken, paired);
        uint256 expected = borrowCdt / tm.pairedScale();
        uint256 before = IERC20Min(repayToken).balanceOf(address(this));
        CDP.increaseDebt(positionId, collateralDenom, borrowCdt, true);
        uint256 received = IERC20Min(repayToken).balanceOf(address(this)) - before;
        if (received != expected) revert PayoutMismatch(received, expected);

        uint256 cap = ICollateralLtv(CDP.collateral()).currentMaxLTV(collateralDenom);
        cap = cap > BORROW_LTV_GAP ? cap - BORROW_LTV_GAP : 0;
        if (maxLtvWad < cap) cap = maxLtvWad;
        (, uint256 creditPrice) = CDP.creditPriceSource();
        uint256 collValue = CDP.positionCollateralValue(positionId);
        uint256 ltv = collValue == 0 ? type(uint256).max : (CDP.positionDebt(positionId) * creditPrice / WAD) * WAD / collValue;
        if (ltv > cap) revert LtvAboveCap(ltv, cap);

        require(IERC20Min(repayToken).transfer(REPAY_TO, received), "TRANSFER_FAILED");
        CDP.transferPosition(positionId, owner);
        emit MembraneLegExecuted(owner, positionId, amount, borrowCdt, ltv);
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "APPROVE_FAILED");
    }
}
