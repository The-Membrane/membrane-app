// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Call} from "bundler3/interfaces/IBundler3.sol";
import {GeneralAdapter1} from "bundler3/adapters/GeneralAdapter1.sol";
import {AaveV3MigrationAdapter} from "bundler3/adapters/migration/AaveV3MigrationAdapter.sol";
import {CoreAdapter} from "bundler3/adapters/CoreAdapter.sol";

import {MembraneMigrationTest} from "../MembraneMigration.t.sol";
import {MembraneBundlerAdapterV2} from "../../src/variants/MembraneBundlerAdapterV2.sol";

/// @notice The two-prompt migration that the DRAFT core patch Q41-M2 (Cdp.transferPosition) enables.
///         FLAG: every test here skips itself unless the linked membrane-solidity Cdp has
///         `transferPosition` (apply membrane-board inbox/patches/membrane-solidity/0001-… first).
contract AdapterV2Test is MembraneMigrationTest {
    MembraneBundlerAdapterV2 internal v2;

    function _patched() internal returns (bool) {
        (bool ok, bytes memory ret) = address(cdp).call(abi.encodeWithSignature("transferPosition(uint256,address)", type(uint256).max, address(1)));
        // patched Cdp: reverts NotPositionOwner(); unpatched: no such selector, empty revert
        return !ok && ret.length == 4 && bytes4(ret) == bytes4(keccak256("NotPositionOwner()"));
    }

    function _setUpV2() internal {
        if (!_patched()) vm.skip(true);
        v2 = new MembraneBundlerAdapterV2(address(bundler), address(cdp), address(ga1));
    }

    function _v2Bundle(uint256 proceeds, uint256 aTokens, uint256 maxLtv) internal view returns (Call[] memory outer) {
        Call[] memory inner = new Call[](6);
        inner[0] = _c(address(ga1), abi.encodeCall(CoreAdapter.erc20Transfer, (address(usdc), address(aaveAdapter), type(uint256).max)));
        inner[1] = _c(address(aaveAdapter), abi.encodeCall(AaveV3MigrationAdapter.aaveV3Repay, (address(usdc), type(uint256).max, 2, user)));
        inner[2] = _c(address(aaveAdapter), abi.encodeCall(CoreAdapter.erc20Transfer, (address(usdc), address(ga1), type(uint256).max)));
        inner[3] = _c(address(ga1), abi.encodeCall(GeneralAdapter1.erc20TransferFrom, (address(aWeth), address(aaveAdapter), aTokens)));
        inner[4] = _c(address(aaveAdapter), abi.encodeCall(AaveV3MigrationAdapter.aaveV3Withdraw, (address(weth), type(uint256).max, address(v2))));
        inner[5] = _c(address(v2), abi.encodeCall(MembraneBundlerAdapterV2.openBorrowAndTransfer, (WETH, proceeds * SCALE, address(usdc), maxLtv)));
        outer = new Call[](3);
        outer[0] = _permitCall(address(aWeth), address(ga1), aTokens); // prompt 1 (typed data)
        outer[1] = _flash(proceeds, inner);
        outer[2] = _sweepToUser();
    }

    /// Plain EOA, Aave: aToken permit + ONE transaction. No Membrane grant, no proceeds permit.
    function test_V2_Aave_TwoPrompts_NoGrant() public {
        _setUpV2();
        _openAave(COLL, DEBT);
        uint256 usdcBefore = usdc.balanceOf(user);
        Call[] memory b = _v2Bundle(_withBuffer(DEBT), COLL, BORROW_LTV - MARGIN);
        vm.prank(user);
        bundler.multicall(b); // prompt 2
        assertEq(aave.variableDebt(address(usdc), user), 0, "Aave repaid");
        uint256 pid = _onlyPosition(); // owned by the user after the transfer
        assertEq(cdp.positionDebt(pid), _withBuffer(DEBT) * SCALE);
        assertFalse(cdp.positionOperator(user, address(v2)), "no grant ever");
        assertEq(usdc.balanceOf(user), usdcBefore + (_withBuffer(DEBT) - DEBT), "only the unspent buffer comes back");
        assertEq(usdc.allowance(user, address(v2)), 0, "no proceeds permit at all");
        vm.expectRevert(); // the adapter's position index is empty again: it keeps nothing
        cdp.userPositionIds(address(v2), 0);
    }

    function test_V2_LtvAboveCap_Reverts() public {
        _setUpV2();
        _openAave(COLL, 15_900e6);
        Call[] memory b = _v2Bundle(_withBuffer(15_900e6), COLL, 1e18);
        vm.prank(user);
        vm.expectRevert();
        bundler.multicall(b);
        assertEq(aWeth.balanceOf(user), COLL, "nothing moved");
    }

    /// MEDIUM-2: anyone can fill the adapter's 9 position slots with 1-wei deposits for it, and
    /// every migration then reverts TooManyPositions. `evict` (permissionless) sheds one to its
    /// sink and the migration works again.
    function test_V2_SlotFill_Evict_RestoresMigration() public {
        _setUpV2();
        _openAave(COLL, DEBT);
        uint256 cap = cdp.MAX_POSITIONS_AMOUNT();
        weth.mint(ATTACKER, cap);
        vm.startPrank(ATTACKER);
        weth.approve(address(cdp), type(uint256).max);
        uint256[] memory dust = new uint256[](cap);
        for (uint256 i; i < cap; ++i) dust[i] = cdp.deposit(0, address(v2), _funds(1));
        vm.stopPrank();
        assertEq(cdp.userPositionIds(address(v2), cap - 1), dust[cap - 1], "precondition: 9 slots full");

        Call[] memory b = _v2Bundle(_withBuffer(DEBT), COLL, BORROW_LTV - MARGIN);
        vm.prank(user);
        vm.expectRevert(); // TooManyPositions inside the leg: the DoS
        bundler.multicall(b);
        assertEq(aWeth.balanceOf(user), COLL, "nothing moved while full");

        // a stranger frees a slot
        address sink = v2.sinkFor(dust[0]);
        vm.prank(address(0xE71C7));
        v2.evict(dust[0]);
        (, address holder,,,,) = cdp.position(dust[0]);
        assertEq(holder, sink, "dust went to its sink");

        vm.prank(user);
        bundler.multicall(b);
        assertEq(aave.variableDebt(address(usdc), user), 0, "migration works again");
        assertEq(cdp.positionDebt(_onlyPosition()), _withBuffer(DEBT) * SCALE, "the user owns the new position");
    }

    /// Negative controls for evict: a position the adapter does not hold, and a missing id.
    function test_V2_Evict_NotHeld_Reverts() public {
        _setUpV2();
        _openAave(COLL, DEBT);
        Call[] memory b = _v2Bundle(_withBuffer(DEBT), COLL, BORROW_LTV - MARGIN); // before the prank
        vm.prank(user);
        bundler.multicall(b);
        uint256 pid = _onlyPosition(); // the user's migrated position
        vm.expectRevert(abi.encodeWithSelector(MembraneBundlerAdapterV2.NotHeld.selector, pid));
        v2.evict(pid);
        vm.expectRevert(abi.encodeWithSelector(MembraneBundlerAdapterV2.NotHeld.selector, uint256(999_999)));
        v2.evict(999_999);
        (, address holder,,,,) = cdp.position(pid);
        assertEq(holder, user, "the user's position is untouched");
    }

    /// Sinks are distinct per position, so nine evictions cannot fill one sink's own 9 slots.
    function test_V2_SinkIsPerPosition() public {
        _setUpV2();
        assertTrue(v2.sinkFor(1) != v2.sinkFor(2), "distinct sinks");
        assertTrue(v2.sinkFor(1) != address(0), "non-zero sink");
    }
}
