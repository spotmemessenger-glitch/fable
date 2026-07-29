/**
 * One-time bootstrap: creates the first ADMIN employee so someone can log
 * into the dashboard at all. Run once via `npm run seed:employee` with
 * SEED_ADMIN_EMAIL / SEED_ADMIN_NAME / SEED_ADMIN_PASSWORD set — never commit
 * real values, this is meant to be run from the deploy environment's shell.
 */
import { PrismaClient, Role } from '@prisma/client';
import * as argon2 from 'argon2';

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const name = process.env.SEED_ADMIN_NAME || 'Admin';
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD before running this script.');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  const existing = await prisma.employee.findUnique({ where: { email } });
  if (existing) {
    console.log(`Employee ${email} already exists — nothing to do.`);
    await prisma.$disconnect();
    return;
  }
  const passwordHash = await argon2.hash(password);
  await prisma.employee.create({ data: { email, name, passwordHash, role: Role.ADMIN } });
  console.log(`Created admin employee ${email}.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
