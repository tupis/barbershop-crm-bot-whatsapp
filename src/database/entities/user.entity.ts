import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../common/entity/base-entity';
import { UserRole } from '../../common/enums';

@Entity('users')
export class User extends BaseEntity {
  @Column({ nullable: true })
  companyId: string;

  @Column()
  name: string;

  @Column({ unique: true, nullable: true })
  email: string;

  @Column({ unique: true })
  phone: string;

  @Column({ nullable: true })
  passwordHash: string;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.USER,
  })
  role: UserRole;

  @Column({ nullable: true })
  avatarUrl: string;

  @Column({ default: true })
  isActive: boolean;
}
