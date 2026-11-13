/**
 * Checks done in the browser before a form is sent.
 *
 * They exist for the person filling in the form: an immediate, specific message
 * next to the field, with no round trip to the server. They are not a security
 * boundary. The API validates everything again, because anyone can call it
 * without this page.
 */

export type Errors<K extends string> = Partial<Record<K, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EVENT_TYPE = /^[A-Za-z0-9_.-]{1,200}$/;

export function requiredText(value: string, what: string): string | undefined {
  return value.trim() ? undefined : `Enter ${what}.`;
}

export function emailAddress(value: string): string | undefined {
  if (!value.trim()) return "Enter your email address.";
  return EMAIL.test(value.trim()) ? undefined : "Enter a valid email address, like name@example.com.";
}

export function newPassword(value: string): string | undefined {
  if (!value) return "Choose a password.";
  if (value.length < 10) return "Use at least 10 characters.";
  if (value.length > 128) return "Use at most 128 characters.";
  return undefined;
}

export function webhookUrl(value: string): string | undefined {
  const url = value.trim();
  if (!url) return "Enter the URL that should receive your events.";
  if (!/^https?:\/\//i.test(url)) return "The URL must start with https:// (or http://).";
  try {
    new URL(url);
  } catch {
    return "This is not a valid URL.";
  }
  return undefined;
}

export function eventTypes(types: string[]): string | undefined {
  const bad = types.find((type) => !EVENT_TYPE.test(type));
  if (bad) {
    return `"${bad}" is not a valid event type. Use letters, numbers, dots, dashes and underscores.`;
  }
  return types.length > 100 ? "Use at most 100 event types." : undefined;
}

export function optionalRateLimit(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const number = Number(text);
  if (!Number.isInteger(number) || number < 1) return "Enter a whole number of 1 or more, or leave it empty.";
  return number > 10_000 ? "Use 10,000 or less." : undefined;
}

/** Drop the entries that are undefined, so "no errors" is an empty object. */
export function collect<K extends string>(errors: Record<K, string | undefined>): Errors<K> {
  const result: Errors<K> = {};
  for (const key of Object.keys(errors) as K[]) {
    if (errors[key]) result[key] = errors[key];
  }
  return result;
}

export function hasErrors(errors: object): boolean {
  return Object.keys(errors).length > 0;
}
