import { useState } from 'react';
import { useAccount, useConnect, useDisconnect } from 'wagmi';

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);

  if (isConnected) {
    return (
      <button className="btn btn-ghost" onClick={() => disconnect()} title="Disconnect">
        <span className="dot dot-live" /> {short(address)}
      </button>
    );
  }

  return (
    <div className="connect">
      <button className="btn btn-primary" onClick={() => setOpen((o) => !o)} disabled={isPending}>
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
      {open && (
        <div className="menu">
          {connectors.map((c) => (
            <button
              key={c.uid}
              className="menu-item"
              onClick={() => {
                connect({ connector: c });
                setOpen(false);
              }}
            >
              {c.name === 'Injected' ? 'Browser wallet' : c.name}
            </button>
          ))}
          {error && <div className="menu-error">{error.shortMessage || error.message}</div>}
        </div>
      )}
    </div>
  );
}
