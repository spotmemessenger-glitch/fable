/**
 * Groups client ports (slice 3). The island composes these; the package never
 * touches the network, storage, or a socket — only injected ports. The live
 * adapters live in apps/web/src/views/groups-island.js, where importing the
 * legacy lib modules is legal; here they would trip the isolation fence.
 *
 * PERSISTED-SHAPE RULE (ADR-035 §(g)): this package never spells a stored
 * shape. Convo writes go through `LocalStorePort`, whose live implementation
 * calls the SAME db functions the legacy views call — same keys, same schema,
 * same encodings, by construction.
 *
 * PERMISSION RULE: gating mirrors lib/group-perms.js, which is injected as
 * `PermsPort` rather than rewritten. The package tests inject the real module.
 */

export type Role = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';

export interface GroupMemberView {
  userId: string;
  name?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  role: Role;
  bannedAt?: string | null;
  mutedUntil?: string | null;
}

export interface GroupView {
  id: string;
  roomId: string;
  name: string;
  username?: string | null;
  avatarUrl?: string | null;
  visibility: 'PRIVATE' | 'PUBLIC';
  myRole: Role;
  myGrants?: Record<string, boolean>;
  permissions?: { membersCanAdd?: boolean; membersCanMessage?: boolean; membersCanMedia?: boolean };
  members: GroupMemberView[];
}

/** A group list entry as `GET /api/groups` returns it (no members roster). */
export type GroupSummary = Omit<GroupView, 'members'> & { members?: GroupMemberView[] };

/** The slice of a local convo the list screen renders. Read-only here. */
export interface ConvoView {
  roomId: string;
  title?: string;
  groupId?: string;
  secret?: string;
  kind: string;
  archived?: boolean;
  unread?: number;
  created?: number;
  last?: { ts: number; fromMe?: boolean; text: string } | null;
}

export interface PersonView {
  id: string;
  name?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
}

export interface CreateGroupInput {
  name: string;
  memberIds: string[];
  visibility: 'PRIVATE' | 'PUBLIC';
  username?: string;
  membersCanAdd: boolean;
  membersCanMessage: boolean;
  membersCanMedia: boolean;
}

/** Mirrors lib/groups-api.js — the live adapter passes it through directly. */
export interface GroupsApiPort {
  create(payload: CreateGroupInput & { roomId: string; secretKey?: string }): Promise<{ id?: string }>;
  listMine(): Promise<GroupSummary[]>;
  getOne(id: string): Promise<GroupView>;
  update(id: string, patch: Record<string, unknown>): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  usernameAvailable(username: string): Promise<{ available: boolean; reason?: string }>;
  joinPublic(username: string): Promise<any>;
  addMember(id: string, userId: string): Promise<unknown>;
  removeMember(id: string, userId: string): Promise<unknown>;
  leave(id: string): Promise<unknown>;
  transfer(id: string, userId: string): Promise<unknown>;
  setRole(id: string, userId: string, role: Role): Promise<unknown>;
  setBan(id: string, userId: string, banned: boolean): Promise<unknown>;
  setMute(id: string, userId: string, minutes: number | null): Promise<unknown>;
}

/** lib/group-perms.js, injected. The rules are REUSED, never re-derived. */
export interface PermsPort {
  rank(role: string | undefined): number;
  outranks(viewerRole: string | undefined, targetRole: string | undefined): boolean;
  may(group: { myRole?: string; myGrants?: Record<string, boolean> } | null, grant: string): boolean;
  ROLE_LABEL: Record<string, string>;
}

/** Local convo store. Live adapter wraps lib/db.js; shapes stay in the app. */
export interface LocalStorePort {
  convos(): ConvoView[];
  /** Writes the legacy group-convo shape. Defined app-side on purpose. */
  upsertGroupConvo(g: { roomId: string; secret: string; name: string; groupId?: string }): void;
  removeConvo(roomId: string): void;
  setArchived(roomId: string, archived: boolean): void;
  subscribe(cb: () => void): () => void;
  /** 16-byte hex id, from the app's own generator. */
  newId(): string;
}

export interface RoomsPort {
  ensure(roomId: string): void;
  leave(roomId: string): void;
}

export interface HostPort {
  nav(path: string): void;
  openThread(roomId: string): void;
  toast(message: string): void;
  /** Builds the invite URL app-side (origin + fragment key never leave it). */
  inviteUrl(convo: { roomId: string; secret: string }, name: string): string;
  share(url: string, name: string): Promise<void>;
}

export interface PeoplePort {
  search(query: string): Promise<PersonView[]>;
}

export interface GroupsDeps {
  api: GroupsApiPort;
  perms: PermsPort;
  local: LocalStorePort;
  rooms: RoomsPort;
  host: HostPort;
  people: PeoplePort;
}
