// Reads OPENROUTER_API_KEY from the environment, ./.env, or ~/.jev/.env (first hit wins).
import fs from 'node:fs';
import path from 'node:path';
import { JEV_HOME } from './store.js';

export const HOME_ENV = path.join(JEV_HOME, '.env');

function parse(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[line.slice(0, eq).trim()] = val;
  }
  return out;
}

export function loadEnv() {
  for (const file of [path.resolve(process.cwd(), '.env'), HOME_ENV]) {
    for (const [k, v] of Object.entries(parse(file))) if (process.env[k] === undefined) process.env[k] = v;
  }
}

export function saveEnvValue(key, value, file = HOME_ENV) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  const idx = lines.findIndex((l) => l.trim().startsWith(key + '='));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  fs.writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  process.env[key] = value;
}
