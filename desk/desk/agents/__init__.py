"""The seats. Each module is one wing; each class is one seat.

Every seat subclasses agents.base.Agent and implements collect(ctx) — pure
Python that returns a Reading. Narration happens elsewhere, so nothing in here
ever calls a language model.
"""
