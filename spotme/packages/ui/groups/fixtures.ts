/**
 * In-memory Groups deps for the package tests. No network, no storage.
 *
 * `perms` is a REQUIRED argument, not a fixture: the permission rules live in
 * apps/web/src/lib/group-perms.js and the tests inject the real module, so
 * the gating battery exercises the rules the product actually ships.
 */
import type {
  ConvoView, GroupsDeps, GroupSummary, GroupView, PermsPort, PersonView,
} from './ports';

export interface FixtureWorld {
  deps: GroupsDeps;
  calls: { name: string; args: unknown[] }[];
  toasts: string[];
  navs: string[];
  openedThreads: string[];
  convos: ConvoView[];
  groups: GroupView[];
}

export function makeDeps(opts: {
  perms: PermsPort;
  groups?: GroupView[];
  convos?: ConvoView[];
  people?: PersonView[];
}): FixtureWorld {
  const calls: FixtureWorld['calls'] = [];
  const toasts: string[] = [];
  const navs: string[] = [];
  const openedThreads: string[] = [];
  const groups = opts.groups ?? [];
  const convos = opts.convos ?? [];
  const people = opts.people ?? [];
  const record = (name: string, ...args: unknown[]) => { calls.push({ name, args }); };
  let n = 0;

  const deps: GroupsDeps = {
    api: {
      create: async (p) => { record('create', p); return { id: `g${++n}` }; },
      listMine: async () => groups.map(({ members: _m, ...rest }) => rest as GroupSummary),
      getOne: async (id) => {
        const g = groups.find((x) => x.id === id);
        if (!g) throw new Error('not found');
        return g;
      },
      update: async (id, patch) => record('update', id, patch),
      remove: async (id) => record('remove', id),
      usernameAvailable: async (u) => ({ available: u !== 'taken' }),
      joinPublic: async (u) => { record('joinPublic', u); return { roomId: 'r-join', secretKey: 's-join', name: `@${u}`, id: 'gj' }; },
      addMember: async (id, userId) => record('addMember', id, userId),
      removeMember: async (id, userId) => record('removeMember', id, userId),
      leave: async (id) => record('leave', id),
      transfer: async (id, userId) => record('transfer', id, userId),
      setRole: async (id, userId, role) => record('setRole', id, userId, role),
      setBan: async (id, userId, banned) => record('setBan', id, userId, banned),
      setMute: async (id, userId, minutes) => record('setMute', id, userId, minutes),
    },
    perms: opts.perms,
    local: {
      convos: () => convos,
      upsertGroupConvo: (g) => { record('upsertGroupConvo', g); convos.push({ roomId: g.roomId, secret: g.secret, title: g.name, groupId: g.groupId, kind: 'group' }); },
      removeConvo: (roomId) => record('removeConvo', roomId),
      setArchived: (roomId, archived) => record('setArchived', roomId, archived),
      subscribe: () => () => {},
      newId: () => `id${++n}`,
    },
    rooms: {
      ensure: (roomId) => record('rooms.ensure', roomId),
      leave: (roomId) => record('rooms.leave', roomId),
    },
    host: {
      nav: (path) => { navs.push(path); },
      openThread: (roomId) => { openedThreads.push(roomId); },
      toast: (message) => { toasts.push(message); },
      inviteUrl: (c, name) => `https://spot.test/#r=${c.roomId}&k=${c.secret}&g=${encodeURIComponent(name)}`,
      share: async (url) => { record('share', url); },
    },
    people: {
      search: async (q) => people.filter((p) =>
        (p.name || '').toLowerCase().includes(q.toLowerCase()) ||
        (p.username || '').toLowerCase().includes(q.toLowerCase())),
    },
  };

  return { deps, calls, toasts, navs, openedThreads, convos, groups };
}
