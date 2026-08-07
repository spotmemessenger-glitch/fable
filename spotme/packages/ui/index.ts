/**
 * @spotme/ui entry.
 *
 * ONLY flagged surfaces are exported: Exchange (slice 1, `spotme.ui.exchange`)
 * and Contacts/Notifications/Stories (slice 2, one flag each).
 * discovery/events/moments/assistant stay dark and are deliberately absent,
 * so importing this package cannot reach them and the backend dark fences
 * keep meaning what they say.
 */
import { createElement } from 'react';
import { ExchangeIsland } from './exchange/island';
import { ContactsShell } from './contacts/ContactsShell';
import { NotificationsShell } from './notifications/NotificationsShell';
import { StoriesShell } from './stories/StoriesShell';
import type { ContactsPort } from './contacts/ports';
import type { NotificationsPort } from './notifications/ports';
import type { StoriesPort } from './stories/ports';
import { GroupsIsland, type GroupsIslandProps } from './groups/island';
import { ProfileShell } from './profile/ProfileShell';
import type { ProfilePort } from './profile/ports';

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

/**
 * Slice-2 mount points. Unlike Exchange these surfaces have LIVE legacy data,
 * so the app passes a port built over its own db/lobby libs — the package
 * stays framework-pure and storage-free, the app stays JSX-free.
 */
export type { ContactsPort, ContactRowView } from './contacts/ports';
export type { NotificationsPort, NotifChatRow, NotifNearbyRow } from './notifications/ports';
export type { StoriesPort, StoryRingView } from './stories/ports';

export function __mountContacts(port: ContactsPort) {
  return createElement(ContactsShell, { port });
}

export function __mountNotifications(port: NotificationsPort) {
  return createElement(NotificationsShell, { port });
}

export function __mountStories(port: StoriesPort) {
  return createElement(StoriesShell, { port });
export type { GroupsDeps } from './groups/ports';

/**
 * Slice 3: Groups. Unlike Exchange this is a LIVE surface, so the host passes
 * the live adapters (built app-side from lib/groups-api.js, lib/db.js,
 * lib/group-perms.js, lib/rooms.js) rather than fixtures. Behind
 * `spotme.ui.groups`, default OFF.
 */
export function __mountGroups(props: GroupsIslandProps) {
  return createElement(GroupsIsland, props);
}

/** Slice 4 — Profile & Settings, behind spotme.ui.profile (default OFF). */
export type { ProfilePort, ProfileSnapshot, ToggleKey, EditableFieldKey, UsernameCheck } from './profile/ports';

export function __mountProfile(port: ProfilePort) {
  return createElement(ProfileShell, { port });
}
