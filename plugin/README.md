# LivePix 1.2.0

Plugin comunitário para OSC Flow Studio 0.5.x. Cada doação que chega ao LivePix vira um
gatilho de flow. Nenhum webhook público: o plugin consulta a API a cada intervalo
usando OAuth2 com Client Credentials.

## Instalação

1. No painel do LivePix, crie um aplicativo OAuth e anote o Client ID e o Client Secret.
   Marque `payments:read` e, para receber o nome e a mensagem do apoiador, `messages:read`.
2. No OSC Flow Studio, abra **Integrações → Install from zip** e escolha
   `io.github.osc-flow-studio.livepix-1.2.0.zip`. Revise e confirme o pacote.
3. Na aba **Credenciais**, informe o Client ID e o Client Secret. O secret vai para o
   cofre criptografado do Studio e nunca aparece em logs.
4. Na aba **Geral**, escolha o intervalo e se quer ler nome e mensagem. Trinta segundos é
   um bom padrão; abaixo de quinze o LivePix pode responder 429.
5. Ative a integração. A primeira consulta só marca o histórico como visto; nada dispara.
   Ligue **Disparar pelo histórico na primeira consulta** apenas quando as doações antigas
   fizerem parte do evento.

## Blocos

Identidade do pacote: `io.github.osc-flow-studio.livepix`; API de plugins 1.
Depois da primeira release pública, adicione esta fonte em **Integrações → Sources**
para receber atualizações:

```text
https://github.com/OSC-Flow-Studio/livepix-plugin/releases/latest/download/listing.json
```

Na atualização da 1.1.0, configurações, credenciais e doações já vistas são preservadas.
Ao adotar uma instalação antiga pelo gerenciador, conclua o reinício solicitado.
Desativar cancela requisições em andamento antes de encerrar a instância.

| Bloco | O que faz |
|---|---|
| LivePix: doação recebida | Gatilho. Um disparo por doação nova, com `metadata.amount` em centavos e, quando houver, nome e mensagem. Filtra por valor mínimo, valor máximo, texto e presença de mensagem. |
| LivePix: consultar agora | Ação. Consulta a API na hora e dispara o que houver de novo. |
| LivePix: ler status | Entrada. Saúde da conexão, última consulta e contadores. |

Uma doação é um evento. Na versão 1.0.0 havia dois gatilhos, pagamento e mensagem, e uma
doação com texto disparava os dois: quem somava os dois contava a mesma doação duas vezes.
Agora `/v2/payments` e `/v2/messages` são unidos pelo comprovante antes de qualquer
disparo, e `metadata.hasMessage` diz se veio texto.

`metadata.eventKey` já vem pronto para o campo **chave única do evento** de outros
plugins, então a mesma doação nunca é creditada duas vezes nem depois de reiniciar.

## Atualizando da 1.0.0

O registro de doações vistas mudou de formato. Na primeira consulta depois da atualização
o plugin refaz a linha de base sem disparar nada, de propósito: replicar o registro antigo
no formato novo faria cada doação passada disparar outra vez. Se você usa o LivePix em um
subathon, nenhuma doação antiga é creditada de novo.

## Segurança

- O Client Secret sai da máquina apenas para `oauth.livepix.gg`, sobre HTTPS.
- O escopo pedido é o mínimo: `payments:read`, e `messages:read` só quando a leitura de
  mensagens está ligada.
- O token de acesso fica só em memória e é descartado ao desativar.
- Toda requisição tem tempo limite de dez segundos. Resposta 429 dobra o intervalo até
  cinco minutos e volta ao normal na primeira consulta bem-sucedida.
- O plugin só lê. Nenhum escopo de escrita é solicitado.
