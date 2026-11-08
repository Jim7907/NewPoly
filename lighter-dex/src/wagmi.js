import { createConfig, http } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';
import { WALLETCONNECT_PROJECT_ID } from './lighter/config.js';

// The wallet only signs text messages (key registration / builder-fee approval),
// so any chain works; Ethereum mainnet is where Lighter's bridge lives.
export const wagmiConfig = createConfig({
  chains: [mainnet],
  connectors: [
    injected(),
    ...(WALLETCONNECT_PROJECT_ID
      ? [walletConnect({ projectId: WALLETCONNECT_PROJECT_ID, showQrModal: true })]
      : []),
  ],
  transports: { [mainnet.id]: http() },
});
