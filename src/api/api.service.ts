import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class ApiService {
  private readonly logger = new Logger(ApiService.name);
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
      this.logger.error(`Failed to resolve api url for tenant ${tenantSlug}`);
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
      this.logger.error(`Error fetching company: ${error.message}`);
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
      this.logger.error(`Error fetching branches: ${error.message}`);
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
      this.logger.error(`Error fetching services: ${error.message}`);
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
          headers: { 'x-tenant-slug': tenantSlug },
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
        { headers: { 'x-tenant-slug': tenantSlug } },
      );
      return data;
    } catch (error) {
      this.logger.error(`Error finding/creating user: ${error.message}`);
      return null;
    }
  }

  /**
   * The pricing engine. Resolves membership benefits, quota, cadence, overage
   * and coupon in one call — the bot never does this maths itself, so the
   * WhatsApp price can't drift from the website's.
   */
  async quote(
    tenantSlug: string,
    payload: {
      clientId?: string;
      branchId: string;
      serviceIds: string[];
      date?: string;
      couponCode?: string;
    },
  ): Promise<any | null> {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.post(`${apiUrl}/cliente/quote`, payload, {
        headers: { 'x-tenant-slug': tenantSlug },
      });
      return data;
    } catch (error) {
      this.logger.error(`Error quoting cart: ${error.message}`);
      return null;
    }
  }

  /** Active subscription and remaining balance for a customer. */
  async getMyMembership(
    tenantSlug: string,
    clientId: string,
    branchId: string,
  ): Promise<any | null> {
    try {
      const apiUrl = await this.getApiUrl(tenantSlug);
      const { data } = await axios.get(`${apiUrl}/cliente/memberships/mine`, {
        params: { clientId, branchId },
        headers: { 'x-tenant-slug': tenantSlug },
      });
      return data;
    } catch (error) {
      this.logger.error(`Error fetching membership: ${error.message}`);
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
      this.logger.error(`Error validating coupon: ${error.message}`);
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
      this.logger.error(`Error creating appointment: ${error.message}`);
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
      this.logger.error(`Error updating customer: ${error.message}`);
      return null;
    }
  }
}
