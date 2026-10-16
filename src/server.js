import crypto from 'node:crypto';
import express from 'express';
import { Manager } from './manager.js';
import { authorizeUrl, exchangeCode } from './twitch.js';

for (const k of ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'REDIRECT_URI', 'CHANNEL', 'PANEL_PASSWORD']) {
  if (!process.env[k]) {
    console.error(`Falta ${k} no .env (vê .env.example)`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT) || 3000;
const manager = new Manager();
const app = express();
app.use(express.json());

// ---- OAuth (público, protegido por state de uso único) ----
const states = new Map(); // state -> expiresAt
const newState = () => {
  const s = crypto.randomBytes(16).toString('hex');
  states.set(s, Date.now() + 15 * 60 * 1000);
  return s;
};
const safeEqual = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

app.get('/auth/start/:state', (req, res) => {
  const exp = states.get(req.params.state);
  if (!exp || exp < Date.now()) return res.status(400).send('Link expirado. Pede um novo.');
  res.redirect(authorizeUrl(req.params.state));
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error_description } = req.query;
  const exp = states.get(state);
  states.delete(state);
  if (!exp || exp < Date.now()) return res.status(400).send('State inválido ou expirado.');
  if (!code) return res.status(400).send(`Autorização recusada: ${error_description || ''}`);
  try {
    const t = await exchangeCode(code);
    const conn = await manager.addAccount({ accessToken: t.access_token, refreshToken: t.refresh_token });
    res.send(`<meta charset=utf-8><body style="font-family:sans-serif;padding:2rem">Conta <b>${conn.account.login}</b> adicionada. Já podes fechar esta página.<br><br><a href="/">Voltar ao painel</a></body>`);
  } catch (e) {
    res.status(500).send(`Erro: ${e.message}`);
  }
});

// ---- Autenticação do painel (Basic) ----
app.use((req, res, next) => {
  const h = req.headers.authorization || '';
  const [user, ...rest] = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString().split(':');
  if (user === 'admin' && safeEqual(rest.join(':'), process.env.PANEL_PASSWORD)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Painel"').status(401).send('Autenticação necessária');
});

app.use(express.static('public'));

// ---- API ----
const wrap = (fn) => async (req, res) => {
  try {
    res.json((await fn(req)) ?? { ok: true });
  } catch (e) {
    res.status(e.status && e.status < 600 ? e.status : 400).json({ error: e.message });
  }
};

app.get('/api/accounts', (req, res) => res.json({ channel: process.env.CHANNEL, accounts: manager.list() }));

// Link para adicionar uma conta (abre no browser onde a conta está/for autenticada) ou para enviar a um moderador
app.post('/api/accounts/invite', (req, res) => {
  const base = new URL(process.env.REDIRECT_URI).origin;
  res.json({ url: `${base}/auth/start/${newState()}` });
});

app.post('/api/accounts/:id/connect', wrap((r) => manager.get(r.params.id).connect()));
app.post('/api/accounts/:id/disconnect', wrap((r) => manager.get(r.params.id).disconnect()));
app.post('/api/accounts/:id/auto', wrap((r) => manager.setAuto(r.params.id, !!r.body.auto)));
app.delete('/api/accounts/:id', wrap((r) => manager.remove(r.params.id)));
app.post('/api/connect-all', wrap(() => manager.connectAll()));

app.post('/api/say', wrap((r) => {
  const { accountIds, message } = r.body;
  if (!message?.trim()) throw new Error('mensagem vazia');
  for (const id of accountIds) manager.get(id).say(message.slice(0, 500));
}));

app.post('/api/mod', wrap((r) => manager.moderate(r.body.accountId, r.body.action, r.body)));

// Feed em tempo real (SSE)
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const onChat = (m) => send('chat', m);
  const onAcc = () => send('accounts', manager.list());
  manager.on('chat', onChat);
  manager.on('accounts', onAcc);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    manager.off('chat', onChat);
    manager.off('accounts', onAcc);
  });
  onAcc();
});

app.listen(PORT, () => {
  console.log(`Painel em http://localhost:${PORT}  (utilizador: admin)`);
  manager.connectAll();
});
