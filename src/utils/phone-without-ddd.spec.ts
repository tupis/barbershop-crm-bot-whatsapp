import { phoneWithoutDDD } from './phone-without-ddd';

describe('phoneWithoutDDD', () => {
  it('should remove country code 55 and add 9 after DDD when receiving a 12-digit number (55 + 2 DDD + 8 phone)', () => {
    expect(phoneWithoutDDD('559891739443')).toBe('98991739443');
  });

  it('should remove country code 55 and keep 9 if the 13-digit number already has 9 after DDD', () => {
    expect(phoneWithoutDDD('5598991739443')).toBe('98991739443');
  });

  it('should handle formatted input strings', () => {
    expect(phoneWithoutDDD('55 98 9173-9443')).toBe('98991739443');
    expect(phoneWithoutDDD('+55 (98) 99173-9443')).toBe('98991739443');
  });

  it('should add 9 after DDD when receiving a 10-digit number without country code', () => {
    expect(phoneWithoutDDD('9891739443')).toBe('98991739443');
  });

  it('should keep an 11-digit number without country code as is', () => {
    expect(phoneWithoutDDD('98991739443')).toBe('98991739443');
  });

  it('should return empty string if input is empty', () => {
    expect(phoneWithoutDDD('')).toBe('');
  });
});
