# LivePix para OSC Flow Studio

Cada doação do LivePix dispara um flow no OSC Flow Studio **0.5.x**. O plugin consulta
a API por OAuth2, une pagamento e mensagem pelo comprovante e mantém a deduplicação
no cofre do Studio. Não precisa de webhook público.

| Contrato | Valor |
| --- | --- |
| Versão do plugin | 1.2.0 |
| OSC Flow Studio | `>=0.5.0 <0.6.0` |
| Identidade pública | `io.github.osc-flow-studio.livepix` |
| ID dos blocos e configurações | `livepix` |
| Runtime SDK | API 1 |
| Repositório | [OSC-Flow-Studio/livepix-plugin](https://github.com/OSC-Flow-Studio/livepix-plugin) |

## Instalar

O artefato é um **pacote ZIP do gerenciador de pacotes do OSC Flow Studio**.

1. Baixe `io.github.osc-flow-studio.livepix-1.2.0.zip` da release ou gere-o com os
   comandos abaixo. Abra **Integrações → Install from zip** e revise a instalação.
2. Para receber atualizações, depois da primeira release pública, adicione esta fonte
   em **Integrações → Sources**:

   ```text
   https://github.com/OSC-Flow-Studio/livepix-plugin/releases/latest/download/listing.json
   ```

3. Abra **Catalog**, escolha LivePix e confirme. Uma atualização de um plugin em uso
   fica preparada até reiniciar o backend; use a ação de reinício oferecida pelo Studio.
4. No LivePix, crie um aplicativo OAuth com `payments:read` e `messages:read` para ler
   também nome e texto. Informe Client ID e Client Secret na aba **Credenciais**.
5. Ative a integração e importe o template de doações no console. Ele chega desligado:
   revise e ative o flow. A primeira consulta ignora o histórico por padrão.

A URL do catálogo só fica disponível após publicar a primeira release. O arquivo local
`dist/listing.json` é uma prévia e aponta para os futuros artefatos dessa release.

Veja [blocos, histórico e configuração](plugin/README.md). Para o CatOPanda Subathon,
instale os dois plugins e importe **CatOPanda Subathon: LivePix pronta**. O LivePix
funciona sozinho e o CatOPanda continua funcionando com outras fontes de contribuição.

## Atualizar uma instalação antiga

O `id=livepix`, os tipos dos blocos, a chave `livepix-state-v1` e o formato de estado da
versão 1.1.0 foram preservados. O Studio adota a instalação local ao instalar este
pacote, mantendo configurações e segredos; conclua o reinício solicitado. Doações
vistas na 1.1.0 continuam vistas. A migração da 1.0.0 ainda refaz a linha de base para
evitar crédito duplicado. A mudança para 1.2.0 não altera o formato persistido.

## Desenvolver e gerar o pacote

Requisito: Node.js 22 ou superior e npm. O Node.js é necessário para desenvolvimento;
o Studio executa o plugin usando seu próprio runtime. O repositório contém o schema
e o empacotador oficiais do SDK 0.5.0 em `sdk/` e não depende de pastas irmãs.

```powershell
cd J:\Projetos\Portfolio\livepix-plugin
npm ci
npm run package
npm run catalog
```

`npm run package` executa primeiro a validação do schema, regras do instalador e
testes. Os arquivos produzidos são:

- `dist/io.github.osc-flow-studio.livepix-1.2.0.zip`
- `dist/io.github.osc-flow-studio.livepix-1.2.0.zip.sha256`
- `dist/listing.json` (por `npm run catalog`)

O ZIP contém somente `plugin/`, com `manifest.json` na raiz. Dependências de
desenvolvimento, testes, credenciais, `.git` e scripts de publicação ficam fora.
`npm run check` permite validar sem empacotar. Para verificar o hash no PowerShell:

```powershell
Get-FileHash dist/io.github.osc-flow-studio.livepix-1.2.0.zip -Algorithm SHA256
Get-Content dist/io.github.osc-flow-studio.livepix-1.2.0.zip.sha256
```

## Publicar no GitHub

Responsável: mantenedor com permissão de escrita em `OSC-Flow-Studio/livepix-plugin`.
O repositório precisa ser público para o Studio baixar ZIP e catálogo. Habilite
GitHub Actions; o workflow de release usa `GITHUB_TOKEN` com `contents: write`, sem
segredos do LivePix. GitHub Pages e registro npm não são necessários.

Primeira publicação, a partir deste repositório já configurado com `origin`:

```powershell
npm ci
npm run package
git add .
git commit -m "Prepare LivePix 1.2.0 for OSC Flow Studio 0.5.0"
git push -u origin main
```

Aguarde **Validate plugin** passar no Windows e Linux. Só então publique a versão:

```powershell
git tag v1.2.0
git push origin v1.2.0
```

O workflow **Release OSC Flow Studio package** valida novamente, recupera o catálogo
da última release, mantém as versões antigas e cria um draft com ZIP, SHA-256 e
`listing.json`. Em seguida publica os três juntos, evitando que um catálogo público
aponte para um ZIP ausente. A URL estável passa a servir o catálogo da nova release.
Os workflows seguem a [configuração de permissões do GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).

Critérios de conclusão: workflow verde, três assets públicos, hash do ZIP igual ao
catálogo e instalação pela fonte dentro do Studio 0.5.0. Teste o template do console
com uma nova doação antes de ligar um flow que credite tempo de live.

Pare se falhar validação, divergir a tag da versão, faltar o catálogo anterior ou
houver uma release com a mesma tag. Não substitua um ZIP já publicado: incremente
`plugin/manifest.json` e `package.json`, atualize o lockfile com
`npm install --package-lock-only`, documentação e `CHANGELOG.md`, e use outra tag.
Se o workflow parar depois de criar o draft, confira seus três assets no GitHub e
publique esse draft para concluir a mesma release. O workflow não sobrescreve releases.

Para gerar manualmente uma atualização de catálogo, use uma cópia do catálogo público:

```powershell
npm run catalog -- --previous caminho/para/listing-anterior.json
```

Publicar o resultado sem `--previous` em uma atualização descartaria o histórico;
o workflow sempre recupera esse histórico e falha se não conseguir lê-lo.

## Verificações locais

Os testes simulam OAuth/API; verificam deduplicação, migração, limites de requisição,
cancelamento durante OAuth, leitura de pagamentos e corpo da resposta, reativação e
pacotes determinísticos. Não usam uma conta LivePix real. CI remoto, download público
e instalação pelo catálogo precisam ser conferidos após a publicação.
