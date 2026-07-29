import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CreateEmployeeDto {
  @IsString() email!: string;
  @IsString() name!: string;
  @IsString() @Length(8, 128) password!: string;
  @IsIn(['SUPPORT', 'MODERATOR', 'ADMIN', 'OPS']) role!: 'SUPPORT' | 'MODERATOR' | 'ADMIN' | 'OPS';
}

export class CrashReportDto {
  @IsIn(['ios', 'android', 'web']) platform!: 'ios' | 'android' | 'web';
  @IsString() message!: string;
  @IsString() signature!: string;
  @IsOptional() @IsString() appVersion?: string;
  @IsOptional() @IsString() stackTrace?: string;
}

export class InstallEventDto {
  @IsIn(['install', 'uninstall', 'first_open']) kind!: 'install' | 'uninstall' | 'first_open';
  @IsIn(['ios', 'android', 'web']) platform!: 'ios' | 'android' | 'web';
  @IsOptional() @IsString() city?: string;
}
