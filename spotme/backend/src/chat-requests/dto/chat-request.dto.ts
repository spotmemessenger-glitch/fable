import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

export class CreateChatRequestDto {
  @IsString()
  toUserId!: string;

  @IsIn(['NEARBY', 'USERNAME', 'LINK', 'CONTACT', 'BLUETOOTH'])
  source!: 'NEARBY' | 'USERNAME' | 'LINK' | 'CONTACT' | 'BLUETOOTH';

  @IsOptional()
  @IsString()
  greeting?: string;
}

export class RespondChatRequestDto {
  @IsBoolean()
  accept!: boolean;
}
