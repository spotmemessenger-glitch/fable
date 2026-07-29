import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() avatarUrl?: string;
  @IsOptional() @IsString() publicKey?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() area?: string;
  @IsOptional() @IsInt() @Min(13) @Max(120) age?: number;
  @IsOptional() @IsIn(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']) sex?: 'MALE' | 'FEMALE' | 'OTHER' | 'UNSPECIFIED';
}

export class UpdatePresenceDto {
  @IsOptional() lat?: number | null;
  @IsOptional() lon?: number | null;
  @IsOptional() ghost?: boolean;
}
