import fs from 'node:fs';

/** A settings.json that cannot be parsed must never be overwritten. */
export class SettingsParseError extends Error {
  constructor(file, cause) {
    super(
      `${file} is not valid JSON (${cause}). Refusing to write: fix or remove it first, ` +
        'nothing was changed.',
    );
    this.name = 'SettingsParseError';
    this.file = file;
  }
}

/** Raw bytes, or null when the file does not exist. */
export function readSettingsRaw(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function parseSettings(raw, file) {
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new SettingsParseError(file, error.message);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new SettingsParseError(file, 'expected a JSON object at the top level');
  }
  return data;
}

/** { exists, raw: Buffer|null, data: object|null } — throws SettingsParseError. */
export function loadSettings(file) {
  const raw = readSettingsRaw(file);
  if (raw === null) return { exists: false, raw: null, data: null };
  return { exists: true, raw, data: parseSettings(raw, file) };
}

/**
 * The keys install owns. Everything else in the file is preserved untouched.
 * `enabledModels` is only offered when the list is absent or empty.
 */
export function desiredSettings(data, { provider, model, enabledModelGlob = `${provider}/*` }) {
  const current = data ?? {};
  const desired = { defaultProvider: provider, defaultModel: model };
  const models = current.enabledModels;
  if (!Array.isArray(models) || models.length === 0) {
    desired.enabledModels = [enabledModelGlob];
  }
  return desired;
}

/**
 * Merge without reordering or dropping a single existing key: existing keys keep
 * their position, new keys are appended.
 */
export function mergeSettings(current, desired) {
  const merged = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(desired)) {
    merged[key] = value;
  }
  return merged;
}

/** Two-space JSON with a trailing newline — the one formatting install writes. */
export function renderSettings(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Prior values of the keys install touched, for the journal and for doctor. */
export function captureBefore(data, desired) {
  const before = {};
  for (const key of Object.keys(desired)) {
    if (data && Object.prototype.hasOwnProperty.call(data, key)) {
      before[key] = data[key];
    }
  }
  return before;
}

/** True when the settings already point at the requested provider/model. */
export function settingsMismatch(data, { provider, model }) {
  const mismatches = [];
  if (data.defaultProvider !== provider) {
    mismatches.push(`defaultProvider is ${JSON.stringify(data.defaultProvider ?? null)}, expected ${JSON.stringify(provider)}`);
  }
  if (data.defaultModel !== model) {
    mismatches.push(`defaultModel is ${JSON.stringify(data.defaultModel ?? null)}, expected ${JSON.stringify(model)}`);
  }
  return mismatches;
}
