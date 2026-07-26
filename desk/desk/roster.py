"""The desk roster — who sits where, and what each seat is for.

A crypto-native desk: one master (HELM) and fourteen specialists. This is NOT
a transliterated equities desk — there is no seat reading central-bank minutes
or legislator disclosures. The seats map onto surfaces that only exist in
crypto: perpetual funding and open interest, on-chain exchange flow, token
unlock schedules, AMM liquidity, and mint authority.

The roster is data, not behaviour: the HUD renders from it, the orchestrator
routes from it, and voices.json is keyed by the same names.

Wings:
  flow      positioning and regime      derivatives + on-chain (CEX)
  book      price and structure         technicals + statistics (CEX)
  truth     supply and dissent          tokenomics + the adversary
  memes     Solana memecoins            DEX; different data, different death
  guard     risk, execution, memory     shared by every market
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Seat:
    name: str
    role: str
    wing: str
    colour: str      # HUD node colour
    brief: str       # shown in the HUD; primes this seat's narration
    sources: str     # where its numbers come from — never from the model
    market: str      # "cex" | "dex" | "both"


MASTER = Seat(
    name="HELM",
    role="MASTER",
    wing="master",
    colour="#3fe9ff",
    brief=(
        "The orchestrator, and the only seat that speaks to the operator. "
        "Routes one command to the right wing, runs the bull/bear debate, "
        "weighs each seat by its own track record, and synthesizes. Never "
        "does specialist work itself."
    ),
    sources="the other fourteen seats",
    market="both",
)

SPECIALISTS: tuple[Seat, ...] = (
    # ---- FLOW: positioning and regime ----------------------------------
    Seat("TIDE", "REGIME", "flow", "#7b8cff",
         "Calls the market regime — risk-on, risk-off, or chop. BTC and ETH "
         "dominance, total market cap, stablecoin supply as dry powder, and "
         "the fear/greed extreme that usually marks a turn.",
         "crypto-data: dominance, global market stats, fear & greed", "cex"),
    Seat("KRAKEN", "ON-CHAIN FLOW", "flow", "#ffd54d",
         "Watches where size actually moves — exchange net inflow and outflow, "
         "large holder concentration, and stablecoin migration. Coins leaving "
         "exchanges is accumulation; coins arriving is usually not.",
         "dexpaprika token/holder data, DefiLlama stablecoin flows", "cex"),
    Seat("COIL", "DERIVATIVES", "flow", "#ff9f40",
         "The seat an equities desk cannot have. Perpetual funding rates, open "
         "interest build and unwind, long/short ratio, taker aggression, and "
         "where the liquidation clusters sit. Reads crowding and the fuel for "
         "a squeeze.",
         "crypto-futures: funding, OI, long/short, liquidation levels", "cex"),

    # ---- BOOK: price and structure -------------------------------------
    Seat("CHARTIST", "TECHNICIAN", "book", "#3fe9ff",
         "Trend, momentum, and the levels that matter — moving averages, RSI, "
         "MACD, support and resistance, and pattern breaks. Where to enter, "
         "and where the idea is proven wrong.",
         "CCXT OHLCV, computed in pandas", "both"),
    Seat("SIGMA", "QUANT", "book", "#b57bff",
         "Realised volatility, ATR, cross-asset correlation, and probability "
         "cones. Sizes uncertainty so Sentinel can size the position. Speaks "
         "in distributions and never in promises.",
         "CCXT OHLCV, computed in pandas/numpy", "both"),

    # ---- TRUTH: supply and dissent -------------------------------------
    Seat("VESTA", "TOKENOMICS", "truth", "#2fd6c4",
         "Supply-side truth — circulating versus fully diluted, emission rate, "
         "unlock and vesting cliffs, treasury depth, TVL and whether the "
         "protocol earns anything. Finds the sell pressure already scheduled.",
         "DefiLlama TVL/revenue, coinpaprika supply & unlock data", "cex"),
    Seat("CASSANDRA", "ADVERSARY", "truth", "#ff8a3d",
         "Red team. Argues against every thesis the desk proposes — and is "
         "itself scored on the warnings that proved right. Exists so fourteen "
         "seats cannot become a chorus.",
         "every other seat's output, argued against", "both"),

    # ---- MEMES: Solana DEX ---------------------------------------------
    Seat("HOUND", "SCENT", "memes", "#9dff5c",
         "Hunts fresh Solana pairs — new liquidity, volume spikes, buyer count "
         "and momentum curve in the first hours. Always finds something; is "
         "early by design and wrong more often than any other seat.",
         "DexScreener new pairs, dexpaprika pools", "dex"),
    Seat("GEIGER", "RUG FORENSICS", "memes", "#ff3b3b",
         "The hard gate. Mint authority, freeze authority, LP locked or burnt, "
         "top-holder concentration, dev wallet behaviour, and a simulated sell "
         "to prove the token can be exited. A fail here is absolute — no "
         "conviction anywhere else overrides it.",
         "RugCheck, Helius/Solana RPC, honeypot sell simulation", "dex"),
    Seat("BALLAST", "DEGEN RISK", "memes", "#ffa64d",
         "Sizes the unsizeable. Max loss per token, how many meme positions "
         "may run at once, and a hard ceiling on what fraction of the book "
         "the whole wing may hold. Assumes every meme position goes to zero "
         "and sizes so that is survivable.",
         "portfolio state + Geiger's safety score", "dex"),
    Seat("VIPER", "STRIKE", "memes", "#00e5a0",
         "Fast in, fast out. Jupiter route and slippage check, take-profit "
         "ladders, trailing exit, and an emergency dump path. Optimises for "
         "speed and fill quality, never for conviction.",
         "Jupiter quote/swap, Solana RPC", "dex"),

    # ---- GUARD: risk, execution, memory --------------------------------
    Seat("SENTINEL", "RISK OFFICER", "guard", "#ff4d61",
         "Sizes every position, sets every stop, and holds veto power over "
         "both markets. Its gates are code, not prompts — position cap, total "
         "exposure cap, daily loss halt, liquidity floor, volatility ceiling. "
         "No model output can widen them.",
         "portfolio state + hardcoded limits in config.py", "both"),
    Seat("PILOT", "EXECUTION", "guard", "#ff6bd6",
         "Places orders on major pairs once Sentinel signs off, and owns the "
         "microstructure that decides fill quality — spread, book depth, "
         "imbalance, spoofing, and expected slippage for the intended size. "
         "Confirms; never opines.",
         "CCXT orderbook + order placement", "cex"),
    Seat("LEDGER", "THE BOOK", "guard", "#aab6cc",
         "Journals every call the desk makes, then scores each seat's hit rate "
         "and downweights the ones that keep being wrong. Conviction is earned "
         "per seat, not assumed. The desk's memory and its conscience.",
         "state/journal.jsonl, state/scorecard.json", "both"),
)

ROSTER: tuple[Seat, ...] = (MASTER, *SPECIALISTS)
BY_NAME: dict[str, Seat] = {seat.name: seat for seat in ROSTER}

WINGS: tuple[str, ...] = ("flow", "book", "truth", "memes", "guard")


def wing(name: str) -> tuple[Seat, ...]:
    """Every specialist seat in a wing, in roster order."""
    return tuple(s for s in SPECIALISTS if s.wing == name)


def for_market(market: str) -> tuple[Seat, ...]:
    """Specialists that apply to a market — 'cex' or 'dex'."""
    return tuple(s for s in SPECIALISTS if s.market in (market, "both"))
