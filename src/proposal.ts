export type Proposal = { key: string; value: string };
export function validateProposal(input: unknown): Proposal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid proposal');
  const own = Reflect.ownKeys(input);
  if (own.length !== 2 || !own.includes('key') || !own.includes('value')) throw Error('Invalid proposal');
  const keyField = Object.getOwnPropertyDescriptor(input, 'key');
  const valueField = Object.getOwnPropertyDescriptor(input, 'value');
  if (!keyField?.enumerable || !valueField?.enumerable ||
      !Object.hasOwn(keyField, 'value') || !Object.hasOwn(valueField, 'value')) throw Error('Invalid proposal');
  const { value: key } = keyField;
  const { value } = valueField;
  if (typeof key !== 'string' || !/^[a-z][a-z0-9_-]*\/[a-z0-9_-]{1,64}$/.test(key) ||
      typeof value !== 'string' || Buffer.byteLength(value) > 4096) throw Error('Invalid proposal');
  return { key, value };
}
