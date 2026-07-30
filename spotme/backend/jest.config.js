/**
 * Gateway tests boot the real Nest app against the DATABASE_URL in .env, so
 * they need that file loaded and enough room for socket handshakes. Kept as a
 * config file rather than package.json so setupFiles has somewhere to point.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*spec.ts', '<rootDir>/src/**/*spec.ts'],
  setupFiles: ['<rootDir>/test/load-env.ts'],
  // Sockets and Nest shutdown are async; surface anything left hanging rather
  // than letting a leak look like a pass.
  detectOpenHandles: true,
  forceExit: true,
};
