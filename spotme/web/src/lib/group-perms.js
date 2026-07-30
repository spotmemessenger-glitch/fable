/**
 * Spot Me — who may do what in a group.
 *
 * Deliberately dependency-free. These rules decide whether a destructive
 * action (ban, remove, transfer) is even offered, so they are the part most
 * worth testing, and a module that imports the socket transport cannot be
 * tested without standing up a socket. Everything here is a pure function of
 * the group shape the server already sends.
 *
 * The rules mirror groups.service.ts. Where they disagree the server wins —
 * it is the authority — but a UI that offers what the server refuses reads as
 * a broken app rather than a rule, so they are kept in step.
 */

const RANK = { OWNER: 3, ADMIN: 2, MODERATOR: 1, MEMBER: 0 }

export const rank = (role) => RANK[role] ?? 0

/**
 * You may only act on somebody strictly below you. Equal rank is refused —
 * two admins cannot ban each other, which is what stops a mutual-removal race
 * from emptying a group's admin list.
 */
export const outranks = (viewerRole, targetRole) => rank(viewerRole) > rank(targetRole)

/** OWNER implicitly holds every grant; everyone else holds what was granted. */
export const may = (group, grant) =>
  group?.myRole === 'OWNER' || Boolean(group?.myGrants?.[grant])

export const ROLE_LABEL = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MODERATOR: 'Moderator',
  MEMBER: 'Member'
}
