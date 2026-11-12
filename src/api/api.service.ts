import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { BotLogger } from '../common/logging/bot-logger';

@Injectable()
export class ApiService {
  private readonly log = new BotLogger(ApiService.name);
  private readonly routerUrl: string;
  private readonly tenantApiCache: Map<string, string> = new Map();

  constructor(private configService: ConfigService) {
    this.routerUrl =
      this.configService.get<string>('BACKEND_API_URL') ||
      'http://localhost:5700';
  }

  private async getApiUrl(tenantSlug: string): Promise<string> {
    if (this.tenantApiCache.has(tenantSlug)) {
      return this.tenantApiCache.get(tenantSlug) as string;
    }
    try {
      const response = await axios.get(
        `${this.routerUrl}/api/v1/resolve/instance/${tenantSlug}`,
      );
      const api = response.data.url_api;
      this.tenantApiCache.set(tenantSlug, api);
      return api;
    } catch (e) {
      this.log.error('api.resolve_tenant_failed', e, { tenantSlug });
      return (
        this.configService.get<string>('BACKEND_API_URL') ||
        'http://localhost:5500'
      );
    }
  }

  async getCompanyBySlug(tenantSlug: string, slug: string) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.get(`${apiUrl}/company/by-slug/${slug}`, {
        headers: { 'x-tenant-slug': tenantSlug },
      });
      return data;
    } catch (error) {
      this.log.error('api.fetching_company_failed', error);
      return null;
    }
  }

  async getBranches(tenantSlug: string) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.get(`${apiUrl}/branches`, {
        headers: { 'x-tenant-slug': tenantSlug },
      });
      return (data || []).filter((b: any) => b.isActive);
    } catch (error) {
      this.log.error('api.fetching_branches_failed', error);
      return [];
    }
  }

  async getServices(tenantSlug: string, branchId: string) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.get(`${apiUrl}/cliente/services`, {
        params: { branchId },
        headers: { 'x-tenant-slug': tenantSlug },
      });
      return data || [];
    } catch (error) {
      this.log.error('api.fetching_services_failed', error);
      return [];
    }
  }

  async getBarbers(tenantSlug: string, branchId: string) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.get(`${apiUrl}/cliente/barbers`, {
        params: { branchId },
        headers: { 'x-tenant-slug': tenantSlug },
      });
      return data || [];
    } catch (error) {
      this.log.error('api.fetching_barbers_failed', error);
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
          headers: { 'x-tenant-slug': tenantSlug },
        },
      );
      return (data || [])
        .filter((slot: any) => slot.available)
        .map((s: any) => s.time);
    } catch (error) {
      this.log.error('api.fetching_available_slots_failed', error);
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
        { headers: { 'x-tenant-slug': tenantSlug } },
      );
      return data;
    } catch (error) {
      this.log.error('api.finding_creating_user_failed', error);
      return null;
    }
  }

  /**
   * Coupon check for the booking flow. Uses the public client endpoint because
   * the bot holds no JWT.
   */
  async validateCoupon(
    tenantSlug: string,
    code: string,
    branchId: string,
    serviceIds: string[],
  ): Promise<{ valid: boolean; reason?: string; coupon?: any }> {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.post(
        `${apiUrl}/cliente/coupons/validate`,
        { code, branchId, serviceIds },
        { headers: { 'x-tenant-slug': tenantSlug } },
      );
      return data;
    } catch (error) {
      this.log.error('api.validating_coupon_failed', error);
      return {
        valid: false,
        reason: 'Nao foi possivel validar o cupom agora.',
      };
    }
  }

  async createAppointment(tenantSlug: string, payload: any) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.post(
        `${apiUrl}/cliente/appointments`,
        payload,
        { headers: { 'x-tenant-slug': tenantSlug } },
      );
      return data;
    } catch (error) {
      this.log.error('api.creating_appointment_failed', error);
      throw error;
    }
  }

  async updateCustomer(tenantSlug: string, customerId: string, payload: any) {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.patch(
        `${apiUrl}/cliente/customer/${customerId}`,
        payload,
        { headers: { 'x-tenant-slug': tenantSlug } },
      );
      return data;
    } catch (error) {
      this.log.error('api.updating_customer_failed', error);
      return null;
    }
  }
}
