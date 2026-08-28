import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Structured reminder data. The bot writes the message itself so this endpoint
 * can never be used to push arbitrary text through the WhatsApp instance.
 */
export class SendReminderDto {
  @IsString()
  @IsNotEmpty()
  instance: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  clientName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  companyName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  branchName: string;

  @IsString()
  @IsOptional()
  @MaxLength(240)
  branchAddress?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  barberName?: string | null;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  services?: string[];

  /** YYYY-MM-DD */
  @IsString()
  @IsNotEmpty()
  date: string;

  /** HH:MM */
  @IsString()
  @IsNotEmpty()
  startTime: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  leadTimeLabel: string;
}
