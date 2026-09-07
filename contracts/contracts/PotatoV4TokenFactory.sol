// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PotatoToken} from "./PotatoToken.sol";

/// @dev V4 counterpart of PotatoTokenFactory. It is separate because the
/// anti-snipe exemptions must point at the v4 PositionManager and fee locker.
contract PotatoV4TokenFactory {
    address public immutable pad;
    address public immutable positionManager;
    address public immutable locker;
    uint256 public immutable totalSupply;
    uint256 public immutable maxWallet;
    uint256 public immutable antiSnipeBlocks;

    error OnlyPad();
    error DeployFailed();

    constructor(
        address positionManager_,
        address locker_,
        uint256 totalSupply_,
        uint256 maxWallet_,
        uint256 antiSnipeBlocks_
    ) {
        pad = msg.sender;
        positionManager = positionManager_;
        locker = locker_;
        totalSupply = totalSupply_;
        maxWallet = maxWallet_;
        antiSnipeBlocks = antiSnipeBlocks_;
    }

    function initCodeHash(string calldata name, string calldata symbol)
        external
        view
        returns (bytes32)
    {
        return keccak256(_initCode(name, symbol));
    }

    function deploy(string calldata name, string calldata symbol, bytes32 salt)
        external
        returns (address deployed)
    {
        if (msg.sender != pad) revert OnlyPad();
        bytes memory code = _initCode(name, symbol);
        assembly ("memory-safe") {
            deployed := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (deployed == address(0)) revert DeployFailed();
    }

    function _initCode(string calldata name, string calldata symbol)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(PotatoToken).creationCode,
            abi.encode(
                name,
                symbol,
                totalSupply,
                pad,
                positionManager,
                locker,
                maxWallet,
                antiSnipeBlocks
            )
        );
    }
}
