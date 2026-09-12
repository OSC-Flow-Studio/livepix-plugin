# Changelog

## 1.2.0 — 2026-09-12

- Compatibilidade declarada com OSC Flow Studio 0.5.x, API de plugins 1.
- Pacote `io.github.osc-flow-studio.livepix`, ZIP determinístico e SHA-256.
- Catálogo para instalação, atualização e rollback pelo gerenciador de pacotes.
- Requisições OAuth/API canceladas por `ctx.signal` e por `deactivate()`; consultas
  pendentes terminam antes de liberar a instância e persistir o estado final.
- A ação de consulta respeita a configuração desativada.
- Preservados `id=livepix`, tipos dos blocos, chave do cofre e formato de deduplicação
  da versão 1.1.0. Atualizar da 1.1.0 não recria a linha de base.
- Repositório independente do SDK, testes, validação do schema e workflows de CI/release.

## 1.1.0

- Pagamentos e mensagens unidos em um gatilho de doação, com deduplicação pelo comprovante.
- Abas de configuração, histórico inicial opcional e tratamento de limite de requisições.

## 1.0.0

- Primeira integração por consulta à API LivePix.
