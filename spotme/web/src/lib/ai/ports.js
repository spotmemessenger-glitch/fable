/**
 * AI Gateway — provider-neutral port contracts (DPAS ch.05/06, PRD §8.5).
 *
 * These are INTERFACES, expressed as JSDoc typedefs. The gateway routes to an
 * implementation per port; no provider is a hard dependency and every call must
 * be able to fall back on quality, latency, availability, or cost. The only
 * implementations that exist today are the DETERMINISTIC BASELINES in
 * `baseline.js` — no model calls, no API keys, no network. Model-backed
 * adapters are added later, behind owner authorisation, and never become the
 * only path.
 *
 * DARK: nothing under `src/` outside this folder imports the gateway. The fence
 * `test/ai-gateway-not-shipped.test.js` enforces that until wire-in.
 *
 * @typedef {Object} StructuredIntent
 * @property {'need'|'offer'} type
 * @property {string} category
 * @property {string[]} keywords
 * @property {{from?:string,to?:string}} [timeframe]
 * @property {'low'|'medium'|'high'} [budgetBand]
 * @property {number} confidence  // [0,1]
 *
 * @typedef {Object} IntentPort
 * @property {(text:string)=>StructuredIntent} parse   // NL → structured intent
 * @property {(a:StructuredIntent,b:StructuredIntent)=>number} similarity // [0,1]
 *
 * @typedef {Object} SummaryPort
 * @property {(text:string, opts?:{maxChars?:number})=>string} summarize
 *
 * @typedef {Object} VoicePort
 * @property {(audio:unknown)=>{text:string,engine:string,confidence:number}} transcribe
 * @property {(text:string)=>{audio:null,engine:string,text:string}} synthesize
 *
 * @typedef {Object} AiGateway
 * @property {IntentPort} intent
 * @property {SummaryPort} summary
 * @property {VoicePort} voice
 */

export {}
