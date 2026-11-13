// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice TEST DOUBLE of an EIP-7702 / EIP-5792 wallet: code at the user's own address that runs
///         a list of calls atomically with msg.sender == the user. Tests etch it onto the user's
///         address (what a 7702 delegation does); the anvil e2e delegates to it with a real 7702
///         authorization. One call to `execute` == one wallet prompt.
contract BatchExecutor {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    error NotSelf();

    function execute(Call[] calldata calls) external payable {
        if (msg.sender != address(this)) revert NotSelf();
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
