import { IsIn, IsOptional, IsString } from 'class-validator';

export class FileReportDto {
  @IsString() reportedUserId!: string;
  @IsIn(['HARASSMENT', 'SPAM', 'CSAM', 'IMPERSONATION', 'OTHER']) reason!:
    | 'HARASSMENT'
    | 'SPAM'
    | 'CSAM'
    | 'IMPERSONATION'
    | 'OTHER';
  @IsString() reportedContent!: string;
  @IsOptional() @IsString() contextNote?: string;
}

export class ResolveReportDto {
  @IsIn(['ACTIONED', 'DISMISSED']) resolution!: 'ACTIONED' | 'DISMISSED';
}

export class BlockDto {
  @IsString() userId!: string;
}
