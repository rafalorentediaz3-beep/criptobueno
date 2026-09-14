import { expect } from "chai";
import { ethers } from "hardhat";

const E = 10n ** 18n;
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };

describe("PotatoV4Pad", () => {
  async function deploy() {
    const [deployer, treasury, creator] = await ethers.getSigners();
    const poolManager = await (await ethers.getContractFactory("MockV4PoolManager")).deploy();
    const positionManager = await (
      await ethers.getContractFactory("MockV4PositionManager")
    ).deploy(poolManager.target);
    const weth = await (await ethers.getContractFactory("WETH9")).deploy();
    const pairRegistry = await (await ethers.getContractFactory("MockPairRegistry")).deploy();
    const pad = await (
      await ethers.getContractFactory("PotatoV4Pad")
    ).deploy(
      treasury.address,
      3n * E,
      10,
      poolManager.target,
      positionManager.target,
      weth.target,
      "0x0000000000000000000000000000000000000002",
      pairRegistry.target,
      deployer.address,
      [],
    );
    return { deployer, treasury, creator, poolManager, positionManager, weth, pairRegistry, pad };
  }

  it("maps the selectable fee percentages to v4 fee/tick-spacing pairs", async () => {
    const { pad } = await deploy();
    expect(await pad.tickSpacingForFee(100)).to.equal(1);
    expect(await pad.tickSpacingForFee(500)).to.equal(10);
    expect(await pad.tickSpacingForFee(3_000)).to.equal(60);
    expect(await pad.tickSpacingForFee(10_000)).to.equal(200);
    expect(await pad.tickSpacingForFee(20_000)).to.equal(400);
    await expect(pad.tickSpacingForFee(2_500))
      .to.be.revertedWithCustomError(pad, "InvalidFee");
  });

  it("launches a token with the requested fee without changing the v3 pad", async () => {
    const ctx = await deploy();
    const salt = ethers.id("v4-spud");
    const token = await ctx.pad.connect(ctx.creator).createToken.staticCall(
      "V4 Spud",
      "V4SPUD",
      NO_META,
      salt,
      20_000,
      { value: E / 10n },
    );
    const tx = await ctx.pad.connect(ctx.creator).createToken("V4 Spud", "V4SPUD", NO_META, salt, 20_000, {
      value: E / 10n,
    });
    await expect(tx).to.emit(ctx.pad, "V4PoolCreated");
    const info = await ctx.pad.v4Tokens(token);
    expect(info.creator).to.equal(ctx.creator.address);
    expect(info.fee).to.equal(20_000);
    expect(info.positionId).to.equal(1);
    expect(info.poolId).to.equal(await ctx.poolManager.lastPoolKey());

    // The real PositionManager requires every negative PoolManager delta to
    // be settled before unlock returns.  Keep this assertion alongside the
    // mock so a future action change cannot silently reintroduce the
    // non-settling `SETTLE(amount=0)` sequence.
    const [actions, params] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bytes", "bytes[]"],
      await ctx.positionManager.lastUnlockData(),
    );
    expect(actions).to.equal("0x020b0b14");
    expect(params).to.have.length(4);
  });

  it("launches a token with zero ETH — the dev buy is optional", async () => {
    const ctx = await deploy();
    const salt = ethers.id("v4-no-buy");
    const tx = await ctx.pad.connect(ctx.creator).createToken(
      "V4 No Buy",
      "V4NB",
      NO_META,
      salt,
      3_000,
      { value: 0n },
    );
    await expect(tx).to.emit(ctx.pad, "V4PoolCreated");
    await expect(tx).to.not.emit(ctx.pad, "DevBuy");
  });

  it("runs an optional dev buy when ETH is sent, crediting the buyer", async () => {
    const ctx = await deploy();
    const salt = ethers.id("v4-dev-buy");
    const token = await ctx.pad.connect(ctx.creator).createToken.staticCall(
      "V4 Dev Buy",
      "V4DB",
      NO_META,
      salt,
      500,
      { value: E / 10n },
    );
    const tx = await ctx.pad.connect(ctx.creator).createToken("V4 Dev Buy", "V4DB", NO_META, salt, 500, {
      value: E / 10n,
    });
    await expect(tx).to.emit(ctx.pad, "DevBuy");
    const erc20 = await ethers.getContractAt("PotatoToken", token);
    expect(await erc20.balanceOf(ctx.creator.address)).to.equal(E / 10n);
  });

  it("launches against an approved tokenized stock at a selectable 1% or 2% fee", async () => {
    const ctx = await deploy();
    const stock = await (await ethers.getContractFactory("WETH9")).deploy();
    await ctx.pairRegistry.configure(stock.target, 168n * E, 18, true);

    const salt = ethers.id("stock-pair");
    const token = await ctx.pad.connect(ctx.creator).createPairedToken.staticCall(
      "Apple Potato",
      "APPLP",
      NO_META,
      salt,
      stock.target,
      10_000,
    );
    const tx = ctx.pad.connect(ctx.creator).createPairedToken(
        "Apple Potato",
        "APPLP",
        NO_META,
        salt,
        stock.target,
        10_000,
      );
    await expect(tx).to.emit(ctx.pad, "V4PoolCreated");

    expect(await ctx.pad.quoteTokens(token)).to.equal(stock.target);
    const info = await ctx.pad.v4Tokens(token);
    const locker = await ethers.getContractAt("PotatoV4FeeLocker", await ctx.pad.locker());
    expect(await locker.launchedTokenByPosition(info.positionId)).to.equal(token);
    expect(await locker.quoteTokenByPosition(info.positionId)).to.equal(stock.target);

    await stock.deposit({ value: 100n * E });
    await stock.transfer(ctx.positionManager.target, 100n * E);
    await locker.collect(info.positionId);
    expect(await locker.claimable(stock.target, ctx.creator.address)).to.equal(70n * E);
    expect(await locker.claimable(stock.target, ctx.treasury.address)).to.equal(30n * E);

    const secondSalt = ethers.id("stock-pair-two-percent");
    const secondToken = await ctx.pad.connect(ctx.creator).createPairedToken.staticCall(
      "Apple Potato Two",
      "APLP2",
      NO_META,
      secondSalt,
      stock.target,
      20_000,
    );
    await ctx.pad.connect(ctx.creator).createPairedToken(
      "Apple Potato Two",
      "APLP2",
      NO_META,
      secondSalt,
      stock.target,
      20_000,
    );
    expect((await ctx.pad.v4Tokens(secondToken)).fee).to.equal(20_000);
  });

  it("launches an unlisted custom pair at the pad's standard opening FDV", async () => {
    const ctx = await deploy();
    const custom = await (await ethers.getContractFactory("WETH9")).deploy();
    const salt = ethers.id("custom-pair");
    const token = await ctx.pad.connect(ctx.creator).createPairedToken.staticCall(
      "Custom Pair Potato",
      "CPPAIR",
      NO_META,
      salt,
      custom.target,
      10_000,
    );

    const tx = await ctx.pad.connect(ctx.creator).createPairedToken(
      "Custom Pair Potato",
      "CPPAIR",
      NO_META,
      salt,
      custom.target,
      10_000,
    );
    await expect(tx).to.emit(ctx.pad, "V4PoolCreated");
    expect(await ctx.pairRegistry.approvedPairTokens(custom.target)).to.equal(false);
    expect(await ctx.pad.quoteTokens(token)).to.equal(custom.target);
    expect(await ctx.pad.startFdv()).to.equal(3n * E);
  });

  it("rejects non-18-decimal pairs, native value, and nonstandard fees", async () => {
    const ctx = await deploy();
    const stock = await (await ethers.getContractFactory("WETH9")).deploy();
    const args = ["Stock", "STK", NO_META, ethers.id("guards"), stock.target] as const;

    const sixDecimal = await (await ethers.getContractFactory("SixDecimalToken")).deploy();
    const sixDecimalArgs = ["Six Decimal", "SIX", NO_META, ethers.id("six-decimals"), sixDecimal.target] as const;
    await expect(ctx.pad.connect(ctx.creator).createPairedToken(...sixDecimalArgs, 10_000))
      .to.be.revertedWithCustomError(ctx.pad, "PairTokenDecimalsUnsupported");
    await ctx.pairRegistry.configure(stock.target, E, 6, true);
    await expect(ctx.pad.connect(ctx.creator).createPairedToken(...args, 10_000))
      .to.be.revertedWithCustomError(ctx.pad, "PairTokenDecimalsUnsupported");
    await ctx.pairRegistry.configure(stock.target, E, 18, true);
    await expect(ctx.pad.connect(ctx.creator).createPairedToken(...args, 3_000))
      .to.be.revertedWithCustomError(ctx.pad, "InvalidFee");
    await expect(ctx.pad.connect(ctx.creator).createPairedToken(...args, 10_000, { value: 1n }))
      .to.be.revertedWithCustomError(ctx.pad, "UnexpectedNativeValue");
  });
});
