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

    /// @dev Mirrors Uniswap v4-core's `SwapParams`. `amountSpecified` negative
    /// means exact input, positive means exact output.
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24 tick);

    /// @dev Returns a packed `BalanceDelta` (int256: high 128 bits = amount0,
    /// low 128 bits = amount1). Declared as a plain `int256` here so this
    /// local interface doesn't need the v4-core `BalanceDelta` user type.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 delta);

    function unlock(bytes calldata data) external returns (bytes memory);

    function sync(address currency) external;

    function settle() external payable returns (uint256 paid);

    function take(address currency, address to, uint256 amount) external;
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
