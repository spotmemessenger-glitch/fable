import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

@Module({
  imports: [JwtModule.register({})],
  providers: [RoomsGateway, RoomsService],
})
export class RoomsModule {}
