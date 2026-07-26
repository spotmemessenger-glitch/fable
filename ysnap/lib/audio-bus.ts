/**
 * Tiny event contract between the two things on the page that make sound:
 * the hero's music track and the support assistant's voice.
 *
 * It lives here rather than in either component so neither has to import the
 * other — the assistant would otherwise pull the dancer's three.js dynamic
 * import into its own bundle just to read a string.
 */

/** Dispatched on `window` when the assistant panel opens. The hero dancer
 *  listens and pauses its track so the two never talk over each other. */
export const ASSISTANT_OPEN_EVENT = "ysnap:assistant-open";
