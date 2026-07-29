import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class EmployeeAuthGuard extends AuthGuard('jwt-employee') {}
