# engine-state (data only — no code)

Snapshot of the Decision Engine's runtime state exported from the Claude cloud session
(2026-09-26): paper portfolio (open positions, equity curve), all logged decisions,
backtest results, calibrators, learned signal weights, the self-improvement model registry
(incl. the promoted intraday tbLong stacker), direction track-record tables, and the
point-in-time research datasets. Paper trading only; contains no API keys or secrets.

Restore on a VPS:  IMPORT_STATE=1 bash decision-engine/deploy.sh   (from the code branch)
