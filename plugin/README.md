# LivePix 2.0.0

Plugin comunitário para OSC Flow Studio 0.5.x. Cada doação que chega ao LivePix vira um
gatilho de flow. As doações passam pelo **OSC LivePix Dashboard**
(`https://livepix.maned.club`), que recebe o webhook do LivePix, guarda cada doação e
entrega ao plugin em tempo real.

## Instalação

1. Acesse o OSC LivePix Dashboard, crie sua conta e crie um webhook.
2. Na tela do webhook, copie a **URL para o LivePix** e cadastre-a como webhook no painel
   do LivePix (dashboard.livepix.gg). Não mostre essa URL na live nem a envie para
   ninguém: o LivePix não aceita senha em webhooks, então o link é a única proteção.
3. Ainda no dashboard, informe o Client ID e o Client Secret de um aplicativo OAuth do
   LivePix com `payments:read` e `messages:read`. A notificação do LivePix só diz qual
   doação chegou; é com essas credenciais que o dashboard lê valor, nome e mensagem.
4. Clique em **Gerar token** e copie o token (começa com `olp_`). Ele aparece uma vez só.
5. No OSC Flow Studio, abra **Integrações → Install from zip** e escolha
   `io.github.osc-flow-studio.livepix-2.0.0.zip`. Revise e confirme o pacote.
6. Na aba **Conexão**, cole o token. A URL base já vem com `https://livepix.maned.club`.
7. Na aba **Subathon**, informe quando o subathon começa, por exemplo `2026-09-21 18:00`
   ou `21/09/2026 18:00` (hora local). Só doações a partir desse momento disparam.
   Vazio, o plugin conta a partir da primeira ativação.
8. Ative a integração.

## Como as doações chegam

O WebSocket é o caminho principal: a doação dispara assim que o dashboard a confirma no
LivePix. Quando o WebSocket cai, o plugin consulta a API do dashboard no intervalo da aba
**Geral** (10 segundos por padrão) e tenta reconectar sozinho. Depois de cada reconexão,
na ativação e a cada cinco minutos, ele relê todas as doações desde o início do subathon.

Cada doação processada tem o ID guardado no cofre do Studio antes do gatilho disparar.
Se o Studio fechar, travar ou ficar sem internet, ao voltar o plugin busca no dashboard
tudo o que chegou nesse meio tempo e dispara apenas o que ainda não tinha disparado.
Nenhuma doação é creditada duas vezes, e nenhuma anterior ao início do subathon dispara.

## Blocos

Identidade do pacote: `io.github.osc-flow-studio.livepix`; API de plugins 1.
Depois da primeira release pública, adicione esta fonte em **Integrações → Sources**
para receber atualizações:

```text
https://github.com/OSC-Flow-Studio/livepix-plugin/releases/latest/download/listing.json
```

| Bloco | O que faz |
|---|---|
| LivePix: doação recebida | Gatilho. Um disparo por doação nova desde o início do subathon, com `metadata.amount` em centavos e, quando houver, nome e mensagem. Filtra por valor mínimo, valor máximo, texto e presença de mensagem. |
| LivePix: sincronizar agora | Ação. Relê o dashboard desde o início do subathon e dispara o que ainda não foi processado. |
| LivePix: ler status | Entrada. Transporte em uso (`websocket`, `polling` ou `offline`), última sincronização e contadores. |

`metadata.eventKey` já vem pronto para o campo **chave única do evento** de outros
plugins, então a mesma doação nunca é creditada duas vezes nem depois de reiniciar.

## Atualizando da 1.x

A 2.0.0 não fala mais direto com a API do LivePix. Client ID e Client Secret saem do
plugin e passam a ficar no dashboard; no plugin ficam só a URL base, o token e o início
do subathon. Os tipos dos blocos e o formato do gatilho são os mesmos, então os flows
continuam funcionando. As doações que a 1.2.0 já tinha disparado continuam marcadas como
processadas.

## Segurança

- O token sai da máquina apenas para a URL base configurada, sempre em HTTPS
  (`http://` só é aceito para `localhost`).
- O token fica no cofre criptografado do Studio e abre somente o webhook que o gerou.
  Gerar um novo token no dashboard derruba o anterior na hora.
- Toda requisição tem tempo limite de dez segundos.
