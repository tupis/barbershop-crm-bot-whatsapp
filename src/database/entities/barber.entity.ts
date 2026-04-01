import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../common/entity/base-entity';

@Entity('barbers')
export class Barber extends BaseEntity {
  @Column()
  userId: string;

  @Column()
  branchId: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  avatarUrl: string;

  @Column({ nullable: true })
  email: string;

  @Column({ nullable: true })
  phone: string;

  @Column({ nullable: true, type: 'text' })
  bio: string;

  @Column({ type: 'json', default: '[]' })
  specialties: string[];

  @Column({ type: 'json', default: '[]' })
  categoryIds: string[];

  @Column({ type: 'json', default: '[]' })
  workingHours: any[];

  @Column({ default: true })
  isActive: boolean;

  /** JSON array of service UUIDs this barber can perform */
  @Column({ type: 'json', default: '[]' })
  serviceIds: string[];
}
