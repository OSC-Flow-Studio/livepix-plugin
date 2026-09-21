# OSC LivePix Dashboard

Recebe o webhook do LivePix, lê cada doação na API do LivePix, guarda tudo no Postgres e
entrega ao plugin LivePix do OSC Flow Studio por WebSocket e por API. Produção:
`https://livepix.maned.club`.

Stack: TypeScript, Hono, Prisma 7, Postgres, Better Auth (e-mail e senha, plugin de API
key) no servidor; React, Tailwind CSS 4 e shadcn/ui no frontend. Um único processo Node
serve a API, o WebSocket e o frontend já compilado.

## Fluxo

```text
LivePix ──POST /<id>/livepix──▶ dashboard ──GET /v2/messages/{id}──▶ API do LivePix
                                   │  grava a notificação crua, depois a doação
                                   ▼
                     Postgres (delivery, donation)
                                   │
          WebSocket /<id>/websocket │  GET /<id>/api/donations
                                   ▼
                    plugin LivePix no OSC Flow Studio
```

1. A notificação do LivePix só traz `{ event, resource: { id, type } }`. Ela é gravada
   crua (cabeçalhos, corpo, IP) **antes** de qualquer processamento, e o LivePix só
   recebe 200 depois disso. Se o banco falhar, a resposta é 500 e o LivePix reenvia a cada
   10 minutos por 24 horas.
2. Um processador lê a doação na API do LivePix com as credenciais OAuth do webhook
   (Client Secret criptografado com AES-256-GCM). Uma notificação de pagamento procura a
   mensagem correspondente pelo `proof` para trazer nome e texto. Pagamento e mensagem da
   mesma doação viram uma doação só.
3. Falha de rede, 5xx ou 429 do LivePix: nova tentativa com espera exponencial (30 s até
   30 min, 12 tentativas). Falta de credenciais, credencial recusada ou ID desconhecido
   pelo LivePix: fica parada até alguém agir. Salvar credenciais reenfileira o que
   parou por falta delas, e a tela de depuração tem **Processar de novo**. Nada é apagado
   automaticamente.
4. Cada doação nova é publicada no WebSocket do webhook. A API devolve as doações por
   ordem de chegada, filtradas pelo início do subathon.

Um ID de notificação forjado não vira doação: o dashboard confirma cada ID na API do
LivePix. Mesmo assim, a URL `/<id>/livepix` é a única proteção do endpoint (o LivePix não
aceita senha), e a interface avisa o usuário para não compartilhá-la.

## Endpoints

| Rota | Quem usa | Autenticação |
|---|---|---|
| `POST /<id>/livepix` | LivePix | ID secreto na URL (24 caracteres alfanuméricos) |
| `GET /<id>/api` | plugin | token |
| `GET /<id>/api/donations?since=<ISO>&after=<seq>&limit=<1-500>` | plugin | token |
| `GET /<id>/websocket` | plugin | token |
| `/api/auth/*` | frontend | Better Auth |
| `/api/webhooks/*` | frontend | sessão |
| `GET /healthz` | orquestrador | nenhuma |

O token do plugin tem o formato `olp_<webhookId>_<segredo>` e vai em
`Authorization: Bearer <token>` (ou `x-api-key`). É uma API key do Better Auth, guardada
com hash, sem limite de requisições, e abre apenas o webhook cujo ID carrega. Gerar outro
token ou revogar derruba na hora os WebSockets abertos (código 4001); desativar o webhook
fecha com 4003 e a API responde 403.

Mensagens do WebSocket, do servidor para o plugin:

```json
{ "type": "hello", "webhook": { "id": "…", "name": "…" }, "latestSeq": "42", "serverTime": "…" }
{ "type": "donation", "donation": { "id": "E0000…", "seq": "43", "amount": 1000, "currency": "BRL", "username": "Harry", "message": "Olá!", "hasMessage": true, "flagged": false, "livepixId": "…", "proof": "…", "reference": "…", "source": "message", "occurredAt": "…", "receivedAt": "…" } }
{ "type": "heartbeat", "serverTime": "…" }
```

A cada 25 s chega um `heartbeat`. O plugin pode mandar `{"type":"ping"}` e recebe `pong`.
`id` é o `proof` do LivePix (ou `reference`, ou `id`) e é a chave de deduplicação.

## Hospedar com Docker

```bash
cp .env.example .env
# preencha POSTGRES_PASSWORD, DATABASE_URL, BETTER_AUTH_SECRET e ENCRYPTION_KEY
docker compose up -d --build
```

O compose sobe o Postgres, roda `prisma migrate deploy` em um serviço separado e só
então inicia o app na porta `PORT`. Coloque um proxy HTTPS na frente (Caddy, Nginx,
Traefik) que repasse também o upgrade de WebSocket. O processo guarda os WebSockets em
memória: rode uma instância só. Para várias, o `RealtimeHub` precisaria de um canal
compartilhado (Postgres `LISTEN/NOTIFY`).

Depois de criar a sua conta, `ALLOW_SIGNUP=false` fecha novos cadastros. Trocar a
`ENCRYPTION_KEY` torna ilegíveis os Client Secrets salvos.

## Desenvolver

Requisito: Node.js 22. Sem Docker, `npm run dev:db` sobe um Postgres local na porta 5433
(PGlite, com os dados em `.pglite/`).

```bash
npm ci
npm run dev:db          # terminal 1
cp .env.example .env    # DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres?sslmode=disable
npm run db:migrate
npm run dev:server      # terminal 2, http://localhost:3000
npm run dev:web         # terminal 3, http://localhost:5173 (proxy de /api para o servidor)
```

No `.env` de desenvolvimento, use `PUBLIC_URL=http://localhost:3000`. A origem do Vite
(`http://localhost:5173`) já está entre as origens confiáveis do Better Auth.

| Comando | O que faz |
|---|---|
| `npm test` | Testes de ponta a ponta: servidor HTTP real, Postgres (PGlite), LivePix falso e cliente WebSocket. |
| `npm run typecheck` | Gera o client do Prisma e checa servidor, testes e frontend. |
| `npm run build` | Compila o frontend em `dist/web` e o servidor em `dist/server`. |
| `npm start` | Roda o build de produção. |

Uma migration nova: com o banco local já migrado, altere `prisma/schema.prisma` e gere o
SQL com
`npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
em uma pasta nova de `prisma/migrations/`. O `prisma migrate dev` precisa de um banco
"shadow" que o PGlite não cria; com um Postgres de verdade ele funciona normalmente.
