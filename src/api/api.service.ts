import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class ApiService {
  private readonly logger = new Logger(ApiService.name);
  private readonly apiUrl: string;

  constructor(private configService: ConfigService) {
    this.apiUrl = this.configService.get<string>('BACKEND_API_URL') || '';
  }

  async getCompanyBySlug(slug: string) {
    try {
      const { data } = await axios.get(
        `${this.apiUrl}/company/by-slug/${slug}`,
      );
      return data;
    } catch (error) {
      this.logger.error(`Error fetching company: ${error.message}`);
      return null;
    }
  }

  async getBranches() {
    try {
      const { data } = await axios.get(`${this.apiUrl}/branches`);
      return (data || []).filter((b: any) => b.isActive);
    } catch (error) {
      this.logger.error(`Error fetching branches: ${error.message}`);
      return [];
    }
  }

  async getServices(branchId: string) {
    try {
      const { data } = await axios.get(`${this.apiUrl}/cliente/services`, {
        params: { branchId },
      });
      return data || [];
    } catch (error) {
      this.logger.error(`Error fetching services: ${error.message}`);
      return [];
    }
  }

  async getBarbers(branchId: string) {
    try {
      const { data } = await axios.get(`${this.apiUrl}/cliente/barbers`, {
        params: { branchId },
      });
      return data || [];
    } catch (error) {
      this.logger.error(`Error fetching barbers: ${error.message}`);
      return [];
    }
  }

  async getAvailableSlots(barberId: string, date: string) {
    try {
      const { data } = await axios.get(
        `${this.apiUrl}/cliente/barbers/${barberId}/slots`,
        {
          params: { date },
        },
      );
      return (data || [])
        .filter((slot: any) => slot.available)
        .map((s: any) => s.time);
    } catch (error) {
      this.logger.error(`Error fetching available slots: ${error.message}`);
      return [];
    }
  }

  async findOrCreateUser(phone: string, name: string) {
    try {
      const { data } = await axios.post(
        `${this.apiUrl}/cliente/users/find-or-create`,
        {
          phone,
          name,
        },
      );
      return data;
    } catch (error) {
      this.logger.error(`Error finding/creating user: ${error.message}`);
      return null;
    }
  }

  async createAppointment(payload: any) {
    try {
      const { data } = await axios.post(
        `${this.apiUrl}/cliente/appointments`,
        payload,
      );
      return data;
    } catch (error) {
      this.logger.error(`Error creating appointment: ${error.message}`);
      throw error;
    }
  }
}
