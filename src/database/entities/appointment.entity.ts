import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../common/entity/base-entity';
import { AppointmentStatus } from '../../common/enums';

@Entity('appointments')
export class Appointment extends BaseEntity {
  @Column()
  clientId: string;

  @Column()
  barberId: string;

  @Column()
  branchId: string;

  @Column()
  companyId: string;

  /** JSON array of service UUIDs */
  @Column({ type: 'json', default: '[]' })
  serviceIds: string[];

  @Column({ type: 'date' })
  date: string;

  @Column()
  startTime: string;

  @Column()
  endTime: string;

  @Column({
    type: 'enum',
    enum: AppointmentStatus,
    default: AppointmentStatus.CONFIRMADO,
  })
  status: AppointmentStatus;

  @Column({ default: 0 })
  totalPrice: number;

  @Column({ default: 0 })
  totalDuration: number;

  @Column({ nullable: true, type: 'text' })
  notes: string;

  /** JSON map: serviceId -> barberId */
  @Column({ type: 'json', nullable: true })
  serviceBarberIds: Record<string, string>;

  @Column({ nullable: true })
  couponId: string;

  @Column({ nullable: true })
  couponCode: string;

  @Column({ default: 0 })
  discountAmount: number;
}
