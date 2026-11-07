// Wrapper around Lighter's official browser signer (lighter-go/web-wasm).
// The WASM registers global functions (`_createClient`, `_signCreateOrder`, ...).
// Each call returns a bound function that yields a Promise resolving to either
// `{ txHash, txInfo }`, a method-specific object, or `{ error }`.
//
// Argument order mirrors lighter-go/web-wasm/main.go exactly — check it when upgrading.
import { NETWORK } from './config.js';

let loading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/** Loads the WASM signer once per page. */
export function loadSigner() {
  if (!loading) {
    loading = (async () => {
      const base = import.meta.env.BASE_URL ?? '/';
      if (!window.Go) await loadScript(`${base}signer/wasm_exec.js`);
      const go = new window.Go();
      const resp = fetch(`${base}signer/lighter-signer.wasm`);
      const { instance } = WebAssembly.instantiateStreaming
        ? await WebAssembly.instantiateStreaming(resp, go.importObject)
        : await WebAssembly.instantiate(await (await resp).arrayBuffer(), go.importObject);
      go.run(instance); // never resolves while the signer is alive
      if (window._signerVersion !== 2) throw new Error('Unsupported Lighter signer version');
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

async function call(name, ...args) {
  await loadSigner();
  const fn = window[name];
  if (typeof fn !== 'function') throw new Error(`Signer method ${name} missing`);
  const r = fn(...args);
  const out = await (typeof r === 'function' ? r() : r);
  if (out && out.error) throw new Error(out.error);
  return out;
}

const NIL = null;

/**
 * One Lighter API key bound to one account. The private key never leaves the browser.
 */
export class LighterSigner {
  constructor({ accountIndex, apiKeyIndex, chainId = NETWORK.chainId }) {
    this.accountIndex = Number(accountIndex);
    this.apiKeyIndex = Number(apiKeyIndex);
    this.chainId = chainId;
    this.publicKey = null;
  }

  /**
   * Installs the key in the signer. Pass `privateKey` to restore a stored key,
   * otherwise a fresh key is derived from a random 32-byte seed.
   * Returns { publicKey, privateKey, changePubKeyMessage } — the message must be
   * signed by the user's wallet to register the key with Lighter.
   */
  async init({ privateKey, nonce }) {
    let res;
    if (privateKey) {
      res = await call('_createClientByPrv', privateKey, this.chainId, this.accountIndex, nonce, this.apiKeyIndex);
    } else {
      const seed = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
      res = await call('_createClient', seed, this.chainId, this.accountIndex, nonce, this.apiKeyIndex);
    }
    this.publicKey = res.pk;
    return { publicKey: res.pk, privateKey: res.prv, changePubKeyMessage: res.body };
  }

  async #select() {
    await call('_selectClient', this.accountIndex, this.chainId, this.apiKeyIndex);
  }

  /** Text the wallet must personal_sign to register this key (for a given nonce). */
  async changePubKeyMessage(nonce) {
    await this.#select();
    const r = await call('_getChangePubKeyTransaction', this.accountIndex, nonce, this.apiKeyIndex);
    return r.body;
  }

  async signChangePubKey(l1Signature, nonce) {
    await this.#select();
    return call('_signChangePubKey', this.accountIndex, l1Signature, nonce, this.apiKeyIndex);
  }

  /**
   * @param o.marketIndex, o.clientOrderIndex
   * @param o.baseAmount / o.price / o.triggerPrice  scaled integer strings
   * @param o.isAsk bool, o.orderType, o.timeInForce, o.reduceOnly bool
   * @param o.orderExpiry  -1 = 28 days, 0 = for IOC
   * @param o.integrator  optional { accountIndex, takerFee, makerFee }
   */
  async signCreateOrder(o, nonce) {
    await this.#select();
    const integ = o.integrator;
    return call(
      '_signCreateOrder',
      this.accountIndex,
      o.marketIndex,
      o.clientOrderIndex,
      String(o.baseAmount),
      String(o.price),
      o.isAsk ? 1 : 0,
      o.orderType,
      o.timeInForce,
      o.reduceOnly ? 1 : 0,
      String(o.triggerPrice ?? '0'),
      o.orderExpiry,
      nonce,
      integ ? integ.accountIndex : NIL,
      integ ? integ.takerFee : NIL,
      integ ? integ.makerFee : NIL,
    );
  }

  async signCancelOrder(marketIndex, orderIndex, nonce) {
    await this.#select();
    return call('_signCancelOrder', this.accountIndex, marketIndex, String(orderIndex), nonce);
  }

  /** initialMarginFraction in basis points: 10000 / leverage (e.g. 10x -> 1000). */
  async signUpdateLeverage(marketIndex, initialMarginFraction, marginMode, nonce) {
    await this.#select();
    return call('_signUpdateLeverage', this.accountIndex, marketIndex, initialMarginFraction, marginMode, nonce);
  }

  async approveIntegratorMessage({ integratorAccountIndex, maxTakerFee, maxMakerFee, expiry }, nonce) {
    await this.#select();
    const r = await call(
      '_getApproveIntegratorTransaction',
      this.accountIndex, nonce, this.apiKeyIndex,
      integratorAccountIndex, maxTakerFee, maxMakerFee, 0, 0, expiry,
    );
    return r.body;
  }

  async signApproveIntegrator({ integratorAccountIndex, maxTakerFee, maxMakerFee, expiry }, l1Signature, nonce) {
    await this.#select();
    return call(
      '_signApproveIntegrator',
      this.accountIndex, l1Signature, nonce, this.apiKeyIndex,
      integratorAccountIndex, maxTakerFee, maxMakerFee, 0, 0, expiry,
    );
  }

  /** Read-only auth token (valid ~1h) for private REST endpoints like active orders. */
  async createAuthToken() {
    await this.#select();
    const r = await call('_createAuthToken', this.accountIndex, this.apiKeyIndex);
    return { token: r.token, expiresAt: r.deadline * 1000 };
  }
}
