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
