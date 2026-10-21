# Agendamento de Tablets

Sistema para os professores das unidades **Castelo II** e **Floresta** reservarem os tablets
da escola. **Cada unidade tem o próprio acervo** (hoje 30 tablets em cada uma), e a reserva de
uma unidade não ocupa tablets da outra. A regra central: **a soma das reservas da mesma unidade
que se sobrepõem nunca passa do acervo daquela unidade**, em nenhum minuto do intervalo.

- Interface em React + TypeScript (agenda semanal, visão por dia no celular, tema claro e escuro).
- Servidor em Node.js **sem dependências de produção**: só módulos do próprio Node.
- Banco SQLite num arquivo só (`node:sqlite`, embutido no Node).
- Login com a **conta Microsoft da escola** (Microsoft Entra ID, OpenID Connect).
- Papéis: **professor** (reserva no próprio nome e cancela as próprias reservas) e
  **coordenação** (reserva em nome de qualquer professor e cancela qualquer reserva).
- Registro de auditoria de quem criou, cancelou e registrou a devolução de cada reserva.

---

## Requisitos

| Item | Versão |
| --- | --- |
| Node.js | **22.18 ou mais nova** (roda TypeScript direto e traz `node:sqlite`). Node 24 LTS também serve. |
| Navegadores | Chrome, Edge, Safari e Firefox atuais, no computador e no celular. |
| Rede | O servidor precisa acessar `login.microsoftonline.com` (HTTPS de saída). |

Em produção não há `npm install` de pacotes de servidor: as dependências do `package.json` são
só para gerar a interface (`npm run build`) e rodar a verificação de tipos.

## Rodar em 1 minuto (sem Microsoft)

```bash
npm install
npm run dev
```

Abra http://localhost:3000. Aparece um login de desenvolvimento que pede só nome e e-mail
(e uma caixa "Sou da coordenação"). **Esse modo é recusado quando `NODE_ENV=production`.**

## Colocar em produção

```bash
npm ci
npm run build          # gera dist/public
cp .env.example .env   # e preencha
npm start
```

Coloque o sistema atrás do proxy HTTPS da escola (IIS, nginx, Apache, Azure App Service etc.)
e use em `BASE_URL` o endereço exato que os professores vão acessar. O cookie de sessão sai
com `Secure` automaticamente quando `BASE_URL` começa com `https://`.

Exemplo de serviço no Linux (systemd):

```ini
[Unit]
Description=Agendamento de Tablets
After=network.target

[Service]
WorkingDirectory=/opt/agendamento-tablets
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/main.ts
Restart=on-failure
User=agendamento

[Install]
WantedBy=multi-user.target
```

Verificação de saúde: `GET /healthz` → `{"ok":true}`.

## Configurar o login Microsoft (Entra ID)

1. **Entra ID → Registros de aplicativo → Novo registro.**
   - Nome: *Agendamento de Tablets*.
   - Tipos de conta: *Somente contas deste diretório organizacional* (um locatário).
   - URI de redirecionamento: plataforma **Web**, `https://SEU-ENDERECO/auth/callback`.
2. Em **Visão geral**, copie a *ID do diretório (locatário)* para `ENTRA_TENANT_ID` e a
   *ID do aplicativo (cliente)* para `ENTRA_CLIENT_ID`.
3. Em **Certificados e segredos → Novo segredo do cliente**, copie o valor para
   `ENTRA_CLIENT_SECRET`. Anote a validade: o login para de funcionar quando o segredo vence.
4. Não é preciso marcar *Tokens de ID* nem *Tokens de acesso* em "Concessão implícita": o sistema
   usa o fluxo de código de autorização com PKCE.
5. **Quem é da coordenação** (escolha uma forma):
   - **App role (recomendado):** em *Funções de aplicativo*, crie uma função com valor
     `Coordenacao` para *Usuários/Grupos*. Depois, em *Aplicativos empresariais → Agendamento de
     Tablets → Usuários e grupos*, atribua essa função às pessoas ou ao grupo da coordenação.
   - **Grupo:** em *Configuração de token*, adicione a declaração `groups` e ponha os ids dos grupos
     em `ENTRA_COORDINATOR_GROUP_IDS`. Atenção: quem está em mais de 200 grupos não recebe a lista no
     token; nesse caso prefira o App role.
   - **E-mails:** liste em `COORDINATOR_EMAILS`. Simples, mas exige editar o `.env` a cada mudança.
