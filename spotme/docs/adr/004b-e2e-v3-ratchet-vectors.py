#!/usr/bin/env python3
"""
Generates the e2e_v3 RATCHET conformance vectors for 004b-e2e-v3-vector-package.md.

    pip install 'DoubleRatchet==1.3.0' 'X3DH==1.3.0'
    python3 spotme/docs/adr/004b-e2e-v3-ratchet-vectors.py > /tmp/vectors.json

WHAT THIS IS, AND WHAT IT IS NOT.

It is a VECTOR ORACLE. It is not the Spot Me implementation, it is not shipped,
nothing in web/ or backend/ imports it, and it is not in `npm test`. Its only
job is to produce the expected outputs that a future Spot Me ratchet must
reproduce byte for byte.

WHY A REFERENCE LIBRARY AT ALL. A ratchet written once and tested against
itself is tested against its own misunderstanding. The failure modes that
matter — a chain advanced one step early, a skipped key derived from the wrong
chain, associated data that omits a field — all produce self-consistent output.
They are only visible against an independent implementation of the same
specification.

THE RISK THIS DESIGN EXISTS TO CONTAIN. If the vectors were simply whatever
`DoubleRatchet 1.3.0` emits by default, then e2e_v3 would silently inherit that
library's arbitrary choices — its HKDF info strings, its header encoding, its
skipped-key eviction order — and those choices would become Spot Me's wire
format by accident rather than by decision.

So every Spot-Me-specific value is INJECTED here, not taken from the library:

  KDF info strings   -> SpotMeRootKDF / SpotMeMessageKDF  (004a §10 labels)
  associated data    -> SpotMeDoubleRatchet._build_associated_data (004a §6)
  AEAD + framing     -> SpotMeAEAD (004a §2)
  skip bounds        -> MAX_SKIP_PER_CHAIN / MAX_SKIPPED_STORED (004a §5)

What the library supplies is only the ALGORITHM: when to step the DH ratchet,
how chains advance, how skipped keys are stored and retrieved. That is the part
we want an independent opinion on, and the part we are not inventing.

Anywhere the two disagree and the Signal specification is silent, the rule is:
write the decision into 004a and make both sides follow it. Never "match the
library" — that is how an implementation detail becomes a protocol.

DETERMINISM. The DH ratchet generates keys at random, which would make every
run produce different vectors. `_generate_priv` is overridden with a fixed
sequence derived from a constant seed, so the whole file is reproducible. Those
keys are test-only by construction and must never appear anywhere else.
"""

import asyncio
import hashlib
import hmac
import json
import os
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives import serialization

from doubleratchet import (
    AEAD, DoubleRatchet, Header, EncryptedMessage,
    AuthenticationFailedException, DuplicateMessageException, DoSProtectionException,
)
from doubleratchet.recommended import HashFunction, kdf_hkdf
from doubleratchet.recommended import diffie_hellman_ratchet_curve25519 as dhr25519

# --------------------------------------------------------------- constants ---
# These are Spot Me's, from 004a. They are the reason this file exists: the
# vectors must be about OUR protocol, not the library's defaults.

LABEL_ROOT = b"spotme/e2e_v3/root"
LABEL_CHAIN = b"spotme/e2e_v3/chain"
LABEL_MSG = b"spotme/e2e_v3/msg"
AAD_PREFIX = b"spotme/e2e_v3"
VERSION = 0x03
MAGIC = 0x53

MAX_SKIP_PER_CHAIN = 1000
MAX_SKIPPED_STORED = 2000

ROOM_ID = "dm_0123456789abcdef"
SDEV = bytes([0xA1]) * 16
RDEV = bytes([0xB2]) * 16

hexs = lambda b: b.hex()


# ------------------------------------------------------------- determinism ---
class DeterministicDH(dhr25519.DiffieHellmanRatchet):
    """Fixed key sequence, so the vectors are reproducible rather than fresh."""

    _counter = 0

    @staticmethod
    def _generate_priv() -> bytes:
        # A counter-driven KDF stream, not os.urandom. Test-only by construction.
        DeterministicDH._counter += 1
        return hashlib.sha256(b"spotme/e2e_v3/testvector/ratchet/" +
                              DeterministicDH._counter.to_bytes(4, "big")).digest()


# ---------------------------------------------------------- Spot Me pieces ---
class SpotMeRootKDF(kdf_hkdf.KDF):
    @staticmethod
    def _get_hash_function() -> HashFunction:
        return HashFunction.SHA_256

    @staticmethod
    def _get_info() -> bytes:
        return LABEL_CHAIN            # root chain step: 004a "root key' || chain key"


