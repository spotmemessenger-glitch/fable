import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

interface UserJwtPayload {
  sub: string;
  role: string;
}

interface EmployeeJwtPayload {
  sub: string;
  role: string;
}

// Two separate strategies, two separate secrets — an end-user token must
// never be usable against a staff-only endpoint even if the payload shape matches.
@Injectable()
export class UserJwtStrategy extends PassportStrategy(Strategy, 'jwt-user') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_ACCESS_SECRET || 'dev-only-secret',
    });
  }

  validate(payload: UserJwtPayload) {
    return { id: payload.sub, role: payload.role, kind: 'user' as const };
  }
}

@Injectable()
export class EmployeeJwtStrategy extends PassportStrategy(Strategy, 'jwt-employee') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_ACCESS_SECRET || 'dev-only-secret',
    });
  }

  validate(payload: EmployeeJwtPayload) {
    return { id: payload.sub, role: payload.role, kind: 'employee' as const };
  }
}