6. **Quem pode entrar:** por padrão, qualquer conta da escola. Para limitar aos professores, em
   *Aplicativos empresariais → Propriedades*, ative **Atribuição obrigatória** e atribua o grupo de
   professores e a coordenação.

O papel é lido a cada login. Mudou alguém de grupo? Vale a partir do próximo login (a sessão dura
`SESSION_HOURS`, 12 h por padrão).

### O que o servidor confere no login

Fluxo de código de autorização com **PKCE**, **state** de uso único (vale 10 minutos) e **nonce**.
O `id_token` é validado no servidor: assinatura RS256 com as chaves públicas do locatário (baixadas
e guardadas por 1 hora), emissor, audiência (`ENTRA_CLIENT_ID`), locatário, validade e nonce.
A sessão fica num cookie `HttpOnly`, `SameSite=Lax`, com id aleatório de 256 bits guardado no banco.

## Regras da escola (`config/escola.json`)

| Campo | Padrão | Significado |
| --- | --- | --- |
| `units` | Castelo II: 30, Floresta: 30 | Cada unidade e o tamanho do acervo dela: `{ "name": "Floresta", "tablets": 30 }`. Os acervos são independentes e podem ter tamanhos diferentes. |
| `periods` | 12 horários | Horários de aula oferecidos no formulário (id, nome, início, fim). |
| `dayStartMinutes` / `dayEndMinutes` | 420 / 1100 | Janela de reserva em minutos desde 00:00 (07:00 às 18:20). |
| `minDurationMinutes` | 15 | Duração mínima de uma reserva. |
| `timezone` | America/Sao_Paulo | Fuso usado em todas as datas do servidor. |
| `limits` | 80 / 80 / 40 / 500 | Tamanho máximo de título, professor, turma e observações. |

Depois de editar, reinicie o servidor. A interface recebe as regras pelo `/api/me`, então não
precisa gerar o build de novo.

Outras regras fixas: reservas só de segunda a sexta; não aceita data ou horário que já passou;
a quantidade é um inteiro entre 1 e o acervo da unidade escolhida.

## Banco de dados

SQLite em `DATABASE_PATH` (padrão `data/agendamento.db`), em modo WAL. As tabelas são criadas e
atualizadas sozinhas ao iniciar (`PRAGMA user_version`).

| Tabela | Conteúdo |
| --- | --- |
| `reservations` | Reservas. Status gravado: `confirmada`, `cancelada` ou `devolvida`. |
| `users` | Nome, e-mail e papel de quem já entrou (id = `oid` do Entra). |
| `sessions` | Sessões ativas. |
| `login_states` | Estados de login em andamento (apagados ao usar ou vencer). |
| `audit_log` | Quem criou, cancelou ou registrou devolução, e quando. |

As situações *Agendada*, *Em andamento* e *Aguardando devolução* não são gravadas: saem do status
`confirmada` comparado com o horário atual.

**Backup:** com o servidor rodando, use `sqlite3 data/agendamento.db ".backup backup.db"`.
Copiar só o `.db` com o servidor ligado pode perder o que ainda está no arquivo `-wal`.

**Reservas simultâneas:** cada gravação roda dentro de `BEGIN IMMEDIATE`, que bloqueia as outras
gravações até o fim da transação. A conferência dos tablets livres da unidade e a gravação acontecem dentro
desse bloqueio, então duas reservas no mesmo segundo nunca passam do acervo, mesmo com mais de um
processo do servidor no mesmo arquivo (há teste automático para isso). Para vários servidores em
máquinas diferentes, troque o SQLite por um banco de rede (veja abaixo).

### Trocar por SQL Server, PostgreSQL ou MySQL

Todo acesso ao banco está em `server/db.ts`. Para trocar, reimplemente os métodos da classe
`Database` mantendo as assinaturas, e garanta que `transaction()` serialize as reservas que
disputam o mesmo horário. Exemplos: `SELECT … WITH (UPDLOCK, HOLDLOCK)` no SQL Server, ou
`pg_advisory_xact_lock` por data no PostgreSQL. Os testes de `tests/` servem para conferir a troca.

