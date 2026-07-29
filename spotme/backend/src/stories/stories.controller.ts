import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { StoriesService } from './stories.service';
import { CreateStoryDto } from './dto/story.dto';

@UseGuards(JwtAuthGuard)
@Controller('stories')
export class StoriesController {
  constructor(private stories: StoriesService) {}

  @Post()
  create(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: CreateStoryDto) {
    return this.stories.create(principal.id, dto.kind, dto.textContent);
  }

  @Get('feed')
  feed(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.stories.feed(principal.id);
  }

  @Post(':id/view')
  view(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    return this.stories.recordView(id, principal.id);
  }

  @Get(':id/views')
  listViews(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    return this.stories.listViews(id, principal.id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    return this.stories.remove(id, principal.id);
  }
}
