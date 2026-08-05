import { IsEmail, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { BIRTH_YEAR_MONTH_RE } from '../../policy/age';

// Names deliberately mirror what the current spotme/web onboarding already
// validates (src/main.js's username regex) so the client-side UX carries over.
export class SignupDto {
  @IsString()
  @Matches(/^[a-z0-9_]{3,16}$/)
  username!: string;

  // Wave 1B (D6): self-declared birth YEAR-MONTH — never a full DOB. Format
  // only here; ELIGIBILITY is decided in the service (server-side, always).
  @IsString()
  @Matches(BIRTH_YEAR_MONTH_RE)
  birthYearMonth!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  name?: string;
}

// Guest (no-account) identity — the web client's onboarding produces exactly
// this: a device-generated hex id, a claimed username, and a locally held
// claim secret whose hash proves ownership on re-auth and release.
export class GuestAuthDto {
  @IsString()
  @Matches(/^[a-f0-9]{8,64}$/i)
  id!: string;

  @IsString()
  @Matches(/^[a-z0-9_]{3,16}$/)
  username!: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  name?: string;

  @IsString()
  @Length(8, 128)
  secret!: string;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  publicKey?: string;

  // Install telemetry. Optional so older clients keep authenticating unchanged;
  // one that omits them is still counted, just with an unknown platform.
  @IsOptional()
  @IsIn(['web', 'android', 'ios'])
  platform?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  appVersion?: string;

  // Wave 1B (D6). OPTIONAL at the DTO layer because guest auth is
  // create-or-reauth in one call: existing devices re-authing predate the gate
  // and must keep reaching their messages (B2). The CREATE branch in the
  // service REQUIRES it — a new identity without a declaration is refused.
  @IsOptional()
  @IsString()
  @Matches(BIRTH_YEAR_MONTH_RE)
  birthYearMonth?: string;
}

export class RequestOtpDto {
  @IsEmail()
  email!: string;
}

export class VerifyOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsIn(['ios', 'android', 'web'])
  platform?: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

export class EmployeeLoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(8, 128)
  password!: string;
}