## API

Todas as rotas `/api/*` exigem sessão. Sem sessão: `401`. Requisições que alteram dados (`POST`)
precisam do cabeçalho `X-Requested-With: agendamento` (proteção contra CSRF) e corpo JSON.
Datas e horas estão sempre no horário local da escola, no formato `AAAA-MM-DDTHH:MM:SS`.

| Método e rota | O que faz |
| --- | --- |
| `GET /api/me` | Usuário logado, papel, regras da escola e modo de login. |
| `GET /api/reservations?from=AAAA-MM-DD&to=AAAA-MM-DD` | Reservas que começam nesse intervalo (inclusive). |
| `GET /api/reservations?q=texto` | Busca por atividade, professor ou turma (até 50). |
| `GET /api/availability?unit=…&start=…&end=…` | `{ unit, free, total }`: tablets livres da unidade durante todo o intervalo. |
| `POST /api/reservations` | Cria. Corpo: `title, teacher, unit, className, quantity, date, startTime, endTime, notes`. |
| `POST /api/reservations/{id}/cancel` | Cancela (quem criou ou coordenação). |
| `POST /api/reservations/{id}/return` | Registra devolução (quem criou ou coordenação). |

Erros vêm como `{ "error": "mensagem para o usuário", "field": "campo" }`:
`422` dado inválido, `409` faltam tablets na unidade ou a situação não permite, `403` sem permissão,
`404` não encontrada.

O campo `teacher` só é usado quando quem reserva é da coordenação. Para professores, o servidor
grava sempre o nome do login.

## Incluir no sistema da escola

- **Link no menu do sistema atual:** o mais simples. Como o login é a mesma conta Microsoft, quem
  já está logado na Microsoft entra direto.
- **Dentro de um iframe:** ponha o endereço do sistema principal em `FRAME_ANCESTORS`. Os dois
  precisam estar no mesmo domínio (por exemplo `portal.escola.edu.br` e `tablets.escola.edu.br`);
  em domínios diferentes, o navegador não envia o cookie de sessão dentro do iframe.
- **Integrar no código do sistema atual:** a interface (`web/src`) só fala com o servidor pela API
  acima, em `web/src/api.ts`. Dá para manter este servidor e só trocar a interface, ou reimplementar
  a API no sistema de vocês e reaproveitar `shared/rules.ts`, que tem todas as regras.

## Estrutura

```
shared/      Regras de reserva e tipos, usados pelo servidor e pela interface
  rules.ts   Datas, tablets em uso por unidade, validação completa de uma reserva
  types.ts   Formato de Reserva, Usuário e configuração
server/      Servidor (Node, sem dependências)
  main.ts    Ponto de entrada
  app.ts     Rotas HTTP, arquivos estáticos e cabeçalhos de segurança
  auth.ts    Login Microsoft (OIDC), sessão e login de desenvolvimento
  reservations.ts  Criar, cancelar e devolver, com permissões e auditoria
  db.ts      SQLite: tabelas, consultas e transações
  config.ts  Leitura do .env e do config/escola.json
web/         Interface
  index.html, public/theme-init.js
  src/App.tsx, src/components/*, src/api.ts, src/styles.css
config/escola.json   Regras da escola
scripts/     build.mjs (gera dist/public) e dev.mjs (modo de desenvolvimento)
tests/       Testes automáticos (node:test)
```

## Testes

```bash
npm run typecheck
npm test
```

Os testes cobrem as regras de reserva (inclusive a separação dos acervos por unidade), a API, as permissões, a proteção contra CSRF, 20 reservas
simultâneas no mesmo processo, 12 reservas simultâneas em **dois processos** no mesmo banco, e o
login Microsoft completo contra um provedor simulado. O teste do login confere PKCE, os papéis e a
recusa de tokens com nonce, audiência, locatário, emissor, validade ou assinatura errados, além de
state reutilizado e redirecionamento externo.

## Observações

- No Node 22 e 24, o `node:sqlite` ainda é marcado como experimental. Ele funciona e é testado
  aqui; o aviso é escondido com `--disable-warning=ExperimentalWarning` nos scripts.
- O sistema não envia e-mails nem lembretes.
- As regras da escola ficam num arquivo, não numa tela de administração.
