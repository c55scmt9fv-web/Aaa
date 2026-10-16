import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('data/accounts.json');

export function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function saveAccounts(accounts) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}
