import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../common/entity/base-entity';

@Entity('service_categories')
export class ServiceCategory extends BaseEntity {
  @Column()
  branchId: string;

  @Column()
  name: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: 0 })
  order: number;
}
