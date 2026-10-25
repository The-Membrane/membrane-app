// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Call} from "bundler3/interfaces/IBundler3.sol";
import {Bundler3} from "bundler3/Bundler3.sol";
import {IMorphoBase} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MarketParams} from "morpho-blue/interfaces/IMorpho.sol";

import {Cdp} from "membrane/contracts/Cdp.sol";
import {CdpInternal} from "membrane/contracts/lib/CdpInternal.sol";
import {CdpRouter} from "membrane/contracts/periphery/CdpRouter.sol";

import {MembraneMigrationTest} from "./MembraneMigration.t.sol";
import {BatchExecutor} from "./mocks/BatchExecutor.sol";

/// @notice Review items Q41 (owner-approved 2026-10-25):
///   1. EIP-5792 one-prompt batch: approvals in place of permits, the operator grant AND its revoke
///      inside the same atomic batch, so nothing stays standing. Modelled with BatchExecutor etched
///      at the user's address (what an EIP-7702 delegation does); one `execute` == one prompt.
///   2. Deploy fresh through the existing CdpRouter.depositAndBorrow.
contract BatchAndRouterTest is MembraneMigrationTest {
    using MarketParamsLib for MarketParams;

    function _asWallet() internal {
        vm.etch(user, address(new BatchExecutor()).code);
    }

    function _bc(address to, bytes memory data) internal pure returns (BatchExecutor.Call memory) {
        return BatchExecutor.Call({to: to, value: 0, data: data});
    }

    /// The Aave batch as lib/migrate/exec.ts batchCallsFor builds it.
    function _aaveBatch(uint256 proceeds, uint256 aTokens, uint256 maxLtv) internal view returns (BatchExecutor.Call[] memory b) {
        Call[] memory withPermits = _aaveBundle(proceeds, aTokens, maxLtv);
        Call[] memory bundle = new Call[](2); // drop the two permit calls: approvals replace them
        bundle[0] = withPermits[2];
        bundle[1] = withPermits[3];
        b = new BatchExecutor.Call[](5);
        b[0] = _bc(address(aWeth), abi.encodeWithSignature("approve(address,uint256)", address(ga1), aTokens));
        b[1] = _bc(address(usdc), abi.encodeWithSignature("approve(address,uint256)", address(mAdapter), proceeds));
        b[2] = _bc(address(cdp), abi.encodeCall(Cdp.setPositionOperator, (address(mAdapter), true)));
        b[3] = _bc(address(bundler), abi.encodeCall(Bundler3.multicall, (bundle)));
        b[4] = _bc(address(cdp), abi.encodeCall(Cdp.setPositionOperator, (address(mAdapter), false)));
    }

    function _morphoBatch(uint256 proceeds, uint256 maxLtv) internal view returns (BatchExecutor.Call[] memory b) {
        Call[] memory withSigs = _morphoBundle(proceeds, maxLtv);
        Call[] memory bundle = new Call[](2);
        bundle[0] = withSigs[2];
        bundle[1] = withSigs[3];
        b = new BatchExecutor.Call[](6);
        b[0] = _bc(address(morpho), abi.encodeCall(IMorphoBase.setAuthorization, (address(ga1), true)));
        b[1] = _bc(address(usdc), abi.encodeWithSignature("approve(address,uint256)", address(mAdapter), proceeds));
        b[2] = _bc(address(cdp), abi.encodeCall(Cdp.setPositionOperator, (address(mAdapter), true)));
        b[3] = _bc(address(bundler), abi.encodeCall(Bundler3.multicall, (bundle)));
        b[4] = _bc(address(cdp), abi.encodeCall(Cdp.setPositionOperator, (address(mAdapter), false)));
        b[5] = _bc(address(morpho), abi.encodeCall(IMorphoBase.setAuthorization, (address(ga1), false)));
    }

    function test_Batch_Aave_OnePrompt_NothingStanding() public {
        _openAave(COLL, DEBT);
        _asWallet();
        BatchExecutor.Call[] memory b = _aaveBatch(_withBuffer(DEBT), COLL, BORROW_LTV - MARGIN);
        vm.prank(user);
        BatchExecutor(payable(user)).execute(b); // the one prompt
        assertEq(aave.variableDebt(address(usdc), user), 0, "Aave repaid");
        assertEq(cdp.positionDebt(_onlyPosition()), _withBuffer(DEBT) * SCALE, "opened on Membrane");
        assertFalse(cdp.positionOperator(user, address(mAdapter)), "grant revoked in the same batch");
        assertEq(usdc.allowance(user, address(mAdapter)), 0, "no USDC allowance left");
        assertEq(aWeth.allowance(user, address(ga1)), 0, "no aToken allowance left");
        _assertNoResidue();
    }

    function test_Batch_Morpho_OnePrompt_NothingStanding() public {
        _openMorpho(COLL, DEBT);
        _asWallet();
        BatchExecutor.Call[] memory b = _morphoBatch(_withBuffer(DEBT + 1e6), BORROW_LTV - MARGIN);
        vm.prank(user);
        BatchExecutor(payable(user)).execute(b);
        (, uint128 borrowShares,) = _pos(mkt.id(), user);
        assertEq(borrowShares, 0, "Morpho repaid");
        assertFalse(cdp.positionOperator(user, address(mAdapter)), "Membrane grant revoked");
        assertFalse(morpho.isAuthorized(user, address(ga1)), "Morpho authorization revoked");
        assertEq(usdc.allowance(user, address(mAdapter)), 0);
        _assertNoResidue();
    }

    /// Atomic: a failing middle step (82% LTV) reverts the whole batch — the grant is not left behind.
    function test_Batch_RevertsAtomically_NoGrantLeft() public {
        _openAave(COLL, 16_400e6);
        _asWallet();
        BatchExecutor.Call[] memory b = _aaveBatch(_withBuffer(16_400e6), COLL, BORROW_LTV - MARGIN);
        vm.prank(user);
        vm.expectRevert(Cdp.InsolventAfterAction.selector);
        BatchExecutor(payable(user)).execute(b);
        assertFalse(cdp.positionOperator(user, address(mAdapter)), "no grant left");
        assertEq(usdc.allowance(user, address(mAdapter)), 0, "no approval left");
        assertEq(aave.variableDebt(address(usdc), user), 16_400e6, "nothing moved");
    }

    // ------------------------------------------------------------------ deploy fresh via CdpRouter

    CdpInternal.Fund[] internal funds;

    function _routerFunds(uint256 a) internal returns (CdpInternal.Fund[] memory) {
        delete funds;
        funds.push(CdpInternal.Fund({denom: WETH, amount: a}));
        return funds;
    }

    function _noPermits() internal pure returns (CdpRouter.PermitData[] memory) {
        return new CdpRouter.PermitData[](0);
    }

    /// The router requires its operator grant for the borrow leg (CdpRouter.sol RouterNotApprovedOperator).
    function test_Router_WithoutOperator_Reverts() public {
        CdpRouter router = s.router;
        vm.startPrank(user);
        weth.approve(address(router), COLL);
        vm.expectRevert(abi.encodeWithSelector(CdpRouter.RouterNotApprovedOperator.selector, user, address(router)));
        router.depositAndBorrow(0, _routerFunds(COLL), WETH, 10_000e18, _noPermits());
        vm.stopPrank();
    }

    /// With the router's grant standing: approve + depositAndBorrow = 2 prompts (1 with a standing allowance).
    function test_Router_StandingGrant_TwoPrompts() public {
        CdpRouter router = s.router;
        vm.prank(user);
        cdp.setPositionOperator(address(router), true); // standing from an earlier deploy
        vm.prank(user);
        weth.approve(address(router), COLL); // prompt 1
        vm.prank(user);
        uint256 pid = router.depositAndBorrow(0, _routerFunds(COLL), WETH, 15_300e18, _noPermits()); // prompt 2
        assertEq(cdp.positionDebt(pid), 15_300e18);
        assertEq(s.cdt.balanceOf(user), 15_300e18, "CDT to the owner");
        assertEq(weth.allowance(user, address(router)), 0, "exact approval used up");
    }

    /// Batch: approve, grant router, depositAndBorrow, revoke router = 1 prompt, nothing standing.
    function test_Router_Batch_OnePrompt() public {
        CdpRouter router = s.router;
        _asWallet();
        BatchExecutor.Call[] memory b = new BatchExecutor.Call[](4);
        b[0] = _bc(address(weth), abi.encodeWithSignature("approve(address,uint256)", address(router), COLL));
        b[1] = _bc(address(cdp), abi.encodeCall(Cdp.setPositionOperator, (address(router), true)));
        b[2] = _bc(address(router), abi.encodeCall(CdpRouter.depositAndBorrow, (0, _routerFunds(COLL), WETH, 15_300e18, _noPermits())));
        b[3] = _bc(address(cdp), abi.encodeCall(Cdp.setPositionOperator, (address(router), false)));
        vm.prank(user);
        BatchExecutor(payable(user)).execute(b);
        assertEq(cdp.positionDebt(_onlyPosition()), 15_300e18);
        assertFalse(cdp.positionOperator(user, address(router)));
    }
}
