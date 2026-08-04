/**
 * @spotme/contracts — shared TypeScript domain types for Spot Me.
 *
 * The single source of truth for cross-surface contracts. Types only: no
 * runtime, no dependencies, nothing imported by the running product yet. New
 * TypeScript surfaces (packages/*, spotme/web-next, and — over time — the
 * backend) consume these instead of redefining shapes.
 */

export type {
  PreciseLocation,
  CoarseLocation,
  LocationPrecision,
  GeoCell,
  RadiusKm,
  PublicLocation,
} from './location.ts';

export type {
  ItemType,
  ItemStatus,
  BudgetBand,
  MatchStatus,
  Timeframe,
  ExchangeItemInput,
  StructuredIntent,
  ExchangeItemPublic,
  Match,
  SearchState,
  ExchangeSearchInput,
  ExchangeSearchResult,
} from './exchange.ts';

// Platform Phase 3 — versioned Exchange contracts (DARK).
export { EXCHANGE_CONTRACTS_VERSION } from './exchange.ts';
export type {
  ExchangeContractsVersion,
  ExchangeOwnerRef,
  ExchangeIntentKind,
  ExchangeIntentStatus,
  ExchangeVisibility,
  ExchangeAvailability,
  ExchangeRadiusPolicy,
  ExchangeInformationalPrice,
  ExchangeVersion,
  ExchangeModerationState,
  ExchangeIntentBase,
  ExchangeNeed,
  ExchangeOffer,
  ExchangeService,
  ExchangeIntent,
  ExchangeLifecycleEvent,
  ExchangeMatchStatus,
  ExchangeMatchSignal,
  ExchangeMatchExplanation,
  ExchangeMatch,
  ExchangeReputationSummary,
  ExchangeBusinessPublic,
  ExchangeSearchQuery,
  ExchangeCursor,
  ExchangePage,
  ExchangeContactCapability,
} from './exchange.ts';

// Platform Phase 4 — versioned Live Nearby Events contracts (DARK).
export { EVENTS_CONTRACTS_VERSION } from './events.ts';
export type {
  EventsContractsVersion,
  EventCategory,
  EventSourceLifecycle,
  EventState,
  EventPopularity,
  EventTime,
  EventStateProvenance,
  EventSource,
  EventPublic,
  EventRankingSignal,
  EventRankingComponent,
  EventRankingBreakdown,
  RankedEventPublic,
  EventDedupBasis,
  EventDedupEvidence,
  EventDedupDecision,
  EventSearchState,
  EventTimeWindow,
  EventSearchQuery,
  EventCursor,
  EventPage,
  EventCapabilities,
} from './events.ts';

export { DISCOVERY_CONTRACTS_VERSION } from './discovery.ts';
export type {
  DiscoveryContractsVersion,
  CoarsePublicLocation,
  DistanceBand,
  DiscoveryRadius,
  DiscoveryIntent,
  DiscoveryScope,
  DiscoveryFilters,
  SearchCursor,
  DiscoveryQuery,
  FreshnessMetadata,
  RankingComponent,
  RankingBreakdown,
  ResultSource,
  FriendRequestCapability,
  BlockReportCapability,
  NearbyPersonPublic,
  NearbyPlacePublic,
  DiscoveryResult,
  DiscoveryResultPage,
  DiscoveryState,
  DiscoveryError,
  VisibilityPreference,
} from './discovery.ts';
