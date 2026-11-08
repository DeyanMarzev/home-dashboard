/**
 * Redaction for the capture tools (bright-capture, router-capture), whose output becomes
 * parser fixtures in a public repo. Errs on the side of removing too much: personal fields
 * go whatever their value (a nested `address` object included), ids become stable
 * placeholders (so which id is which survives), and personal-looking values are caught
 * wherever they appear.
 */

/** Keys whose whole value is personal, at any depth and of any type. */
const PERSONAL_KEY =
  /address|postcode|postal|email|phone|mpan|mprn|serial|attributes|latitude|longitude/i;
const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i;
const EMAIL = /[^@\s]+@[^@\s]+\.[a-z]{2,}/i;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/i;

/** `id`, `_id`, `shid`, and camelCase ids such as `resourceId`, `ownerId`, `deviceID`. */
const isIdKey = (key: string) =>
  key === 'id' || key === '_id' || key === 'shid' || /[a-z]I[dD]$/.test(key);

export interface RedactOptions {
  /** Keys holding names people gave things (device names): replaced with "<label> N". */
  nameKeys?: string[];
  nameLabel?: string;
}

/** A JSON.stringify replacer that redacts as described above. One per capture. */
export function redactor(options: RedactOptions = {}): (key: string, value: unknown) => unknown {
  const ids = new Map<string, string>();
  const names = new Map<string, string>();
  let macs = 0;
  return (key, value) => {
    if (key !== '' && PERSONAL_KEY.test(key)) return 'REDACTED';
    if (typeof value !== 'string') return value;
    if (isIdKey(key)) {
      if (!ids.has(value)) ids.set(value, `REDACTED-${key}-${ids.size + 1}`);
      return ids.get(value);
    }
    if (options.nameKeys?.includes(key)) {
      if (!names.has(value)) names.set(value, `${options.nameLabel ?? 'name'} ${names.size + 1}`);
      return names.get(value);
    }
    if (MAC.test(value)) return `00:00:00:00:00:${(++macs % 256).toString(16).padStart(2, '0')}`;
    if (IPV4.test(value)) return '192.168.1.x';
    if (IPV6.test(value) && value.includes(':')) return 'fd00::x';
    if (EMAIL.test(value) || UK_POSTCODE.test(value)) return 'REDACTED';
    return value;
  };
}
