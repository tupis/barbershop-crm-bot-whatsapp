import { Logger, UnauthorizedException } from '@nestjs/common';
import { BotApiKeyGuard } from './guards/bot-api-key.guard';

const contextWith = (headers: Record<string, string>) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as any;

describe('BotApiKeyGuard', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts the matching key and rejects anything else', () => {
    const guard = new BotApiKeyGuard({ get: () => 'segredo' } as any);
    expect(guard.canActivate(contextWith({ 'x-bot-api-key': 'segredo' }))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(contextWith({ 'x-bot-api-key': 'outro' })),
    ).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(contextWith({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('stays open without a configured key, warning only once', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const guard = new BotApiKeyGuard({ get: () => undefined } as any);
    expect(guard.canActivate(contextWith({}))).toBe(true);
    expect(guard.canActivate(contextWith({}))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
