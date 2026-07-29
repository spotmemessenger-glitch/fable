import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedPrincipal {
  id: string;
  role: string;
  kind: 'user' | 'employee';
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedPrincipal => {
    const req = ctx.switchToHttp().getRequest();
    return req.user;
  },
);
