const NETWORKS = {
  mainnet: {
    name: 'Mainnet',
    api: 'https://mainnet.zklighter.elliot.ai',
    ws: 'wss://mainnet.zklighter.elliot.ai/stream',
    chainId: 304,
    app: 'https://app.lighter.xyz',
  },
  testnet: {
    name: 'Testnet',
    api: 'https://testnet.zklighter.elliot.ai',
    ws: 'wss://testnet.zklighter.elliot.ai/stream',
    chainId: 300,
    app: 'https://testnet.app.lighter.xyz',
  },
};

const env = import.meta.env ?? {};
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const NETWORK = NETWORKS[env.VITE_LIGHTER_NETWORK] ?? NETWORKS.testnet;

// API key slot this frontend owns on the user's account. 0/1 are used by
// Lighter's own apps; registering over them would log the user out there.
export const API_KEY_INDEX = num(env.VITE_API_KEY_INDEX, 7);
if (!(API_KEY_INDEX >= 2 && API_KEY_INDEX <= 254)) {
  throw new Error('VITE_API_KEY_INDEX must be between 2 and 254');
}

export const WALLETCONNECT_PROJECT_ID = env.VITE_WALLETCONNECT_PROJECT_ID || '';

const integratorIndex = num(env.VITE_INTEGRATOR_ACCOUNT_INDEX, null);
const takerFee = num(env.VITE_INTEGRATOR_TAKER_FEE, 0); // millionths of notional
const makerFee = num(env.VITE_INTEGRATOR_MAKER_FEE, 0);
export const INTEGRATOR =
  integratorIndex !== null && (takerFee > 0 || makerFee > 0)
    ? { accountIndex: integratorIndex, takerFee, makerFee }
    : null;

// Lighter transaction type ids (lighter-go/types/txtypes/constants.go)
export const TX_TYPE = {
  CHANGE_PUB_KEY: 8,
  CREATE_ORDER: 14,
  CANCEL_ORDER: 15,
  CANCEL_ALL_ORDERS: 16,
  UPDATE_LEVERAGE: 20,
  APPROVE_INTEGRATOR: 45,
};

export const ORDER_TYPE = { LIMIT: 0, MARKET: 1 };
export const TIME_IN_FORCE = { IOC: 0, GTT: 1, POST_ONLY: 2 };
export const MARGIN_MODE = { CROSS: 0, ISOLATED: 1 };
