import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { ChatRequestsService } from './chat-requests.service';
import { CreateChatRequestDto, RespondChatRequestDto } from './dto/chat-request.dto';

@UseGuards(JwtAuthGuard)
@Controller('chat-requests')
export class ChatRequestsController {
  constructor(private requests: ChatRequestsService) {}

  @Post()
  create(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: CreateChatRequestDto) {
    return this.requests.initiate(principal.id, dto.toUserId, dto.source, dto.greeting);
  }

  @Get('pending')
  pending(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.requests.pendingForUser(principal.id);
  }

  @Post(':id/respond')
  respond(
    @Param('id') id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: RespondChatRequestDto,
  ) {
    return this.requests.respond(id, principal.id, dto.accept);
  }
}
