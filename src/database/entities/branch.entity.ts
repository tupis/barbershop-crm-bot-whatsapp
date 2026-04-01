import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../common/entity/base-entity';

@Entity('branches')
export class Branch extends BaseEntity {
  @Column()
  companyId: string;

  @Column()
  name: string;

  @Column({ unique: true })
  slug: string;

  @Column({ nullable: true })
  address: string;

  @Column({ nullable: true })
  phone: string;

  @Column({ nullable: true })
  email: string;

  @Column({ nullable: true })
  logoUrl: string;

  @Column({ default: true })
  isActive: boolean;

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
