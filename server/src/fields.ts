// Structured fields: extra key-value data on an entry beyond time, level,
// thread, logger and message (e.g. tenant, status, pod). They come from
// provider records (`fields`), structured stream entries and JSON log lines.
//
// Values are stored as strings and filtered by exact match:
// criteria.fields = { status: ['500', '503'], tenant: ['acme'] } keeps entries
// whose status is 500 or 503 AND whose tenant is acme.

export const MAX_FIELDS_PER_ENTRY = 32;
export const MAX_FIELD_KEY_LENGTH = 64;
export const MAX_FIELD_VALUE_LENGTH = 256;

export type Fields = Record<string, string>;
export type FieldsCriteria = Record<string, string[]>;

function fieldValue(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  let s: string;
  if (v === null) s = 'null';
  else if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') s = String(v);
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      return undefined;
    }
  }
  return s.length > MAX_FIELD_VALUE_LENGTH ? s.slice(0, MAX_FIELD_VALUE_LENGTH - 1) + '…' : s;
}

// Normalizes arbitrary input into string fields, or undefined when empty.
// `skip` lists keys that are not fields (e.g. the ones mapped to the message).
export function normalizeFields(input: unknown, skip?: ReadonlySet<string>): Fields | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  let out: Fields | undefined;
  let n = 0;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (n >= MAX_FIELDS_PER_ENTRY) break;
    if (!key || key.length > MAX_FIELD_KEY_LENGTH || skip?.has(key)) continue;
    const value = fieldValue(raw);
    if (value === undefined) continue;
    (out ??= {})[key] = value;
    n++;
  }
  return out;
}

export function fieldsBytes(fields: Fields | undefined): number {
  if (!fields) return 0;
  let bytes = 0;
  for (const k in fields) bytes += 16 + k.length + fields[k].length;
  return bytes;
}

// Validates filter input: an object of key -> value or list of values.
export function fieldsCriteria(input: unknown): FieldsCriteria | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out: FieldsCriteria = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!key) continue;
    const values = (Array.isArray(raw) ? raw : [raw]).filter((v) => v !== undefined).map((v) => fieldValue(v) ?? '');
    if (values.length) out[key] = values;
  }
  return Object.keys(out).length ? out : undefined;
}

// A predicate over an entry's fields, or null when there is no field filter.
export function fieldsMatcher(criteria: FieldsCriteria | undefined): ((fields: Fields | undefined) => boolean) | null {
  if (!criteria) return null;
  const tests = Object.entries(criteria).map(([key, values]) => [key, new Set(values)] as const);
  if (!tests.length) return null;
  return (fields) => {
    if (!fields) return false;
    for (const [key, values] of tests) {
      const v = fields[key];
      if (v === undefined || !values.has(v)) return false;
    }
    return true;
  };
}
