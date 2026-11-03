import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

/**
 * One local HTTP server standing in for everything the bot talks to:
 *  - the tenant resolver and the barbershop backend (same routes, same shapes)
 *  - the Evolution API, whose outgoing messages are recorded for assertions
 *
 * Unknown routes answer 404, like the real backend.
 */
export interface SentMessage {
  instance: string;
  number: string;
  text: string;
}

export interface FakeWorld {
  company: any;
  branches: any[];
  services: any[];
  barbers: any[];
  /** barberId -> date -> times still free */
  slots: Record<string, Record<string, string[]>>;
  users: any[];
  appointments: any[];
  customerUpdates: { id: string; body: any }[];
  /** Answers of POST /cliente/coupons/validate by code; unset -> 404. */
  coupons?: Record<string, { valid: boolean; reason?: string; coupon?: any }>;
  failAppointments?: boolean;
}

export interface FakeServices {
  url: string;
  world: FakeWorld;
  sent: SentMessage[];
  requests: { method: string; path: string; tenant?: string }[];
  /** Texts sent to one phone, oldest first. */
  textsTo: (number: string) => string[];
  lastTextTo: (number: string) => string;
  reset: (world?: Partial<FakeWorld>) => void;
  close: () => Promise<void>;
}

export function defaultWorld(): FakeWorld {
  return {
    company: { id: 'co-1', name: 'Barbearia Teste', workingHours: [] },
    branches: [
      { id: 'br-1', name: 'Centro', isActive: true, workingHours: [] },
    ],
    services: [
      { id: 'sv-corte', name: 'Corte', price: 5000 },
      { id: 'sv-barba', name: 'Barba', price: 3000 },
    ],
    barbers: [
      {
        id: 'b-1',
        name: 'Joao',
        serviceIds: ['sv-corte', 'sv-barba'],
        workingHours: [],
      },
    ],
    slots: {},
    users: [],
    appointments: [],
    customerUpdates: [],
  };
}

const readBody = (req: IncomingMessage) =>
  new Promise<any>((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });

export async function startFakeServices(): Promise<FakeServices> {
  let world = defaultWorld();
  const sent: SentMessage[] = [];
  const requests: FakeServices['requests'] = [];
  let msgSeq = 0;
  let base = '';

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', base);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const body = method === 'GET' ? {} : await readBody(req);
    requests.push({
      method,
      path,
      tenant: req.headers['x-tenant-slug'] as string,
    });

    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const ok = (data: unknown) => json(200, data);
    let m: RegExpMatchArray | null;

    // ---- Evolution API
    if ((m = path.match(/^\/message\/send(Text|List|Buttons)\/(.+)$/))) {
      sent.push({
        instance: m[2],
        number: body.number,
        text: body.text ?? body.title,
      });
      return ok({ key: { id: `msg-${++msgSeq}` } });
    }

    // ---- Resolver + backend
    if ((m = path.match(/^\/api\/v1\/resolve\/instance\/(.+)$/))) {
      return ok({ url_api: base, slug_company: m[1] });
    }
    if (path.startsWith('/company/by-slug/')) return ok(world.company);
    if (path === '/branches') return ok(world.branches);
    if (path === '/cliente/services') return ok(world.services);
    if (path === '/cliente/barbers') return ok(world.barbers);
    if ((m = path.match(/^\/cliente\/barbers\/(.+)\/slots$/))) {
      const date = url.searchParams.get('date') ?? '';
      const times = world.slots[m[1]]?.[date] ?? ['09:00', '10:00'];
      return ok(times.map((time) => ({ time, available: true })));
    }
    if (path === '/cliente/users/find-or-create') {
      let user = world.users.find((u) => u.phone === body.phone);
      if (!user) {
        user = {
          id: `user-${world.users.length + 1}`,
          phone: body.phone,
          name: body.name,
        };
        world.users.push(user);
      }
      return ok(user);
    }
    if ((m = path.match(/^\/cliente\/customer\/(.+)$/)) && method === 'PATCH') {
      world.customerUpdates.push({ id: m[1], body });
      return ok({ id: m[1], ...body });
    }
    if (path === '/cliente/appointments' && method === 'POST') {
      if (world.failAppointments) return json(409, { message: 'conflito' });
      world.appointments.push(body);
      const free = world.slots[body.barberId]?.[body.date];
      if (free)
        world.slots[body.barberId][body.date] = free.filter(
          (t) => t !== body.time,
        );
      return json(201, { id: `apt-${world.appointments.length}` });
    }
    if (path === '/cliente/coupons/validate' && world.coupons) {
      return ok(
        world.coupons[body.code] ?? {
          valid: false,
          reason: 'Cupom inválido ou expirado.',
        },
      );
    }

    json(404, { message: `Cannot ${method} ${path}` });
  };

  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const textsTo = (number: string) =>
    sent.filter((s) => s.number === number).map((s) => s.text);

  return {
    url: base,
    get world() {
      return world;
    },
    sent,
    requests,
    textsTo,
    lastTextTo: (number) => textsTo(number).at(-1) ?? '',
    reset: (overrides = {}) => {
      world = { ...defaultWorld(), ...overrides };
      sent.length = 0;
      requests.length = 0;
      msgSeq = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Evolution `messages.upsert` webhook payload for an incoming text. */
export function incoming(
  instance: string,
  phone: string,
  text: string,
  extra: any = {},
) {
  return {
    event: 'messages.upsert',
    instance,
    data: {
      key: {
        remoteJid: `${phone}@s.whatsapp.net`,
        id: `in-${Math.random()}`,
        fromMe: false,
        ...extra.key,
      },
      message: { conversation: text, ...extra.message },
    },
  };
}

/** Number of the menu line whose label contains `label`. */
export function optionNumber(menu: string, label: string): string {
  const line = menu
    .split('\n')
    .find((l) => /^\d+\. /.test(l) && l.includes(label));
  if (!line) throw new Error(`Option "${label}" not found in menu:\n${menu}`);
  return line.split('.')[0];
}
