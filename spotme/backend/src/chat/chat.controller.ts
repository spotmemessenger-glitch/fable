import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { ChatService } from './chat.service';

@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(private chat: ChatService) {}

  @Get('conversations')
  conversations(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.chat.listConversations(principal.id);
  }

  @Get('conversations/:id')
  getOne(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    return this.chat.getConversation(id, principal.id);
  }

  @Get('conversations/:id/messages')
  history(
    @Param('id') id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query('take') take?: string,
  ) {
    return this.chat.history(id, principal.id, take ? Number(take) : undefined);
  }

  @Post('conversations/:id/read')
  markRead(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    return this.chat.markRead(id, principal.id);
  }
}