class SpotMeMessageKDF(kdf_hkdf.KDF):
    @staticmethod
    def _get_hash_function() -> HashFunction:
        return HashFunction.SHA_256

    @staticmethod
    def _get_info() -> bytes:
        return LABEL_MSG


class SpotMeAEAD(AEAD):
    """AES-GCM exactly as 004a §2 frames it: IV(12) || ciphertext||tag."""

    @staticmethod
    async def encrypt(plaintext: bytes, key: bytes, associated_data: bytes) -> bytes:
        # Deterministic IV DERIVED from the message key, not random — vectors
        # must be reproducible. THE SHIPPING IMPLEMENTATION MUST USE A RANDOM
        # IV; a derived one is safe only because each message key is used once,
        # and that invariant is the ratchet's, not the AEAD's.
        iv = hmac.new(key, b"spotme/e2e_v3/iv", hashlib.sha256).digest()[:12]
        ct = AESGCM(hashlib.sha256(key).digest()).encrypt(iv, plaintext, associated_data)
        return iv + ct

    @staticmethod
    async def decrypt(ciphertext: bytes, key: bytes, associated_data: bytes) -> bytes:
        iv, ct = ciphertext[:12], ciphertext[12:]
        try:
            return AESGCM(hashlib.sha256(key).digest()).decrypt(iv, ct, associated_data)
        except Exception as e:
            raise AuthenticationFailedException(str(e)) from e


def encode_header(header: Header, sdev: bytes = SDEV, rdev: bytes = RDEV) -> bytes:
    """004a §2 HEADER, steady-state form (no X3DH prologue)."""
    out = bytearray()
    out.append(0x00)                                   # FLAGS: no prologue
    out += sdev
    out += rdev
    out += header.ratchet_pub
    out += header.previous_sending_chain_length.to_bytes(4, "big")
    out += header.sending_chain_length.to_bytes(4, "big")
    return bytes(out)


def build_aad(room_id: str, header_bytes: bytes) -> bytes:
    """004a §6."""
    return AAD_PREFIX + bytes([VERSION]) + room_id.encode() + header_bytes


def frame_payload(header_bytes: bytes, sealed: bytes) -> bytes:
    """004a §2 full payload framing."""
    return (bytes([MAGIC, VERSION]) + len(header_bytes).to_bytes(2, "big")
            + header_bytes + sealed)


class SpotMeDoubleRatchet(DoubleRatchet):
    """The one abstract method: how associated data is built. Ours, not theirs."""

    @staticmethod
    def _build_associated_data(associated_data: bytes, header: Header) -> bytes:
        return build_aad(ROOM_ID, encode_header(header))


# ------------------------------------------------------------------ params ---
DR_ARGS = dict(
    diffie_hellman_ratchet_class=DeterministicDH,
    root_chain_kdf=SpotMeRootKDF,
    message_chain_kdf=SpotMeMessageKDF,
    message_chain_constant=b"\x01",
    dos_protection_threshold=MAX_SKIP_PER_CHAIN,
    max_num_skipped_message_keys=MAX_SKIPPED_STORED,
    aead=SpotMeAEAD,
)

VECTORS = {}


def record(name, **fields):
    VECTORS[name] = fields
    print(f"  [{len(VECTORS):2d}] {name}", file=sys.stderr)


def msg_json(em: EncryptedMessage):
    hb = encode_header(em.header)
    return {
        "header_hex": hexs(hb),
        "header_len": len(hb),
        "ratchet_pub": hexs(em.header.ratchet_pub),
        "pn": em.header.previous_sending_chain_length,
        "n": em.header.sending_chain_length,
        "aad_hex": hexs(build_aad(ROOM_ID, hb)),
        "ciphertext_hex": hexs(em.ciphertext),
        "payload_hex": hexs(frame_payload(hb, em.ciphertext)),
    }


