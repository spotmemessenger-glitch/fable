// Tests boot the real AppModule, which needs DATABASE_URL and the JWT secrets
// before Nest constructs anything. ConfigModule loads .env too, but Prisma
// reads the URL at client construction, which happens first.
import { config } from 'dotenv';
import { join } from 'node:path';

config({ path: join(__dirname, '..', '.env') });
