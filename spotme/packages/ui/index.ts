/**
 * @spotme/ui entry.
 *
 * ONLY the surfaces slice 1 activates are exported. Exchange is live behind
 * `spotme.ui.exchange`; discovery/events/moments/assistant stay dark and are
 * deliberately absent, so importing this package cannot reach them and the
 * backend dark fences keep meaning what they say.
 */
import { createElement } from 'react';
import { ExchangeIsland } from './exchange/island';

export {
  BrowseScreen, DetailScreen, CreateScreen, MyIntentsScreen,
  OverflowMenu, BudgetBand, ApproxArea, approxDistance,
} from './exchange/screens';
export type { Draft, MineTab } from './exchange/screens';
export type { ExchangeIntentView, ExchangeMatchView } from './exchange/ports';

/**
 * The island's mount point. Composes the Exchange surface with fixture ports
 * and returns an element -- the host stays framework-agnostic and never needs
 * to know JSX. Live adapters replace the fixtures when the endpoints are
 * wired; nothing here fetches today.
 */
export function __mountExchange() {
  return createElement(ExchangeIsland);
}
