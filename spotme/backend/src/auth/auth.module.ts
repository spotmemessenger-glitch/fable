import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsernameController } from './username.controller';
import { KeysController } from './keys.controller';
import { UserJwtStrategy, EmployeeJwtStrategy } from './strategies/jwt.strategies';

@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AuthController, UsernameController, KeysController],
  providers: [AuthService, UserJwtStrategy, EmployeeJwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
