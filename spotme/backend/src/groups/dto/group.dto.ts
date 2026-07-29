import { ArrayMinSize, IsArray, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateGroupDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) memberIds!: string[];
}

export class AddGroupMemberDto {
  @IsString() userId!: string;
}
