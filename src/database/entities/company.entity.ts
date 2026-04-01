import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../common/entity/base-entity';

@Entity('companies')
export class Company extends BaseEntity {
  @Column()
  name: string;

  @Column({ unique: true })
  slug: string;

  @Column()
  phone: string;

  @Column()
  email: string;

  @Column({ nullable: true })
  address: string;

  @Column({ nullable: true })
  logoUrl: string;

  @Column({ type: 'json', default: '[]' })
  workingHours: any[];

  @Column({ default: 60 })
  minAdvanceTime: number;

  @Column({ default: 30 })
  maxAdvanceTime: number;

  @Column({ default: 30 })
  slotDuration: number;

  @Column({ default: false })
  enableMultiBarber: boolean;
}