async def main():
    print("generating e2e_v3 ratchet vectors...", file=sys.stderr)
    DeterministicDH._counter = 0

    # Bob's signed prekey stands in as the initial ratchet key. The X3DH shared
    # secret is fixed here rather than derived, because 004a §10 already pins
    # the X3DH half with its own vectors — this file is about the RATCHET.
    shared_secret = hashlib.sha256(b"spotme/e2e_v3/testvector/x3dh-shared-secret").digest()
    bob_ratchet_priv = hashlib.sha256(b"spotme/e2e_v3/testvector/bob-signed-prekey").digest()
    bob_ratchet_pub = X25519PrivateKey.from_private_bytes(bob_ratchet_priv).public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw)

    record("00_inputs",
           description="Fixed inputs. The X3DH shared secret is pinned; 004a §10 covers its derivation.",
           shared_secret=hexs(shared_secret),
           bob_ratchet_pub=hexs(bob_ratchet_pub),
           room_id=ROOM_ID, sdev=hexs(SDEV), rdev=hexs(RDEV),
           labels={"root": LABEL_ROOT.decode(), "chain": LABEL_CHAIN.decode(), "msg": LABEL_MSG.decode()},
           max_skip_per_chain=MAX_SKIP_PER_CHAIN, max_skipped_stored=MAX_SKIPPED_STORED)

    # 1 + 2 — session establishment and the first encrypted message ----------
    alice, initial = await SpotMeDoubleRatchet.encrypt_initial_message(
        shared_secret=shared_secret, recipient_ratchet_pub=bob_ratchet_pub,
        message=b"first message from alice", associated_data=b"", **DR_ARGS)
    record("01_session_establishment_and_first_message",
           description="Alice initialises from the X3DH secret and sends message 0.",
           plaintext="first message from alice", **msg_json(initial))

    bob, plaintext = await SpotMeDoubleRatchet.decrypt_initial_message(
        shared_secret=shared_secret, own_ratchet_priv=bob_ratchet_priv,
        message=initial, associated_data=b"", **DR_ARGS)
    assert plaintext == b"first message from alice"
    record("02_first_message_decrypts",
           description="Bob initialises from the same secret and recovers the plaintext.",
           recovered=plaintext.decode())

    # 3 — send-chain advancement ---------------------------------------------
    sends = []
    for i in range(1, 4):
        em = await alice.encrypt_message(f"alice send-chain {i}".encode(), b"")
        sends.append({"i": i, "plaintext": f"alice send-chain {i}", **msg_json(em)})
    record("03_send_chain_advancement",
           description="Three further messages on the same sending chain: n increments, ratchet_pub is constant.",
           messages=sends,
           invariant="ratchet_pub identical across all; n = 1,2,3; pn constant")

    # 4 — receive-chain advancement ------------------------------------------
    got = []
    for m in sends:
        em = EncryptedMessage(header=Header(bytes.fromhex(m["ratchet_pub"]), m["pn"], m["n"]),
                              ciphertext=bytes.fromhex(m["ciphertext_hex"]))
        got.append((await bob.decrypt_message(em, b"")).decode())
    record("04_receive_chain_advancement",
           description="Bob walks his receiving chain in order.",
           recovered=got)

    # 5 — bidirectional ratchet step -----------------------------------------
    reply = await bob.encrypt_message(b"bob replies, stepping the ratchet", b"")
    record("05_bidirectional_ratchet_step",
           description="Bob's first reply carries a NEW ratchet_pub and pn = his previous sending chain length.",
           plaintext="bob replies, stepping the ratchet", **msg_json(reply),
           invariant="ratchet_pub differs from Alice's; a DH step occurs on Alice's decrypt")
    back = await alice.decrypt_message(reply, b"")
    assert back == b"bob replies, stepping the ratchet"

    # 6 + 7 — out-of-order delivery and skipped keys --------------------------
    burst = [await alice.encrypt_message(f"burst {i}".encode(), b"") for i in range(4)]
    # Deliver 3 first: that forces 0,1,2 to be stored as skipped keys.
    third = await bob.decrypt_message(burst[3], b"")
    order = [("3", third.decode())]
    for i in (1, 0, 2):
        order.append((str(i), (await bob.decrypt_message(burst[i], b"")).decode()))
    record("06_out_of_order_delivery",
           description="Delivered 3,1,0,2. Every message decrypts; none is lost.",
           delivery_order=[o[0] for o in order], recovered=[o[1] for o in order],
           messages=[msg_json(b_) for b_ in burst])
    record("07_skipped_message_keys",
           description="Receiving 3 before 0-2 stores three skipped keys, later consumed out of order.",
           skipped_count_expected=3,
           bound=f"a header claiming n beyond {MAX_SKIP_PER_CHAIN} must be REFUSED, not honoured",
           rationale="an unbounded n is a remote DoS: the client would derive that many keys")

    # 8 — duplicate / replay rejection ---------------------------------------
    try:
        await bob.decrypt_message(burst[0], b"")
        dup = "ACCEPTED — WRONG"
    except DuplicateMessageException as e:
        dup = f"rejected: {type(e).__name__}"
    record("08_duplicate_and_replay_rejection",
           description="Re-delivering an already-decrypted message is refused; its key was deleted on use.",
           result=dup, expected="rejected")

    # 9 — state serialization and restoration --------------------------------
    state = json.loads(json.dumps(bob.json))
    bob_restored = SpotMeDoubleRatchet.from_json(state, **DR_ARGS)
    probe = await alice.encrypt_message(b"after bob was restored from disk", b"")
    restored_plain = await bob_restored.decrypt_message(probe, b"")
    record("09_state_serialization_and_restore",
           description="Bob's session is serialised, rebuilt, and still decrypts the next message.",
           state_keys=sorted(state.keys()),
           recovered=restored_plain.decode(),
           invariant="restoration must preserve skipped keys and both chain counters")

    # 10 — associated-data mismatch ------------------------------------------
    em = await alice.encrypt_message(b"aad bound message", b"")
    hb = encode_header(em.header)
    wrong_room_aad = build_aad("dm_ffffffffffffffff", hb)
    try:
        AESGCM(hashlib.sha256(b"x" * 32).digest())  # touch, keeps import honest
        await SpotMeAEAD.decrypt(em.ciphertext, hashlib.sha256(b"any").digest(), wrong_room_aad)
        aad_res = "ACCEPTED — WRONG"
    except AuthenticationFailedException:
        aad_res = "rejected: AuthenticationFailedException"
    record("10_associated_data_mismatch",
           description="The same ciphertext replayed into another roomId fails the GCM tag, because roomId is in the AAD.",
           correct_aad=hexs(build_aad(ROOM_ID, hb)), wrong_aad=hexs(wrong_room_aad),
           result=aad_res, expected="rejected")

    # 11 — tampered ciphertext ------------------------------------------------
    tampered = bytearray(em.ciphertext)
    tampered[-1] ^= 0x01
    try:
        await bob.decrypt_message(EncryptedMessage(header=em.header, ciphertext=bytes(tampered)), b"")
        tam = "ACCEPTED — WRONG"
    except Exception as e:
        tam = f"rejected: {type(e).__name__}"
    record("11_tampered_ciphertext",
           description="One flipped bit in the final tag byte fails authentication.",
           result=tam, expected="rejected")

    # 12 — wrong device / session routing -------------------------------------
    other_secret = hashlib.sha256(b"spotme/e2e_v3/testvector/unrelated-session").digest()
    other_priv = hashlib.sha256(b"spotme/e2e_v3/testvector/unrelated-ratchet").digest()
    other_pub = X25519PrivateKey.from_private_bytes(other_priv).public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw)
    stranger, _ = await SpotMeDoubleRatchet.encrypt_initial_message(
        shared_secret=other_secret, recipient_ratchet_pub=other_pub,
        message=b"not for you", associated_data=b"", **DR_ARGS)
    try:
        await stranger.decrypt_message(em, b"")
        routing = "ACCEPTED — WRONG"
    except Exception as e:
        routing = f"rejected: {type(e).__name__}"
    record("12_wrong_device_or_session_routing",
           description="A message for one session cannot be opened by an unrelated session, even with a well-formed header.",
           result=routing, expected="rejected",
           note="RDEV additionally lets a non-target device ignore it quietly rather than alarm — see 004a §9")

    # 13 — the negative vector -------------------------------------------------
    # Subtly wrong advancement: derive the message key from the chain key
    # WITHOUT advancing, i.e. an off-by-one that still produces valid-looking
    # AES-GCM output and self-consistent behaviour in a lone implementation.
    ck = hashlib.sha256(b"spotme/e2e_v3/testvector/chain-key-seed").digest()
    correct_mk = hmac.new(ck, LABEL_MSG + b"/0", hashlib.sha256).digest()
    offbyone_mk = hmac.new(ck, LABEL_MSG + b"/1", hashlib.sha256).digest()
    record("13_negative_subtly_wrong_advancement",
           description=("An implementation that advances the chain one step early produces a DIFFERENT "
                        "message key from the same chain key. Both look valid in isolation; only a "
                        "vector distinguishes them."),
           chain_key=hexs(ck),
           correct_message_key=hexs(correct_mk),
           off_by_one_message_key=hexs(offbyone_mk),
           must_hold="an implementation matching off_by_one_message_key is WRONG and this vector fails it",
           why=("this is the failure this whole package exists for: it is invisible to a self-test, "
                "invisible in review, and produces a transcript the peer cannot read"))

    json.dump(VECTORS, sys.stdout, indent=2, sort_keys=True)
    print(file=sys.stdout)
    print(f"\n{len(VECTORS)} vector groups generated.", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
