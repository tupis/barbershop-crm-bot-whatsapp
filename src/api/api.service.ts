import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class ApiService {
  private readonly logger = new Logger(ApiService.name);
  private readonly routerUrl: string;
  private readonly tenantApiCache: Map<string, string> = new Map();

  constructor(private configService: ConfigService) {
    this.routerUrl = this.configService.get<string>('ROUTER_API_URL') || 'http://localhost:5700';
  }

  private async getApiUrl(tenantSlug: string): Promise<string> {
    if (this.tenantApiCache.has(tenantSlug)) {
      return this.tenantApiCache.get(tenantSlug) as string;
    }
    try {
      const response = await axios.get(`${this.routerUrl}/api/resolve/instance/${tenantSlug}`);
      const api = response.data.url_api;
      this.tenantApiCache.set(tenantSlug, api);
      return api;
    } catch (e) {
      this.logger.error(`Failed to resolve api url for tenant ${tenantSlug}`);
      return this.configService.get<string>('BACKEND_API_URL') || 'http://localhost:5500';
    }
  }

  async getCompanyBySlug(tenantSlug: string, slug: string) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.get(
        `${apiUrl}/company/by-slug/${slug}`,
        { headers: { 'x-tenant-slug': tenantSlug } }
      );
      return data;
    } catch (error) {
      this.logger.error(`Error fetching company: ${error.message}`);
      return null;
    }
  }

  async getBranches(tenantSlug: string) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.get(`${apiUrl}/branches`, {
        headers: { 'x-tenant-slug': tenantSlug }
      });
      return (data || []).filter((b: any) => b.isActive);
    } catch (error) {
      this.logger.error(`Error fetching branches: ${error.message}`);
      return [];
    }
  }

  async getServices(tenantSlug: string, branchId: string) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.get(`${apiUrl}/cliente/services`, {
        params: { branchId },
        headers: { 'x-tenant-slug': tenantSlug }
      });
      return data || [];
    } catch (error) {
      this.logger.error(`Error fetching services: ${error.message}`);
      return [];
    }
  }

  async getBarbers(tenantSlug: string, branchId: string) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.get(`${apiUrl}/cliente/barbers`, {
        params: { branchId },
        headers: { 'x-tenant-slug': tenantSlug }
      });
      return data || [];
    } catch (error) {
      this.logger.error(`Error fetching barbers: ${error.message}`);
      return [];
    }
  }

  async getAvailableSlots(tenantSlug: string, barberId: string, date: string) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.get(
        `${apiUrl}/cliente/barbers/${barberId}/slots`,
        {
          params: { date },
          headers: { 'x-tenant-slug': tenantSlug }
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

  async findOrCreateUser(tenantSlug: string, phone: string, name: string) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.post(
        `${apiUrl}/cliente/users/find-or-create`,
        {
          phone,
          name,
        },
        { headers: { 'x-tenant-slug': tenantSlug } }
      );
      return data;
    } catch (error) {
      this.logger.error(`Error finding/creating user: ${error.message}`);
      return null;
    }
  }

  async createAppointment(tenantSlug: string, payload: any) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.post(
        `${apiUrl}/cliente/appointments`,
        payload,
        { headers: { 'x-tenant-slug': tenantSlug } }
      );
      return data;
    } catch (error) {
      this.logger.error(`Error creating appointment: ${error.message}`);
      throw error;
    }
  }
}
