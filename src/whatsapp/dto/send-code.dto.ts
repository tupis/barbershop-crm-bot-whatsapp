import { IsNotEmpty, IsString } from 'class-validator';

export class SendCodeDto {
  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsNotEmpty()
  instance: string;
}
