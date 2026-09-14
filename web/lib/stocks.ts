import type { Address } from "viem";

export interface RobinhoodStock {
  symbol: string;
  name: string;
  type: "stock" | "etp";
  imageUrl: string;
  address: Address;
  decimals: 18;
}

const PAIRS: ReadonlyArray<readonly [string, string, Address]> = [
  ["AAPL", "Apple", "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9"],
  ["AMC", "AMC Entertainment", "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b"],
  ["AMD", "AMD", "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc"],
  ["AMZN", "Amazon", "0x12f190a9f9d7d37a250758b26824b97ce941bf54"],
  ["BA", "Boeing", "0x4d21483a44bf67a86b77e3da301411880797d452"],
  ["BABA", "Alibaba", "0xad25ac6c84d497db898fa1e8387bf6af3532a1c4"],
  ["BB", "BlackBerry", "0x48e39e56acdba37b09020c0b734a613c9a2f100a"],
  ["BE", "Bloom Energy", "0x822cc93ffd030293e9842c30bbd678f530701867"],
  ["BULL", "Webull", "0xcef9027c7d6985b85f0ba431125073529a947a68"],
  ["CEG", "Constellation Energy", "0xae517a2903e68bd929dfd15be875f8369d53e94a"],
  ["COIN", "Coinbase", "0x6330d8c3178a418788df01a47479c0ce7ccf450b"],
  ["COST", "Costco", "0x4ea005168d7f09a7a0ba9d1def21a479950e44c2"],
  ["CRCL", "Circle Internet Group", "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5"],
  ["DELL", "Dell", "0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd"],
  ["DJT", "Trump Media & Technology Group", "0x1d11f0496982706c5e14a514d4e79f2e6bde4516"],
  ["EWY", "iShares MSCI South Korea ETF", "0x7f0abef0c07280f82c6a08ead09ded6bae2c13fc"],
  ["F", "Ford Motor", "0x25c288e6d899b9bc30160965ad9644c67e73be0c"],
  ["FIG", "Figma", "0x41f4267525a8aff329540ef24fd83d9044758b33"],
  ["GLD", "SPDR Gold Trust", "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e"],
  ["GME", "GameStop", "0x1b0e319c6a659f002271b69db8a7df2f911c153e"],
  ["GOOGL", "Alphabet Class A", "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3"],
  ["HIMS", "Hims & Hers Health", "0xccee82fe024c36fa15e1005ede3e9e4787e23d09"],
  ["IBM", "IBM", "0x980dcf6766fa79f5cf0c4aadb3ab477ff15a9619"],
  ["INDA", "iShares MSCI India ETF", "0xacef2e09adb47ad6abebad9ff06689e60615c2b6"],
  ["INTC", "Intel", "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681"],
  ["JNJ", "Johnson & Johnson", "0x03dfbbe0ac4e7bcdafd08ed41a400326b77d8c80"],
  ["LLY", "Eli Lilly", "0x8005d266423c7ea827372c9c864491e5786600ea"],
  ["LMT", "Lockheed Martin", "0x329fcaceb9ad6f9580dd5f643fed0646900d043c"],
  ["LULU", "Lululemon", "0x4e62068525ab11fe768e29dfd00ef909b9803016"],
  ["META", "Meta Platforms", "0xc0d6457c16cc70d6790dd43521c899c87ce02f35"],
  ["MRNA", "Moderna", "0x43b07d15ce533bec5476d70c22a78a1b2b662155"],
  ["MRVL", "Marvell Technology", "0x62fd0668e10d8b72339be2dcf7643001688ff13b"],
  ["MSFT", "Microsoft", "0xe93237c50d904957cf27e7b1133b510c669c2e74"],
  ["MSTR", "Strategy", "0xec262a75e413fafd0df80480274532c79d42da09"],
  ["MU", "Micron Technology", "0xff080c8ce2e5feadaca0da81314ae59d232d4afd"],
  ["NET", "Cloudflare", "0x116f00968269b7bfbad4109ce591d6e74c0601d4"],
  ["NFLX", "Netflix", "0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8"],
  ["NU", "Nu Holdings", "0x408c14038a04f7bd235329e26d2bf569ee20e250"],
  ["NVDA", "NVIDIA", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"],
  ["PFE", "Pfizer", "0x7066a64c24e4206cd62e83bf198c1e7eb361f51e"],
  ["PLTR", "Palantir Technologies", "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a"],
  ["QQQ", "Invesco QQQ", "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68"],
  ["QUBT", "Quantum Computing", "0x59818904ab4ce163b3ce4ffb64f2d6ca02c434b4"],
  ["RBLX", "Roblox", "0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8"],
  ["RCAT", "Red Cat", "0xfde6b5d9bb419b10c23268c74e369abff39c0460"],
  ["RDDT", "Reddit", "0x05b37fb53a299a1b874a619e1c4c404d52c36f4c"],
  ["RIVN", "Rivian Automotive", "0xb1bf26c1d20ff267a4f93550d1e0d06ac40a114b"],
  ["RKLB", "Rocket Lab", "0x3b14c39e89d60d627b42a1a4ca45b5bb45fc12e2"],
  ["SGOV", "iShares 0-3 Month Treasury Bond ETF", "0x92fd66527192e3e61d4ddd13322aa222de86f9b5"],
  ["SHOP", "Shopify", "0xf53f66751b1eff985311b693531e3290f600c410"],
  ["SKHY", "SK hynix", "0x84cab63bc87912e71ad199ff14a0ba45de68fef8"],
  ["SLV", "iShares Silver Trust", "0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f"],
  ["SNDK", "Sandisk", "0xb90a19ff0af67f7779aff50a882a9cff42446400"],
  ["SNAP", "Snap", "0xf6589f11bc40b669e584073f428b05562f568733"],
  ["SNOW", "Snowflake", "0xba0cab75495255d0cb58e22b648bfed4ecd1f47e"],
  ["SPCX", "SpaceX", "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea"],
  ["SPY", "SPDR S&P 500 ETF Trust", "0x117cc2133c37b721f49de2a7a74833232b3b4c0c"],
  ["TSLA", "Tesla", "0x322f0929c4625ed5bad873c95208d54e1c003b2d"],
  ["TSM", "Taiwan Semiconductor Manufacturing", "0x58ffe4a942d3885baa22d7520691f611ef09e7aa"],
  ["TTWO", "Take-Two Interactive", "0x5e81213613b6b86eab4c6c50d718d34359459786"],
  ["UPS", "UPS", "0xf23250dac154d05bb671cb0d0ebef3c635c79ce2"],
  ["USO", "United States Oil Fund", "0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344"],
  ["WYFI", "WhiteFiber", "0x9e7abd3c9139d14e4c86dce0e455aab7a0c2fb3e"],
];

export const ROBINHOOD_TOKENIZED_STOCKS: RobinhoodStock[] = PAIRS.map(
  ([symbol, name, address]) => ({
    symbol,
    name,
    address,
    decimals: 18,
    type: ["EWY", "GLD", "INDA", "QQQ", "SGOV", "SLV", "SPY", "USO"].includes(symbol)
      ? "etp"
      : "stock",
    imageUrl: `/api/robinhood/logo?symbol=${encodeURIComponent(symbol)}&v=5`,
  }),
);
