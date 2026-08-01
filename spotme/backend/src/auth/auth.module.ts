import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
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
export class AuthModule {}
