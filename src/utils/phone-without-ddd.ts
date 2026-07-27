export function phoneWithoutDDD(number: string): string {
  if (!number) return '';

  const digits = number.replace(/\D/g, '');

  let withoutCountry = digits;
  if (digits.startsWith('55') && digits.length >= 12) {
    withoutCountry = digits.slice(2);
  }

  if (withoutCountry.length === 10) {
    return `${withoutCountry.slice(0, 2)}9${withoutCountry.slice(2)}`;
  }

  return withoutCountry;
}
