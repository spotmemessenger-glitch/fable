import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SignupDto, GuestAuthDto, RequestOtpDto, VerifyOtpDto, RefreshDto, EmployeeLoginDto } from './dto/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto.username, dto.email, dto.name);
  }

  /** No-account identity for the web client: create-or-reauth in one call. */
  @Post('guest')
  guest(@Body() dto: GuestAuthDto) {
    return this.auth.guestAuth(dto.id, dto.username, dto.name, dto.secret, dto.publicKey);
  }

  @Post('otp/request')
  async requestOtp(@Body() dto: RequestOtpDto) {
    const { code } = await this.auth.requestOtp(dto.email);
    // TODO: wire to Resend/SES once OTP_FROM_EMAIL + RESEND_API_KEY are set;
    // returned here only so local/dev testing works without an email provider.
    if (process.env.NODE_ENV !== 'production') return { sent: true, devCode: code };
    return { sent: true };
  }

  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto.email, dto.code, dto.deviceId, dto.platform);
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('employee/login')
  employeeLogin(@Body() dto: EmployeeLoginDto) {
    return this.auth.employeeLogin(dto.email, dto.password);
  }
}
