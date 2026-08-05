import { IsString, Matches } from 'class-validator';
import { BIRTH_YEAR_MONTH_RE } from '../../policy/age';

/** Wave 1B, B2 — the one-time age declaration payload. Year-month only, never a full DOB. */
export class DeclareAgeDto {
  @IsString()
  @Matches(BIRTH_YEAR_MONTH_RE)
  birthYearMonth!: string;
}
