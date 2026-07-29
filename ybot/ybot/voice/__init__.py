"""Ybot voice subsystem.

Runs as a SEPARATE PROCESS from ybot's main loop: the STT/TTS stack needs
Python 3.11 + torch, while ybot itself runs on Python 3.14 (no torch wheels).
`service.py` is the entry point on 3.11; `bridge.py` is the thin client ybot
imports on 3.14 and has no heavy dependencies.
"""
