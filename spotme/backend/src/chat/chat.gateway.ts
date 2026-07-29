import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ChatService } from './chat.service';

interface SendPayload {
  conversationId: string;
  cipherText: string;
  nonce?: string;
  kind?: string;
  mediaKey?: string;
  ttlSeconds?: number;
}

// One Socket.IO namespace per user id room — mirrors the "join your own inbox"
// pattern spotme/web's reach.js already uses, just server-brokered instead of P2P.
@WebSocketGateway({ cors: { origin: '*' }, namespace: '/chat' })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  constructor(
    private chat: ChatService,
    private jwt: JwtService,
  ) {}

  async handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) return client.disconnect();
    try {
      const payload = this.jwt.verify(token, { secret: process.env.JWT_ACCESS_SECRET || 'dev-only-secret' });
      client.data.userId = payload.sub;
      client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(_client: Socket) {
    // presence TTL is handled by the client calling POST /users/me/presence;
    // nothing to clean up server-side (no location history is kept).
  }

  @SubscribeMessage('message:send')
  async onSend(@ConnectedSocket() client: Socket, @MessageBody() payload: SendPayload) {
    const senderId = client.data.userId as string;
    const message = await this.chat.sendMessage(
      payload.conversationId,
      senderId,
      payload.cipherText,
      payload.kind || 'text',
      payload.nonce,
      payload.mediaKey,
      payload.ttlSeconds,
    );
    const participants = await this.chat.listConversations(senderId);
    const convo = participants.find((p) => p.conversationId === payload.conversationId);
    convo?.conversation.participants.forEach((p) => {
      this.server.to(`user:${p.userId}`).emit('message:new', message);
    });
    return message;
  }

  @SubscribeMessage('typing')
  onTyping(@ConnectedSocket() client: Socket, @MessageBody() payload: { conversationId: string }) {
    client.to(`user:${payload.conversationId}`).emit('typing', { userId: client.data.userId });
  }
}
