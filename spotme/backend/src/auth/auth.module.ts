import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { createTurnstileGate } from '../middleware/turnstile';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsernameController } from './username.controller';
import { KeysController } from './keys.controller';
import { SigningKeysController } from './signing-keys.controller';
import { SigningKeysService } from './signing-keys.service';
import { PreKeysController } from './prekeys.controller';
import { PreKeysService } from './prekeys.service';
import { UserJwtStrategy, EmployeeJwtStrategy } from './strategies/jwt.strategies';

@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [
    AuthController,
    UsernameController,
    KeysController,
    SigningKeysController,
    PreKeysController,
  ],
  providers: [
    AuthService,
    SigningKeysService,
    PreKeysService,
    UserJwtStrategy,
    EmployeeJwtStrategy,
  ],
  exports: [AuthService],
})
export class AuthModule implements NestModule {
  /**
   * Turnstile in front of the unauthenticated account surface (ADR-032):
   * signup, guest signup, guest recovery, and both OTP legs. Structurally
   * bypassed while TURNSTILE_SECRET_KEY is unset — the middleware next()s
   * untouched, so nothing changes until the owner adds keys.
   *
   * `guest/recover` is here because it is a GUESSING surface, not just a
   * creation one: it takes @username + a recovery code and hands back the
   * account on a match, so an unthrottled attacker can grind codes against a
   * username that username search hands out for free. It needs the bot check
   * more than signup does, and Nest path matching treats it as a distinct
   * route — `auth/guest` alone does NOT cover it.
   *
   * Refresh and employee login are deliberately NOT challenged: both already
   * require a credential the caller must already hold.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createTurnstileGate()).forRoutes(
      { path: 'auth/signup', method: RequestMethod.POST },
      { path: 'auth/guest', method: RequestMethod.POST },
      { path: 'auth/guest/recover', method: RequestMethod.POST },
      { path: 'auth/otp/request', method: RequestMethod.POST },
      { path: 'auth/otp/verify', method: RequestMethod.POST },
    );
  }
}
