import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { loadAccounts, saveAccounts } from './store.js';
import { refreshToken, validate, helix } from './twitch.js';

const CHANNEL = (process.env.CHANNEL || '').toLowerCase();

function parseTags(raw) {
  const tags = {};
  for (const kv of raw.split(';')) {
    const i = kv.indexOf('=');
    tags[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return tags;
}

class Connection {
  constructor(account, manager) {
    this.account = account;
    this.manager = manager;
    this.ws = null;
    this.status = 'offline'; // offline | connecting | online | error
    this.error = null;
    this.wanted = false;
    this.retry = 0;
    this.timer = null;
  }

  async connect() {
    this.wanted = true;
    clearTimeout(this.timer);
    this.#setStatus('connecting');
    try {
      await this.#ensureToken();
    } catch (e) {
      this.error = e.message;
      this.#setStatus('error');
      return;
    }
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;
    ws.on('open', () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send(`PASS oauth:${this.account.accessToken}`);
      ws.send(`NICK ${this.account.login}`);
      ws.send(`JOIN #${CHANNEL}`);
    });
    ws.on('message', (data) => {
      for (const line of data.toString().split('\r\n').filter(Boolean)) this.#onLine(line);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.wanted) return this.#setStatus('offline');
      this.#setStatus('connecting');
      this.timer = setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** this.retry++));
    });
    ws.on('error', (e) => {
      this.error = e.message;
    });
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.error = null;
    this.#setStatus('offline');
  }

  say(message) {
    if (this.status !== 'online') throw new Error('conta não está online');
    this.ws.send(`PRIVMSG #${CHANNEL} :${message}`);
  }

  async #ensureToken() {
    let ok = false;
    try {
      await validate(this.account.accessToken);
      ok = true;
    } catch {}
    if (ok) return;
    const t = await refreshToken(this.account.refreshToken);
    this.account.accessToken = t.access_token;
    this.account.refreshToken = t.refresh_token;
    this.manager.persist();
  }

  #onLine(line) {
    if (line.startsWith('PING')) return this.ws.send(line.replace('PING', 'PONG'));
    if (line.includes('Login authentication failed') || line.includes('Improperly formatted auth')) {
      this.error = 'autenticação falhou';
      this.wanted = false;
      this.#setStatus('error');
      this.ws?.close();
      return;
    }
    if (line.includes(` JOIN #${CHANNEL}`) && line.startsWith(`:${this.account.login}!`)) {
      this.retry = 0;
      this.error = null;
      this.#setStatus('online');
      return;
    }
    // Só a primeira conta online emite o feed do chat para evitar duplicados
    if (line.includes(' PRIVMSG #') && this.manager.isFeedConnection(this)) {
      const m = line.match(/^@(\S+) :([^!]+)![^ ]+ PRIVMSG #\S+ :(.*)$/);
      if (!m) return;
      const tags = parseTags(m[1]);
      this.manager.emit('chat', {
        id: tags.id,
        userId: tags['user-id'],
        user: tags['display-name'] || m[2],
        color: tags.color || '',
        mod: tags.mod === '1',
        text: m[3],
        ts: Date.now(),
      });
    }
  }

  #setStatus(s) {
    this.status = s;
    this.manager.emit('accounts');
  }
}

export class Manager extends EventEmitter {
  constructor() {
    super();
    this.conns = new Map(); // userId -> Connection
    this.broadcasterId = null;
    for (const acc of loadAccounts()) this.conns.set(acc.userId, new Connection(acc, this));
  }

  persist() {
    saveAccounts([...this.conns.values()].map((c) => c.account));
  }

  isFeedConnection(conn) {
    const first = [...this.conns.values()].find((c) => c.status === 'online');
    return first === conn;
  }

  list() {
    return [...this.conns.values()].map((c) => ({
      id: c.account.userId,
      login: c.account.login,
      status: c.status,
      error: c.error,
      auto: c.account.auto !== false,
    }));
  }

  async addAccount({ accessToken, refreshToken }) {
    const info = await validate(accessToken);
    const existing = this.conns.get(info.user_id);
    const account = { userId: info.user_id, login: info.login, accessToken, refreshToken, auto: true };
    if (existing) {
      Object.assign(existing.account, account);
      this.persist();
      existing.connect();
      return existing;
    }
    const conn = new Connection(account, this);
    this.conns.set(account.userId, conn);
    this.persist();
    conn.connect();
    return conn;
  }

  remove(id) {
    const c = this.conns.get(id);
    if (!c) return;
    c.disconnect();
    this.conns.delete(id);
    this.persist();
    this.emit('accounts');
  }

  setAuto(id, auto) {
    const c = this.conns.get(id);
    if (!c) throw new Error('conta não existe');
    c.account.auto = auto;
    this.persist();
    this.emit('accounts');
  }

  connectAll() {
    for (const c of this.conns.values()) if (c.account.auto !== false) c.connect();
  }

  get(id) {
    const c = this.conns.get(id);
    if (!c) throw new Error('conta não existe');
    return c;
  }

  async getBroadcasterId(conn) {
    if (!this.broadcasterId) {
      const r = await helix(conn.account, 'GET', '/users', { query: { login: CHANNEL } });
      this.broadcasterId = r.data?.[0]?.id;
      if (!this.broadcasterId) throw new Error(`canal "${CHANNEL}" não encontrado`);
    }
    return this.broadcasterId;
  }

  // Executa uma ação de moderação com o token da conta escolhida
  async moderate(accountId, action, p = {}) {
    const conn = this.get(accountId);
    const a = conn.account;
    const broadcaster_id = await this.getBroadcasterId(conn);
    const moderator_id = a.userId;
    const call = async () => {
      switch (action) {
        case 'timeout':
          return helix(a, 'POST', '/moderation/bans', {
            query: { broadcaster_id, moderator_id },
            body: { data: { user_id: p.userId, duration: Number(p.duration) || 600, reason: p.reason || '' } },
          });
        case 'ban':
          return helix(a, 'POST', '/moderation/bans', {
            query: { broadcaster_id, moderator_id },
            body: { data: { user_id: p.userId, reason: p.reason || '' } },
          });
        case 'unban':
          return helix(a, 'DELETE', '/moderation/bans', { query: { broadcaster_id, moderator_id, user_id: p.userId } });
        case 'delete':
          return helix(a, 'DELETE', '/moderation/chat', { query: { broadcaster_id, moderator_id, message_id: p.messageId } });
        case 'clear':
          return helix(a, 'DELETE', '/moderation/chat', { query: { broadcaster_id, moderator_id } });
        case 'settings':
          return helix(a, 'PATCH', '/chat/settings', { query: { broadcaster_id, moderator_id }, body: p.settings });
        default:
          throw new Error('ação desconhecida');
      }
    };
    try {
      return await call();
    } catch (e) {
      if (e.status !== 401) throw e;
      const t = await refreshToken(a.refreshToken);
      a.accessToken = t.access_token;
      a.refreshToken = t.refresh_token;
      this.persist();
      return call();
    }
  }
}
