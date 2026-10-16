const { TWITCH_CLIENT_ID: CLIENT_ID, TWITCH_CLIENT_SECRET: CLIENT_SECRET, REDIRECT_URI } = process.env;

export const SCOPES = [
  'chat:read',
  'chat:edit',
  'moderator:manage:banned_users',
  'moderator:manage:chat_messages',
  'moderator:manage:chat_settings',
];

export function authorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    force_verify: 'true', // obriga a escolher/confirmar a conta em cada autorização
  });
  return `https://id.twitch.tv/oauth2/authorize?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `token ${res.status}`);
  return json;
}

export const exchangeCode = (code) =>
  tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI });

export const refreshToken = (refresh_token) =>
  tokenRequest({ grant_type: 'refresh_token', refresh_token });

export async function validate(accessToken) {
  const res = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!res.ok) throw new Error('token inválido');
  return res.json(); // { user_id, login, scopes, ... }
}

export async function helix(account, method, path, { query, body } = {}) {
  const url = new URL(`https://api.twitch.tv/helix${path}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      'Client-Id': CLIENT_ID,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || `helix ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}
