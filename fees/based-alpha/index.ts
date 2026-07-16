// DefiLlama dimension adapter for Based Alpha — volume, fees, revenue.
//
// Destination: dimension-adapters/fees/based-alpha/index.ts
// (optionally re-exported from dexs/based-alpha/index.ts so curve volume also
// shows on the DEX/volume dashboards — see docs/defillama/README.md).
// CHAIN.ROBINHOOD already exists in helpers/chains.ts.
//
// Every curve trade emits Trade(...) with the exact fee split, so all
// dimensions come from a single getLogs pass; migration fees come from
// Migrated(...). Verified against mainnet logs from deploy block 10227218.

import { FetchOptions, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";

const LAUNCHPAD = "0x5640c62fe43a64f9ae0811114874e95a819db744";

const TRADE_EVENT =
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 protocolFee, uint256 creatorFee, uint256 virtualEth, uint256 virtualToken, uint256 tokensSold)";
const MIGRATED_EVENT =
  "event Migrated(address indexed token, address indexed pool, uint256 ethAdded, uint256 tokensAdded, uint256 migrationFee)";
const TOKEN_CREATED_EVENT =
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI, uint256 virtualEth, uint256 virtualToken)";

const fetch = async (options: FetchOptions) => {
  const dailyVolume = options.createBalances();
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  const dailySupplySideRevenue = options.createBalances();

  const trades = await options.getLogs({ target: LAUNCHPAD, eventAbi: TRADE_EVENT });
  for (const t of trades) {
    // ethAmount is the gross ETH side of the trade (fees included on buys,
    // pre-fee proceeds on sells) — the launchpad's notional curve volume.
    dailyVolume.addGasToken(t.ethAmount);
    dailyFees.addGasToken(t.protocolFee + t.creatorFee);
    dailyRevenue.addGasToken(t.protocolFee);
    // Creator fees accrue to the token creator (pump.fun-style) — supply side.
    dailySupplySideRevenue.addGasToken(t.creatorFee);
  }

  const migrations = await options.getLogs({ target: LAUNCHPAD, eventAbi: MIGRATED_EVENT });
  for (const m of migrations) {
    dailyFees.addGasToken(m.migrationFee);
    dailyRevenue.addGasToken(m.migrationFee);
  }

  // One-time creation fee (0.005 ETH, config-tunable). The TokenCreated event
  // doesn't carry the fee, so count launches × the configured fee. The public
  // RPC is non-archival, so read at latest (adapters run near-realtime daily)
  // with the deploy default as fallback.
  const launches = await options.getLogs({ target: LAUNCHPAD, eventAbi: TOKEN_CREATED_EVENT });
  if (launches.length > 0) {
    let creationFee = 5_000_000_000_000_000n; // 0.005 ETH deploy default
    try {
      creationFee = BigInt(
        await options.api.call({ target: LAUNCHPAD, abi: "uint96:creationFee", block: "latest" }),
      );
    } catch {
      // pruned historical state — keep the default
    }
    dailyFees.addGasToken(creationFee * BigInt(launches.length));
    dailyRevenue.addGasToken(creationFee * BigInt(launches.length));
  }

  return {
    dailyVolume,
    dailyFees,
    dailyRevenue,
    dailyProtocolRevenue: dailyRevenue,
    dailySupplySideRevenue,
  };
};

const methodology = {
  Volume: "Gross ETH notional of every bonding-curve buy and sell on the launchpad.",
  Fees: "1.25% trade fee (0.95% protocol + 0.30% creator) on every curve trade, plus the flat migration fee skimmed at graduation and the one-time 0.005 ETH token-creation fee.",
  Revenue: "Protocol share of trade fees plus migration and creation fees.",
  ProtocolRevenue: "Same as Revenue — all protocol fees accrue to the fee recipient.",
  SupplySideRevenue: "Creator share of trade fees (0.30%), claimable by each token's creator.",
};

const adapter: SimpleAdapter = {
  version: 2,
  adapter: {
    [CHAIN.ROBINHOOD]: {
      fetch,
      start: "2026-07-15",
      meta: { methodology },
    },
  },
};

export default adapter;
