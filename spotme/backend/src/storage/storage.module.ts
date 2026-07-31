import { Global, Logger, Module } from '@nestjs/common';
import { LocalStorageAdapter } from './local-storage.adapter';
import { S3StorageAdapter } from './s3-storage.adapter';
import { LocalMediaController } from './media.controller';
import { StorageCleanupService } from './storage-cleanup.service';
import { STORAGE_ADAPTER, IStorageAdapter } from './storage.interface';

/**
 * Which store holds attachment bytes. Phase 4, the same seam shape as ADR-002.
 *
 * `STORAGE_PROVIDER=local|s3`, defaulting to local. The default matters: a
 * deployment that forgets to set it gets working local storage rather than a
 * backend that boots and then fails every media call, and a developer who has
 * never heard of R2 can run the whole app.
 *
 * SELECTION IS LOGGED, LOUDLY. The Phase 2 lesson was that a silent fallback is
 * the worst outcome — you believe you are testing one thing and you are testing
 * another. An unrecognised value is called out and falls back rather than
 * throwing, because `STORAGE_PROVIDER=S3` (capitalised) should not be an outage.
 *
 * @Global because both RoomsService (burn) and MediaController need the adapter,
 * and threading one provider through module imports for two consumers is more
 * ceremony than it buys — the same call PushModule already makes.
 */
@Global()
@Module({
  /* Only the UNAUTHENTICATED data-plane route lives here — it needs no
   * RoomsAuthService, because the HMAC in its URL is the credential. The authed
   * `presign` / `download-url` routes live in RoomsModule instead: they need
   * RoomsAuthService, and importing GroupsModule here to get it would close a
   * cycle (StorageModule -> GroupsModule -> @Global STORAGE_ADAPTER). Media
   * authorisation belongs next to room authorisation anyway. */
  controllers: [LocalMediaController],
  providers: [
    LocalStorageAdapter,
    S3StorageAdapter,
    StorageCleanupService,
    {
      provide: STORAGE_ADAPTER,
      inject: [LocalStorageAdapter, S3StorageAdapter],
      useFactory: (local: LocalStorageAdapter, s3: S3StorageAdapter): IStorageAdapter => {
        const log = new Logger('StorageModule');
        const requested = (process.env.STORAGE_PROVIDER || 'local').trim().toLowerCase();
        if (requested === 's3') {
          if (!process.env.S3_BUCKET) {
            log.warn('STORAGE_PROVIDER=s3 but S3_BUCKET is unset — using local storage instead');
            return local;
          }
          log.log(`storage provider: s3 (bucket ${process.env.S3_BUCKET})`);
          return s3;
        }
        if (requested !== 'local') {
          log.warn(`unknown STORAGE_PROVIDER "${requested}" — using local storage`);
        } else {
          log.log('storage provider: local');
        }
        return local;
      },
    },
  ],
  exports: [STORAGE_ADAPTER, LocalStorageAdapter, StorageCleanupService],
})
export class StorageModule {}
