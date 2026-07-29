import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// Applies to end-user endpoints. Employee dashboard endpoints use
// EmployeeAuthGuard instead — separate token audience, separate secret scope.
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt-user') {}
