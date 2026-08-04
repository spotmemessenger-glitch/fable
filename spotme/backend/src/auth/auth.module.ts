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
   * Turnstile in front of the account-creation surface only (ADR-032):
   * signup, guest signup, and both OTP legs. Structurally bypassed while
   * TURNSTILE_SECRET_KEY is unset — the middleware next()s untouched, so
   * nothing changes until the owner adds keys. Refresh and employee login
   * are deliberately not challenged: both already require a credential.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createTurnstileGate()).forRoutes(
      { path: 'auth/signup', method: RequestMethod.POST },
      { path: 'auth/guest', method: RequestMethod.POST },
      { path: 'auth/otp/request', method: RequestMethod.POST },
      { path: 'auth/otp/verify', method: RequestMethod.POST },
    );
  }
}
