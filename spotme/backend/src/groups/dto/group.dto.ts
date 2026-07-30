import { GroupRole, GroupVisibility } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** Hard ceiling so one request cannot try to seed a group with 10k rows. */
const MAX_MEMBERS = 512;

export class CreateGroupDto {
  // The client mints the room id (and its secret) — the server never derives
  // one, exactly as with DM rooms.
  @IsString()
  @Matches(/^[a-f0-9]{16,128}$/i, { message: 'roomId must be 16-128 hex characters' })
  roomId!: string;

  @IsString()
  @Length(1, 40)
  name!: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(2, { message: 'select at least 2 members' })
  @ArrayMaxSize(MAX_MEMBERS)
  memberIds!: string[];

  @IsOptional() @IsString() avatarUrl?: string;

  @IsOptional() @IsEnum(GroupVisibility) visibility?: GroupVisibility;

  @IsOptional()
  @Matches(/^[a-z0-9_]{3,16}$/, { message: 'username must be 3-16 chars: a-z 0-9 _' })
  username?: string;

  // PUBLIC groups only. The service refuses to persist this for PRIVATE ones.
  @IsOptional() @IsString() @Length(1, 512) secretKey?: string;

  @IsOptional() @IsBoolean() membersCanAdd?: boolean;
  @IsOptional() @IsBoolean() membersCanMessage?: boolean;
  @IsOptional() @IsBoolean() membersCanMedia?: boolean;
}

export class UpdateGroupDto {
  @IsOptional() @IsString() @Length(1, 40) name?: string;
  @IsOptional() @IsString() avatarUrl?: string | null;
  @IsOptional() @IsEnum(GroupVisibility) visibility?: GroupVisibility;

  @IsOptional()
  @Matches(/^[a-z0-9_]{3,16}$/, { message: 'username must be 3-16 chars: a-z 0-9 _' })
  username?: string;

  @IsOptional() @IsString() @Length(1, 512) secretKey?: string;
  @IsOptional() @IsBoolean() membersCanAdd?: boolean;
  @IsOptional() @IsBoolean() membersCanMessage?: boolean;
  @IsOptional() @IsBoolean() membersCanMedia?: boolean;
}

export class AddGroupMemberDto {
  @IsString() userId!: string;
}

export class SetRoleDto {
  // OWNER is rejected by the service — ownership moves via transfer only.
  @IsEnum(GroupRole) role!: GroupRole;
}

export class SetGrantsDto {
  @IsOptional() @IsBoolean() canAddAdmin?: boolean;
  @IsOptional() @IsBoolean() canBan?: boolean;
  @IsOptional() @IsBoolean() canMute?: boolean;
  @IsOptional() @IsBoolean() canRemove?: boolean;
  @IsOptional() @IsBoolean() canDeleteMessages?: boolean;
  @IsOptional() @IsBoolean() canControlInvites?: boolean;
}

export class SetBanDto {
  @IsBoolean() banned!: boolean;
}

export class SetMuteDto {
  /** null/omitted unmutes. Capped at a year by the service. */
  @IsOptional() @IsInt() @Min(1) @Max(60 * 24 * 365) minutes?: number | null;
}
