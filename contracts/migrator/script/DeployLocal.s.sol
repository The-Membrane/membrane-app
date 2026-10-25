// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {MembraneStack} from "./MembraneStack.sol";

/// @notice LOCAL ANVIL ONLY. Stands up MembraneStack (see there) and seeds three anvil accounts.
///
///   anvil --disable-code-size-limit ; forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 \
///     --broadcast --slow --disable-code-size-limit
///
/// Writes deployments/local.json.
contract DeployLocal is Script, MembraneStack {
    // anvil default accounts (public test keys)
    uint256 constant PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // deployer / owner
    uint256 constant PK2 = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a; // Aave looper
    uint256 constant PK3 = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6; // Morpho looper
    uint256 constant PK4 = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a; // Aave, over the line

    function run() external {
        address owner = vm.addr(PK0);
        vm.startBroadcast(PK0);
        S memory s = _deployStack(owner);
        s.weth.mint(vm.addr(PK2), 20e18);
        s.weth.mint(vm.addr(PK3), 20e18);
        s.weth.mint(vm.addr(PK4), 20e18);
        vm.stopBroadcast();
        _seedPositions(s);
        _write(s);
    }

    function _seedPositions(S memory s) internal {
        // #2: Aave 10 WETH / 12,000 USDC (60%)
        vm.startBroadcast(PK2);
        s.weth.approve(address(s.aave), 10e18);
        s.aave.supply(address(s.weth), 10e18, vm.addr(PK2), 0);
        s.aave.borrow(address(s.usdc), 12_000e6, 2, 0, vm.addr(PK2));
        vm.stopBroadcast();
        // #3: Morpho 10 WETH / 12,000 USDC
        vm.startBroadcast(PK3);
        s.weth.approve(address(s.morpho), 10e18);
        s.morpho.supplyCollateral(s.mkt, 10e18, vm.addr(PK3), "");
        s.morpho.borrow(s.mkt, 12_000e6, 0, vm.addr(PK3), vm.addr(PK3));
        vm.stopBroadcast();
        // #4: Aave 10 WETH / 16,400 USDC (82%) — over Membrane's borrow LTV
        vm.startBroadcast(PK4);
        s.weth.approve(address(s.aave), 10e18);
        s.aave.supply(address(s.weth), 10e18, vm.addr(PK4), 0);
        s.aave.borrow(address(s.usdc), 16_400e6, 2, 0, vm.addr(PK4));
        vm.stopBroadcast();
    }

    function _write(S memory s) internal {
        string memory k = "local";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "bundler3", address(s.bundler));
        vm.serializeAddress(k, "generalAdapter1", address(s.ga1));
        vm.serializeAddress(k, "aaveV3Adapter", address(s.aaveAdapter));
        vm.serializeAddress(k, "morpho", address(s.morpho));
        vm.serializeAddress(k, "morphoOracle", s.mkt.oracle);
        vm.serializeAddress(k, "morphoIrm", s.mkt.irm);
        vm.serializeUint(k, "morphoLltv", s.mkt.lltv);
        vm.serializeAddress(k, "aavePool", address(s.aave));
        vm.serializeAddress(k, "cdp", address(s.cdp));
        vm.serializeAddress(k, "transmuter", address(s.transmuter));
        vm.serializeAddress(k, "membraneAdapter", address(s.mAdapter));
        vm.serializeAddress(k, "usdc", address(s.usdc));
        vm.serializeAddress(k, "cdt", address(s.cdt));
        vm.serializeAddress(k, "weth", address(s.weth));
        vm.serializeAddress(k, "oracle", address(s.oracle));
        vm.serializeAddress(k, "aaveLooper", vm.addr(PK2));
        vm.serializeAddress(k, "morphoLooper", vm.addr(PK3));
        vm.serializeAddress(k, "hotLooper", vm.addr(PK4));
        string memory json = vm.serializeBytes32(k, "wethDenom", WETH);
        vm.writeJson(json, "deployments/local.json");
        console2.log("wrote deployments/local.json");
    }
}
