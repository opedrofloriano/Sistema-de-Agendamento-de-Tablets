# Agendamento de Tablets

Sistema para os professores das unidades **Castelo I** e **Castelo II** reservarem os tablets
da escola. **Cada unidade tem o próprio acervo** (hoje 30 tablets em cada uma), e a reserva de
uma unidade não ocupa tablets da outra. A regra central: **a soma das reservas da mesma unidade
que se sobrepõem nunca passa do acervo daquela unidade**, em nenhum minuto do intervalo.

- Interface em React + TypeScript (agenda semanal, visão por dia no celular, tema claro e escuro).
- Servidor em Node.js **sem dependências de produção**: só módulos do próprio Node.
- Banco SQLite num arquivo só (`node:sqlite`, embutido no Node).
- Login com a **conta Microsoft da escola** (Microsoft Entra ID, OpenID Connect).
- Papéis: **professor** (reserva no próprio nome e cancela as próprias reservas),
  **coordenação** (reserva em nome de qualquer professor, cancela qualquer reserva e vê o
  **Painel**) e **TI** (tudo da coordenação, mais a área técnica do Painel).
- **Painel** (aba ao lado da Agenda, só coordenação e TI): reservas, uso em tablets·hora e
  ocupação por unidade, comparados com o período anterior; horários e dias mais procurados;
  **% de uso por turma/sala e por professor**; reservas aguardando devolução; próximas reservas
  (com cancelamento); exportação em CSV. A TI vê também o registro de atividades, as pessoas que
  já entraram e a situação do servidor e do banco.
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

## Versão de demonstração (um arquivo HTML)

```bash
npm run build:demo
```

Gera `dist/agendamento-tablets-demo.html`, que abre direto no navegador, sem servidor. Usa as mesmas
telas e regras; só a camada de dados é trocada (`web/src/demo/api.demo.ts`): as reservas ficam no
navegador de quem abre e o login é simulado. Serve para apresentar o sistema, não para uso real.

## Publicar por fora, de graça (Render + Turso, modo piloto)

Para testar com professores antes da versão oficial, sem o login Microsoft e sem custo.
Cada pessoa entra com o **nome** e um **código de acesso** que a escola passa; a coordenação entra
com uma **senha** própria, e a TI com outra (opcional). O código e as senhas ficam só no servidor
(`ACCESS_CODE`, `COORDINATOR_PASSWORD` e `TI_PASSWORD`). Na tela de entrada há um único campo
"Sou da coordenação ou da TI": a senha digitada define o papel. Depois de 10 tentativas erradas, o mesmo endereço de internet fica
bloqueado por 15 minutos.

