/**
 * Spot Me core — the P2P layer, written once.
 *
 * Everything reachable from here is free of Node built-ins and of React, so
 * this same code runs inside a Bare worklet on mobile and in plain Node on the
 * always-on relay node. The UI never imports Hypercore; it talks to a Room.
 *
 * Verified 2026-07-24 on this machine:
 *   test/room.test.js      13/13  two peers converge; invites gate writing
 *   test/identity.test.js  15/15  24 words restore identity and conversations
 */
const { Room, makeOpen, apply } = require('./room')
const identity = require('./identity')
const schema = require('./schema')

module.exports = {
  Room,
  makeOpen,
  apply,

  // identity + recovery
  generateMnemonic: identity.generateMnemonic,
  validateMnemonic: identity.validateMnemonic,
  normaliseMnemonic: identity.normaliseMnemonic,
  fromMnemonic: identity.fromMnemonic,
  deviceKeyPair: identity.deviceKeyPair,
  authoriseDevice: identity.authoriseDevice,
  verifyDevice: identity.verifyDevice,
  sealBundle: identity.sealBundle,
  openBundle: identity.openBundle,

  // wire format
  OP: schema.OP,
  EPHEMERAL: schema.EPHEMERAL,
  SCHEMA_VERSION: schema.SCHEMA_VERSION,
  isValidOp: schema.isValidOp
}
