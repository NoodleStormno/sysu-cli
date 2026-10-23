import { invalidArgument } from './errors.js';

/**
 * Parse argv against an option spec:
 *   { week: { type: 'integer', min: 1 }, raw: { type: 'boolean' }, term: { type: 'string' } }
 * Supports `--name value`, `--name=value` and boolean flags.
 */
export function parseArgs(argv, spec = {}, { positionals: maxPositionals = 0 } = {}) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const key = camel(name);
    const definition = spec[key];
    if (!definition) {
      throw invalidArgument(`Unknown option --${name}.`, { supported: Object.keys(spec).map((item) => `--${kebab(item)}`) });
    }
    if (definition.type === 'boolean') {
      if (eq >= 0) throw invalidArgument(`--${name} does not take a value.`);
      options[key] = true;
      continue;
    }
    let value;
    if (eq >= 0) {
      value = arg.slice(eq + 1);
    } else {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw invalidArgument(`--${name} requires a value.`);
      }
      index += 1;
    }
    options[key] = coerce(name, value, definition);
  }

  if (positionals.length > maxPositionals) {
    throw invalidArgument(`Unexpected argument: ${positionals[maxPositionals]}`);
  }
  return { options, positionals };
}

function coerce(name, value, definition) {
  if (definition.type === 'integer') {
    const number = Number(value);
    if (!Number.isInteger(number)) throw invalidArgument(`--${name} must be an integer.`);
    if (definition.min !== undefined && number < definition.min) throw invalidArgument(`--${name} must be >= ${definition.min}.`);
    if (definition.max !== undefined && number > definition.max) throw invalidArgument(`--${name} must be <= ${definition.max}.`);
    if (definition.choices && !definition.choices.includes(number)) {
      throw invalidArgument(`--${name} must be one of: ${definition.choices.join(', ')}.`);
    }
    return number;
  }
  if (definition.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalidArgument(`--${name} must be YYYY-MM-DD.`);
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      throw invalidArgument(`--${name} is not a valid date.`);
    }
    return date;
  }
  if (definition.choices && !definition.choices.includes(value)) {
    throw invalidArgument(`--${name} must be one of: ${definition.choices.join(', ')}.`);
  }
  return value;
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

export function kebab(name) {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}
