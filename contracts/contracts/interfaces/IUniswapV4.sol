// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev The small part of the v4 core/periphery surface used by PotatoV4Pad.
/// Keeping these interfaces local avoids adding the v4 npm packages just to
/// encode a pool key and a PositionManager action.
interface IUniswapV4PoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24 tick);
}

interface IUniswapV4PositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;

    function nextTokenId() external view returns (uint256);
}

interface IERC721Like {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IWETH9V4 {
    function deposit() external payable;

    function withdraw(uint256 amount) external;

    function transfer(address to, uint256 amount) external returns (bool);

    function balanceOf(address account) external view returns (uint256);
}
