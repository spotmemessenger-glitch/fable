import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { PreKeysService } from './prekeys.service';

/**
 * X3DH prekey bundles (ADR-004 §8, e2e_v3). Publish my device's prekeys; fetch
 * a peer's bundle (which atomically consumes a one-time prekey). Everything
 * that writes is keyed off the JWT principal; a peer bundle is fetched by
 * (userId, deviceId) because a peer may have several devices, each with its own
 * prekeys.
 */
@UseGuards(JwtAuthGuard)
@Controller('v2/auth/prekeys')
export class PreKeysController {
  constructor(private prekeys: PreKeysService) {}

  /** Publish or refill MY device's signed prekey + one-time prekeys. */
  @Put()
  publish(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body()
    body: {
      deviceId?: string;
      spk?: { keyId?: number; pub?: string; sig?: string };
      opks?: { keyId?: number; pub?: string }[];
    },
  ) {
    return this.prekeys.publish(principal.id, body);
  }

  /** How many one-time prekeys MY named device has left, so it knows to refill. */
  @Get('count/:deviceId')
  count(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('deviceId') deviceId: string,
  ) {
    return this.prekeys.count(principal.id, deviceId);
  }

  /** Fetch a PEER's bundle for a device, consuming one one-time prekey. */
  @Get('bundle/:userId')
  bundle(@Param('userId') userId: string, @Query('deviceId') deviceId: string) {
    return this.prekeys.fetchBundle(userId, String(deviceId ?? ''));
  }
}
