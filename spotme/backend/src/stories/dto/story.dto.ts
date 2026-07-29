import { IsIn, IsString, MaxLength } from 'class-validator';

export class CreateStoryDto {
  @IsIn(['text']) kind!: 'text'; // 'photo' arrives once the R2 upload pipeline is wired
  @IsString() @MaxLength(500) textContent!: string;
}