O servidor roda no plano grátis da [Render](https://render.com). Como esse plano apaga os arquivos
a cada reinício, as reservas ficam num banco SQLite gratuito na [Turso](https://turso.tech)
(variáveis `DATABASE_URL` e `DATABASE_AUTH_TOKEN`; sem elas, o sistema usa o arquivo local).

1. **Turso:** crie a conta, crie um banco (região mais próxima: AWS US East / Virginia), copie o
   endereço `libsql://…` e gere um token do banco.
2. **Render:** crie a conta entrando com o GitHub, use **New → Blueprint** e escolha este
   repositório. A Render lê o `render.yaml` e pede `ACCESS_CODE`, `COORDINATOR_PASSWORD`,
   `TI_PASSWORD`, `DATABASE_URL` e `DATABASE_AUTH_TOKEN`.
3. Em alguns minutos o sistema fica no ar em `https://<nome>.onrender.com`.

No plano grátis, o servidor "dorme" depois de 15 minutos sem acesso e o primeiro acesso seguinte
demora cerca de um minuto. Para evitar, um monitor gratuito (ex.: UptimeRobot) pode acessar
`/healthz` a cada 10 minutos. As reservas não se perdem quando o servidor dorme.

Para trocar o código ou a senha depois, mude as variáveis em **Environment** no painel da Render.

Alternativa paga, sem Turso: troque `plan: free` por `plan: 0.5c-512mb`, remova `DATABASE_URL` e
`DATABASE_AUTH_TOKEN` e acrescente ao serviço um disco e o caminho do banco:

```yaml
    disk: { name: dados, mountPath: /var/data, sizeGB: 1 }
    # e em envVars:  - key: DATABASE_PATH  /  value: /var/data/agendamento.db
```

Limitação do piloto: quem sabe o código pode entrar com qualquer nome. Para uso oficial, troque para
`AUTH_MODE=entra` (login Microsoft). As reservas feitas no piloto continuam no banco, mas ficam
ligadas ao nome usado no piloto, não à conta Microsoft.

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

   **Quem é da TI** funciona do mesmo jeito: App role `TI` (`ENTRA_TI_APP_ROLE`), grupos em
   `ENTRA_TI_GROUP_IDS` ou e-mails em `TI_EMAILS`. Quem tem os dois papéis entra como TI.
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
| `units` | Castelo I: 30, Castelo II: 30 | Cada unidade e o tamanho do acervo dela: `{ "name": "Castelo I", "tablets": 30 }`. Os acervos são independentes e podem ter tamanhos diferentes. |
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

SQLite em `DATABASE_PATH` (padrão `data/agendamento.db`), em modo WAL, ou na Turso quando
`DATABASE_URL` está definido (veja a seção do modo piloto). As tabelas são criadas e
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

As consultas estão em `server/db.ts` e a conexão em `server/sql.ts`, que já tem duas versões
(arquivo local e Turso) com a mesma interface `SqlDriver`. Para outro banco, crie uma terceira
versão dessa interface (ajustando o SQL de `db.ts` ao dialeto, se preciso) e garanta que
`transaction()` serialize as reservas que disputam o mesmo horário. Exemplos: `SELECT … WITH (UPDLOCK, HOLDLOCK)` no SQL Server, ou
`pg_advisory_xact_lock` por data no PostgreSQL. Os testes de `tests/` servem para conferir a troca.

## API

Todas as rotas `/api/*` exigem sessão. Sem sessão: `401`. Requisições que alteram dados (`POST`)
precisam do cabeçalho `X-Requested-With: agendamento` (proteção contra CSRF) e corpo JSON.
Datas e horas estão sempre no horário local da escola, no formato `AAAA-MM-DDTHH:MM:SS`.

| Método e rota | O que faz |
| --- | --- |
| `POST /auth/pilot-login` | Entrada do modo piloto (formulário: `name`, `code`, `coordPassword`). |
| `GET /api/me` | Usuário logado, papel, regras da escola e modo de login. |
| `GET /api/reservations?from=AAAA-MM-DD&to=AAAA-MM-DD` | Reservas que começam nesse intervalo (inclusive). |
| `GET /api/reservations?q=texto` | Busca por atividade, professor ou turma (até 50). |
| `GET /api/availability?unit=…&start=…&end=…` | `{ unit, free, total }`: tablets livres da unidade durante todo o intervalo. |
| `POST /api/reservations` | Cria. Corpo: `title, teacher, unit, className, quantity, date, startTime, endTime, notes`. |
| `POST /api/reservations/{id}/cancel` | Cancela (quem criou ou coordenação). |
| `POST /api/reservations/{id}/return` | Registra devolução (quem criou ou coordenação). |
| `GET /api/admin/stats?from=…&to=…&unit=…` | Estatísticas do Painel (coordenação e TI; período de até 1 ano). |
| `GET /api/admin/pending` | Reservas encerradas sem devolução registrada, últimos 60 dias (coordenação e TI). |
| `GET /api/admin/ti/audit?limit=…` | Registro de atividades (só TI). |
| `GET /api/admin/ti/users` | Pessoas que já entraram, com papel e total de reservas (só TI). |
| `GET /api/admin/ti/system` | Modo de login, tipo de banco, versão do Node, tempo no ar e totais (só TI). |

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
  stats.ts   Contas do Painel (tablets·hora, ocupação, % por turma/sala e professor)
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
  src/App.tsx, src/components/* (AdminPanel.tsx e charts.tsx = Painel), src/api.ts, src/styles.css
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
