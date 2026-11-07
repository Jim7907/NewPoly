// Session state for one connected wallet:
//   wallet address -> Lighter account index -> browser-held API key -> trading.
//
// Lighter orders are signed by an "API key" (a Lighter-native keypair), not by
// the wallet directly. The wallet signs ONE message to authorize that key
// (ChangePubKey); after that, orders are signed instantly in the browser with
// no wallet popups. The API key can trade but cannot withdraw to a foreign address.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount, useSignMessage } from 'wagmi';
import * as api from './api.js';
import { LighterSigner } from './signer.js';
import { API_KEY_INDEX, INTEGRATOR, NETWORK, TX_TYPE } from './config.js';

const keyStorageId = (address, accountIndex) =>
  `lighter-key:${NETWORK.chainId}:${address.toLowerCase()}:${accountIndex}:${API_KEY_INDEX}`;
const integratorStorageId = (address, accountIndex) =>
  `lighter-integrator:${NETWORK.chainId}:${address.toLowerCase()}:${accountIndex}:${INTEGRATOR?.accountIndex}`;

const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* storage unavailable: key lives for this tab only */ }
  },
  del(k) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  },
};

const normHex = (h) => String(h ?? '').toLowerCase().replace(/^0x/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INTEGRATOR_APPROVAL_MS = 180 * 24 * 3600 * 1000;

/**
 * status:
 *  'disconnected' | 'loading' | 'no-account' (never deposited on Lighter)
 *  'needs-key' (must sign once to enable trading) | 'needs-integrator' | 'ready' | 'error'
 */
export function useLighter() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState('disconnected');
  const [error, setError] = useState(null);
  const [accountIndex, setAccountIndex] = useState(null);
  const [busy, setBusy] = useState(false);

  const signerRef = useRef(null);
  const nonceRef = useRef(null);
  const queueRef = useRef(Promise.resolve());
  const authRef = useRef(null);

  // ---- bootstrap on wallet change ----
  useEffect(() => {
    let cancelled = false;
    signerRef.current = null;
    nonceRef.current = null;
    authRef.current = null;
    setAccountIndex(null);
    setError(null);
    if (!isConnected || !address) {
      setStatus('disconnected');
      return;
    }
    setStatus('loading');
    (async () => {
      const idx = await api.getAccountIndexByAddress(address);
      if (cancelled) return;
      if (idx === null) return setStatus('no-account');
      setAccountIndex(idx);

      const stored = store.get(keyStorageId(address, idx));
      if (stored) {
        const signer = new LighterSigner({ accountIndex: idx, apiKeyIndex: API_KEY_INDEX });
        const nonce = await api.getNextNonce(idx, API_KEY_INDEX);
        const { publicKey } = await signer.init({ privateKey: stored, nonce });
        const onChain = await api.getApiKeyPublicKey(idx, API_KEY_INDEX);
        if (cancelled) return;
        if (onChain && normHex(onChain) === normHex(publicKey)) {
          signerRef.current = signer;
          nonceRef.current = nonce;
          return setStatus(needsIntegrator(address, idx) ? 'needs-integrator' : 'ready');
        }
        store.del(keyStorageId(address, idx)); // key was replaced/revoked elsewhere
      }
      setStatus('needs-key');
    })().catch((e) => {
      if (cancelled) return;
      setError(e.message);
      setStatus('error');
    });
    return () => {
      cancelled = true;
    };
  }, [address, isConnected]);

  // ---- one-time key registration (1 wallet signature) ----
  const enableTrading = useCallback(async () => {
    if (accountIndex === null || !address) return;
    setBusy(true);
    setError(null);
    try {
      const signer = new LighterSigner({ accountIndex, apiKeyIndex: API_KEY_INDEX });
      const nonce = await api.getNextNonce(accountIndex, API_KEY_INDEX);
      const { publicKey, privateKey, changePubKeyMessage } = await signer.init({ nonce });
      const l1Sig = await signMessageAsync({ message: changePubKeyMessage });
      const { txInfo } = await signer.signChangePubKey(l1Sig, nonce);
      await api.sendTx(TX_TYPE.CHANGE_PUB_KEY, txInfo);

      // Wait until the key is live on Lighter before signing orders with it.
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        const onChain = await api.getApiKeyPublicKey(accountIndex, API_KEY_INDEX).catch(() => null);
        if (onChain && normHex(onChain) === normHex(publicKey)) break;
        if (i === 29) throw new Error('Key registration not confirmed yet — refresh in a moment');
      }
      store.set(keyStorageId(address, accountIndex), privateKey);
      signerRef.current = signer;
      nonceRef.current = null; // ChangePubKey consumed a nonce; refetch
      setStatus(needsIntegrator(address, accountIndex) ? 'needs-integrator' : 'ready');
    } catch (e) {
      setError(shortErr(e));
    } finally {
      setBusy(false);
    }
  }, [accountIndex, address, signMessageAsync]);

  // ---- serialized tx submission with local nonce tracking ----
  const submit = useCallback((txType, signFn) => {
    const run = async () => {
      const signer = signerRef.current;
      if (!signer) throw new Error('Trading not enabled');
      if (nonceRef.current === null) nonceRef.current = await api.getNextNonce(signer.accountIndex, signer.apiKeyIndex);
      const nonce = nonceRef.current;
      try {
        const { txInfo, txHash } = await signFn(signer, nonce);
        const res = await api.sendTx(txType, txInfo);
        nonceRef.current = nonce + 1;
        return { txHash: res.tx_hash ?? txHash };
      } catch (e) {
        nonceRef.current = null; // resync from server on any failure
        throw e;
      }
    };
    const p = queueRef.current.then(run, run);
    queueRef.current = p.catch(() => {});
    return p.finally(() => {
      queryClient.invalidateQueries({ queryKey: ['lighter-account'] });
      queryClient.invalidateQueries({ queryKey: ['lighter-orders'] });
    });
  }, [queryClient]);

  const approveIntegrator = useCallback(async () => {
    if (!INTEGRATOR || !address) return;
    setBusy(true);
    setError(null);
    try {
      const params = {
        integratorAccountIndex: INTEGRATOR.accountIndex,
        maxTakerFee: INTEGRATOR.takerFee,
        maxMakerFee: INTEGRATOR.makerFee,
        expiry: Date.now() + INTEGRATOR_APPROVAL_MS,
      };
      await submit(TX_TYPE.APPROVE_INTEGRATOR, async (signer, nonce) => {
        const message = await signer.approveIntegratorMessage(params, nonce);
        const l1Sig = await signMessageAsync({ message });
        return signer.signApproveIntegrator(params, l1Sig, nonce);
      });
      store.set(integratorStorageId(address, accountIndex), String(params.expiry));
      setStatus('ready');
    } catch (e) {
      setError(shortErr(e));
    } finally {
      setBusy(false);
    }
  }, [address, accountIndex, signMessageAsync, submit]);

  const placeOrder = useCallback(
    (order) =>
      submit(TX_TYPE.CREATE_ORDER, (signer, nonce) =>
        signer.signCreateOrder({ ...order, integrator: INTEGRATOR ?? undefined }, nonce),
      ),
    [submit],
  );

  /** { groupingType, orders } from orders.js; groupingType null = single order. */
  const placeGroupedOrders = useCallback(
    ({ groupingType, orders }) =>
      groupingType === null
        ? submit(TX_TYPE.CREATE_ORDER, (signer, nonce) =>
            signer.signCreateOrder({ ...orders[0], integrator: INTEGRATOR ?? undefined }, nonce))
        : submit(TX_TYPE.CREATE_GROUPED_ORDERS, (signer, nonce) =>
            signer.signCreateGroupedOrders(groupingType, orders, nonce, INTEGRATOR ?? undefined)),
    [submit],
  );

  /** Short-lived read token for private endpoints (orders, trades, funding, PnL). */
  const getAuthToken = useCallback(async () => {
    const signer = signerRef.current;
    if (!signer) throw new Error('Trading not enabled');
    if (!authRef.current || authRef.current.expiresAt - Date.now() < 5 * 60e3) {
      authRef.current = await signer.createAuthToken();
    }
    return authRef.current.token;
  }, []);

  const cancelOrder = useCallback(
    (marketIndex, orderIndex) =>
      submit(TX_TYPE.CANCEL_ORDER, (signer, nonce) => signer.signCancelOrder(marketIndex, orderIndex, nonce)),
    [submit],
  );

  const updateLeverage = useCallback(
    (marketIndex, leverage, marginMode) =>
      submit(TX_TYPE.UPDATE_LEVERAGE, (signer, nonce) =>
        signer.signUpdateLeverage(marketIndex, Math.round(10000 / leverage), marginMode, nonce),
      ),
    [submit],
  );

  // ---- live account data ----
  const accountQuery = useQuery({
    queryKey: ['lighter-account', accountIndex],
    queryFn: () => api.getAccount(accountIndex),
    enabled: accountIndex !== null,
    refetchInterval: 3000,
  });

  const tradingReady = status === 'ready' || status === 'needs-integrator';
  const ordersQuery = useQuery({
    queryKey: ['lighter-orders', accountIndex],
    enabled: tradingReady && accountIndex !== null,
    refetchInterval: 3000,
    queryFn: async () => (signerRef.current ? api.getActiveOrders(accountIndex, await getAuthToken()) : []),
  });

  return {
    status,
    error,
    busy,
    address,
    accountIndex,
    account: accountQuery.data ?? null,
    orders: ordersQuery.data ?? [],
    enableTrading,
    approveIntegrator,
    tradingReady,
    placeOrder,
    placeGroupedOrders,
    cancelOrder,
    updateLeverage,
    getAuthToken,
    clearError: () => setError(null),
  };
}

function needsIntegrator(address, accountIndex) {
  if (!INTEGRATOR) return false;
  const exp = Number(store.get(integratorStorageId(address, accountIndex)) || 0);
  return exp < Date.now() + 24 * 3600e3;
}

export function shortErr(e) {
  const m = e?.shortMessage || e?.message || String(e);
  if (/user rejected|denied/i.test(m)) return 'Signature rejected in wallet';
  return m.length > 220 ? `${m.slice(0, 220)}…` : m;
}
