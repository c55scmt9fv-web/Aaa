# Painel de Moderadores Twitch

Liga várias contas de moderadores ao chat do teu canal e controla-as a partir de um painel web:
ver o chat em direto, escrever, dar timeout/ban, apagar mensagens, mudar o modo do chat.
Tudo pela API oficial da Twitch (OAuth + IRC + Helix), sem passwords e sem browser aberto.

## Configuração

1. Cria uma app em <https://dev.twitch.tv/console/apps> (Category: *Chat Bot*) e define o
   **OAuth Redirect URL** igual a `REDIRECT_URI`.
2. `cp .env.example .env` e preenche `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `CHANNEL`, `PANEL_PASSWORD`.
3. `npm install && npm start` → <http://localhost:3000> (utilizador `admin`).
4. Garante que as contas são **moderadoras** do teu canal (`/mod nome` no chat).

## Adicionar contas

- **Botão "+ Adicionar conta"**: antes, inicia sessão na Twitch com a conta do moderador
  (janela anónima ou outro browser). Repete para cada conta.
- **"Link para moderador"**: gera um link de uso único (15 min) para a pessoa autorizar do PC dela.

Os tokens ficam em `data/accounts.json` (permissões 600) e são renovados automaticamente.
Ao reiniciar, as contas ligam-se sozinhas. Não há limite de contas: o botão serve para adicionar mais.

## Correr em segundo plano (servidor/VPS)

Põe atrás de HTTPS (ex.: Caddy/nginx), ajusta `REDIRECT_URI` para o teu domínio (e na app Twitch) e usa
`pm2 start "npm start" --name mods` ou um serviço systemd.
**Usa uma password forte** em `PANEL_PASSWORD` — quem entra no painel controla as contas.
