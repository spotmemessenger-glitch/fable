// Mirrors prisma/schema.prisma's Role enum. Kept as a plain TS enum too so
// guards/decorators don't need a Prisma import at the edges of the app.
export enum Role {
  USER = 'USER',
  SUPPORT = 'SUPPORT',
  MODERATOR = 'MODERATOR',
  ADMIN = 'ADMIN',
  OPS = 'OPS',
}

// Ops sees health only; Support sees report metadata; Moderator sees reported
// content; Admin sees everything plus employee management.
export const STAFF_ROLES: Role[] = [Role.SUPPORT, Role.MODERATOR, Role.ADMIN, Role.OPS];
