import { Inject, Injectable, Optional } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NotificationsModule } from '../../src/notifications/notifications.module';
import { NotificationProducer } from '../../src/notifications/producers/notification-producer';

/**
 * The DynamicModule wiring contract that keeps the flag-off app byte-identical:
 *  - `register()` with the master flag OFF is INERT (no providers/controllers);
 *  - a consumer that holds `NotificationProducer` as an OPTIONAL dependency (as
 *    `RoomsGateway` does) resolves to `undefined` with the module off — so the
 *    producer hook is skipped and nothing changes;
 *  - `register()` ON is a @Global module that EXPORTS the producer for injection.
 *
 * This is the exact pattern the rooms gateway relies on, mechanised without a DB.
 */

@Injectable()
class OptionalConsumer {
  constructor(
    @Optional() @Inject(NotificationProducer) public readonly producer?: NotificationProducer,
  ) {}
}

describe('NotificationsModule.register() wiring', () => {
  const prev = process.env.NOTIFICATIONS_V2_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.NOTIFICATIONS_V2_ENABLED;
    else process.env.NOTIFICATIONS_V2_ENABLED = prev;
  });

  it('OFF (default): inert import, and an optional consumer resolves to undefined', async () => {
    delete process.env.NOTIFICATIONS_V2_ENABLED;
    const moduleRef = await Test.createTestingModule({
      imports: [NotificationsModule.register()],
      providers: [OptionalConsumer],
    }).compile();

    // The consumer instantiates fine and its optional producer is undefined —
    // exactly the rooms-gateway situation with the platform off.
    expect(moduleRef.get(OptionalConsumer).producer).toBeUndefined();
    await moduleRef.close();
  });

  it('ON: register() is a @Global module that provides + exports the producer', () => {
    process.env.NOTIFICATIONS_V2_ENABLED = 'true';
    const dyn = NotificationsModule.register();
    expect(dyn.global).toBe(true);
    expect(dyn.providers).toContain(NotificationProducer);
    expect(dyn.exports).toContain(NotificationProducer);
    // Controllers only mount when ON.
    expect((dyn.controllers ?? []).length).toBeGreaterThan(0);
  });
});
