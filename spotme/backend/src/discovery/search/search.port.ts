/**
 * SearchPort — provider-neutral username/place text search (checkpoint 6).
 *
 * Typesense is the SELECTED target (tech-stack §14) and sits BEHIND this port;
 * the port is what the discovery service composes, so the engine remains
 * swappable (P9) and the mandatory production-hardware re-benchmark before
 * wiring stands (A4). NOT imported into the running application: only the
 * dark DiscoveryModule binds it.
 *
 * Index content policy (threat model C-INDEX-MIN): ONLY privacy-safe public
 * projections — userId, opt-in handle + normalized form, display name,
 * approved aliases; place name/category/locality labels; authorized
 * Exchange-compatible intent labels for FUTURE use (no Exchange records this
 * phase). NO precise coordinates, NO message content, NO private profiles,
 * NO contact-book data — the document types make those unrepresentable.
 */

/** A username document as indexed — the complete allowed field set (D10). */
export interface UsernameIndexDoc {
  id: string;              // userId
  handle: string;          // opt-in public handle, canonical form
  normalizedHandle: string;
  displayName: string;
  aliases?: string[];      // approved aliases only
  kind: 'username';
}

/** A place document as indexed — labels only, never coordinates. */
export interface PlaceIndexDoc {
  id: string;
  name: string;
  category?: string;
  localityLabels?: string[];   // city/locality display labels
  intentLabels?: string[];     // authorized Exchange-compatible labels (future)
  kind: 'place';
}

export type SearchIndexDoc = UsernameIndexDoc | PlaceIndexDoc;

export interface SearchHit {
  id: string;
  kind: 'username' | 'place';
  /** True when the query exactly matches the normalized handle (D10 priority). */
  exactHandleMatch?: boolean;
  /** Field values as indexed — public projections only. */
  fields: Record<string, string | string[] | undefined>;
  /** Engine relevance score — normalized [0,1] where the engine provides one. */
  score?: number;
}

/** Discriminated result — a search NEVER fabricates; unavailability is typed. */
export type SearchResult =
  | { state: 'ok'; hits: SearchHit[] }
  | { state: 'no-results' }
  | { state: 'provider-unavailable'; reason: 'unconfigured' | 'circuit-open' | 'timeout' | 'error' };

export interface SearchQueryOptions {
  /** Bounded by the adapter's ceiling regardless of what the caller asks. */
  limit?: number;
  kind?: 'username' | 'place';
}

export interface SearchPort {
  readonly name: string;
  /** Typo-tolerant, prefix-capable text search over the privacy-safe index. */
  search(query: string, opts?: SearchQueryOptions): Promise<SearchResult>;
  /** Upsert a projection document (dark: exercised by tests only this phase). */
  indexDoc(doc: SearchIndexDoc): Promise<{ ok: boolean }>;
  /** Remove a document — user deletion removes the projection everywhere. */
  removeDoc(id: string): Promise<{ ok: boolean }>;
  /** Liveness for ops; never throws. */
  health(): Promise<'ok' | 'unavailable'>;
}

export const SEARCH_PORT = Symbol('SEARCH_PORT');
