"""The desk's Solana wallet — read balances always, sign swaps only when armed.

The same discipline PILOT uses for the CEX side, applied to Solana. The public
address is enough to read balances and is safe to store (wallet.json). The
signing key is read from the DESK_SOLANA_KEY environment variable at runtime and
is never written to disk, the repo, or the journal.

A swap is placed only when all three Solana switches are set — mode, key, and an
explicit arm phrase (config.solana_armed). That gate is deliberately separate
from and stricter than the CEX one, because an on-chain swap cannot be cancelled
or recalled once it lands.

Honesty contract, same as solana.py and market.py: a failed RPC call returns
None, never a fabricated balance; an unarmed or unroutable swap returns
executed=False with a reason, never a silent no-op.
"""
from __future__ import annotations

import base64
import json
import logging
import os
from pathlib import Path
from typing import Any

import requests

from .agents.solana import JUPITER_QUOTE, USDC_MINT
from .config import Settings

log = logging.getLogger(__name__)

JUPITER_SWAP = "https://lite-api.jup.ag/swap/v1/swap"
LAMPORTS_PER_SOL = 1_000_000_000
MIN_SWAP_USDC = 10.0


class Wallet:
    """A Solana wallet. Read-only until DESK_SOLANA_KEY is set and the desk armed."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._cfg = self._load_config(settings.wallet_file)
        self.rpc = self._cfg.get("rpc") or settings.solana_rpc
        self._keypair_obj: Any = None

    # -- identity ----------------------------------------------------------

    @staticmethod
    def _load_config(path: Path) -> dict[str, Any]:
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    @property
    def address(self) -> str | None:
        """Public address — env override, then wallet.json, then derived from key."""
        env = os.environ.get("DESK_SOLANA_PUBKEY")
        if env:
            return env
        if self._cfg.get("pubkey"):
            return str(self._cfg["pubkey"])
        kp = self._keypair(quiet=True)
        return str(kp.pubkey()) if kp else None

    @property
    def armed(self) -> bool:
        return self.settings.solana_armed

    def _keypair(self, *, quiet: bool = False) -> Any:
        """Signing key from DESK_SOLANA_KEY only. None if unset or unloadable."""
        if self._keypair_obj is not None:
            return self._keypair_obj
        secret = os.environ.get("DESK_SOLANA_KEY")
        if not secret:
            return None
        try:
            from solders.keypair import Keypair
            self._keypair_obj = Keypair.from_base58_string(secret.strip())
        except Exception:
            if not quiet:
                log.warning("DESK_SOLANA_KEY is set but could not be loaded as a keypair",
                            exc_info=True)
            return None
        return self._keypair_obj

    # -- RPC reads ---------------------------------------------------------

    def _rpc(self, method: str, params: list[Any]) -> Any:
        try:
            resp = requests.post(self.rpc, timeout=12, json={
                "jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            resp.raise_for_status()
            return resp.json().get("result")
        except Exception:
            log.warning("solana rpc %s failed", method, exc_info=True)
            return None

    def sol_balance(self) -> float | None:
        addr = self.address
        if not addr:
            return None
        result = self._rpc("getBalance", [addr])
        if not isinstance(result, dict) or "value" not in result:
            return None
        return result["value"] / LAMPORTS_PER_SOL

    def token_balance(self, mint: str = USDC_MINT) -> float | None:
        """UI-amount of an SPL token held, summed across accounts. USDC by default."""
        addr = self.address
        if not addr:
            return None
        result = self._rpc(
            "getTokenAccountsByOwner",
            [addr, {"mint": mint}, {"encoding": "jsonParsed"}])
        if not isinstance(result, dict):
            return None
        total = 0.0
        for acc in result.get("value", []):
            info = (((acc.get("account") or {}).get("data") or {})
                    .get("parsed") or {}).get("info") or {}
            ui = (info.get("tokenAmount") or {}).get("uiAmount")
            if ui is not None:
                total += float(ui)
        return total

    def balances(self) -> dict[str, float | None]:
        return {"sol": self.sol_balance(), "usdc": self.token_balance()}

    # -- execution (guarded) ----------------------------------------------

    def swap(self, output_mint: str, amount_usdc: float,
             slippage_bps: int = 100) -> dict[str, Any]:
        """Buy `output_mint` with `amount_usdc` of USDC via Jupiter.

        Signs and sends only when the wallet is armed. executed=False always
        carries a reason and means nothing was broadcast.
        """
        if not self.armed:
            return {"executed": False,
                    "reason": "wallet not armed — needs DESK_MODE=live + "
                              "DESK_SOLANA_KEY + DESK_SOLANA_ARM=I_UNDERSTAND_THE_RISK"}
        if amount_usdc < MIN_SWAP_USDC:
            return {"executed": False,
                    "reason": f"size ${amount_usdc:,.2f} below ${MIN_SWAP_USDC:,.0f} floor"}
        kp = self._keypair()
        if kp is None:
            return {"executed": False, "reason": "no usable signing key"}

        quote = self._quote(output_mint, amount_usdc, slippage_bps)
        if not quote:
            return {"executed": False, "reason": "no Jupiter route for this size"}
        swap_tx = self._build_swap(quote, str(kp.pubkey()))
        if not swap_tx:
            return {"executed": False, "reason": "Jupiter /swap returned no transaction"}
        signature = self._sign_and_send(swap_tx, kp)
        if not signature:
            return {"executed": False, "reason": "transaction failed to sign or send"}
        return {"executed": True, "signature": signature,
                "in_usdc": amount_usdc, "out_amount": int(quote.get("outAmount", 0))}

    def _quote(self, output_mint: str, amount_usdc: float,
               slippage_bps: int) -> dict[str, Any] | None:
        try:
            resp = requests.get(JUPITER_QUOTE, timeout=15, params={
                "inputMint": USDC_MINT, "outputMint": output_mint,
                "amount": int(amount_usdc * 1_000_000), "slippageBps": slippage_bps})
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, dict) and "outAmount" in data else None
        except Exception:
            log.warning("jupiter quote failed", exc_info=True)
            return None

    def _build_swap(self, quote: dict[str, Any], user_pubkey: str) -> str | None:
        try:
            resp = requests.post(JUPITER_SWAP, timeout=20, json={
                "quoteResponse": quote, "userPublicKey": user_pubkey,
                "wrapAndUnwrapSol": True, "dynamicComputeUnitLimit": True})
            resp.raise_for_status()
            return resp.json().get("swapTransaction")
        except Exception:
            log.warning("jupiter swap build failed", exc_info=True)
            return None

    def _sign_and_send(self, swap_tx_b64: str, keypair: Any) -> str | None:
        try:
            from solders.transaction import VersionedTransaction
            unsigned = VersionedTransaction.from_bytes(base64.b64decode(swap_tx_b64))
            signed = VersionedTransaction(unsigned.message, [keypair])
            encoded = base64.b64encode(bytes(signed)).decode("ascii")
        except Exception:
            log.warning("could not sign swap transaction", exc_info=True)
            return None
        result = self._rpc("sendTransaction",
                           [encoded, {"encoding": "base64", "maxRetries": 3}])
        return result if isinstance(result, str) else None
