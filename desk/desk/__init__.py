"""The Desk — a crypto trading desk of fifteen seats.

Paper by default, and it stays that way until three independent switches are
thrown; see config.Settings.live_armed.

The architecture in one line: Python computes every number, the language model
only ever narrates them.
"""

__version__ = "0.1.0"
