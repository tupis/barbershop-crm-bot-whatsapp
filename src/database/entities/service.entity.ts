import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../common/entity/base-entity';

@Entity('services')
export class Service extends BaseEntity {
  @Column()
  branchId: string;

  @Column()
  categoryId: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column()
  price: number;

  @Column()
  duration: number; // minutes

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: 0 })
  order: number;
}
