# Décio — Sistema Integrado da Montagem

Um único aplicativo, um único banco Postgres e um único login para os três sistemas do setor:

| # | Sistema | Rota | O que faz |
|---|---------|------|-----------|
| 01 | **Ponto NFC** | `/ponto` | Batida por crachá NFC ou seleção manual, com turno identificado automaticamente |
| 02 | **Cadenciador de Produção** | `/cadenciador` | Cadência por takt time, avisos de voz, parada de linha e painel de chão de fábrica |
| 03 | **ProGestão** | `/progestao` | Ferramentas, EPIs, banco de horas, treinamentos, diário de bordo, checklist e produção |

Tudo é configurado em um lugar só: **`/admin`** (Painel de Administração).

---

## O que mudou em relação aos três projetos originais

Os sistemas eram independentes e guardavam dados em lugares diferentes. Agora compartilham banco, login e turnos.

**Ponto NFC**
- Os 18 crachás deixaram de ser uma constante `COLLABORATOR_MAP` dentro do HTML e viraram cadastro no banco.
- Os registros saíram do `localStorage` do celular e vão para o Postgres — não se perdem ao limpar o navegador.
- A senha de administrador `"1234"` no código-fonte foi substituída pelo login com sessão e perfis.
- Cada batida grava o turno em que ocorreu e alterna entre entrada e saída.

**Cadenciador de Produção**
- Os 69 produtos e seus takt times saíram do array `PRODUTOS_PADRAO` e viraram cadastro editável.
- O turno deixou de ser fixo em `06:00–17:30`: agora vem do cadastro, e o takt pode ser diferente por turno.
- Os intervalos (café, almoço) são cadastráveis, com a frase do aviso de voz.
- Ciclos, observações e paradas de linha são gravados no banco — o relatório sobrevive a um F5.
- A senha `"producao2025"` no código foi substituída pelo login.
- O cálculo dos ciclos foi reescrito, mas produz **exatamente os mesmos horários** do algoritmo original (verificado nos 69 takts reais). A diferença é que passou a funcionar em turnos que viram a meia-noite.

**ProGestão**
- **Correções necessárias:** o `db.js` antigo criava tabelas com colunas que nenhuma rota usava (`colaboradores.matricula` vs `mat`, `ferramentas.codigo` vs `cod`, e assim por diante). O sistema quebrava no primeiro cadastro. O schema foi reescrito a partir das rotas reais.
- `GET /api/ferramentas/checklist` era capturado pela rota `/:id` e virava `WHERE id = 'checklist'`. Rota reordenada.
- As consultas de aniversariantes usavam `HAVING` sem `GROUP BY`, o que o Postgres rejeita. Reescritas com subquery.
- Layout retematizado com a identidade da Décio.

---

## Subir no GitHub

```bash
cd decio-sistema-integrado
git init
git add .
git commit -m "Sistema Integrado da Montagem"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/decio-sistema-integrado.git
git push -u origin main
```

O `.gitignore` já exclui `node_modules/` e `.env`. **Nunca faça commit do `.env`.**

---

## Publicar no Railway

**1. Criar o projeto**

No [railway.app](https://railway.app): *New Project* → *Deploy from GitHub repo* → escolha o repositório.

**2. Adicionar o Postgres**

No mesmo projeto: *New* → *Database* → *Add PostgreSQL*.

**3. Configurar as variáveis**

No serviço do app, aba *Variables*:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` ← referência ao banco, digite exatamente assim |
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | uma string longa e aleatória (veja abaixo) |
| `ADMIN_USER` | `admin` |
| `ADMIN_PASS` | a senha inicial do administrador |
| `ADMIN_NOME` | `Administrador` |
| `TZ` | `America/Sao_Paulo` |
| `SEED_ON_BOOT` | `true` |

Para gerar o `SESSION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`PORT` é injetada pelo Railway — não crie essa variável.

**4. Publicar**

O Railway detecta o `package.json` e roda `npm start`. No primeiro boot o app:
1. cria todas as tabelas (`db/schema.js`);
2. aplica migrações defensivas, se o banco já existia;
3. popula turnos, células, os 18 crachás, os 69 produtos e o usuário administrador (`db/seed.js`).

Depois vá em *Settings* → *Networking* → *Generate Domain*.

**5. Primeiro acesso**

Entre com `ADMIN_USER` / `ADMIN_PASS` e **troque a senha imediatamente** em *Administração → Usuários → Trocar senha*.

---

## Rodar na sua máquina

```bash
npm install
cp .env.example .env      # edite o DATABASE_URL
npm run dev
```

Acesse `http://localhost:3000`.

Para recriar tabelas e dados iniciais sem subir o servidor:
```bash
npm run db:seed
```

---

## Turnos: o eixo que liga os três sistemas

Um turno tem código, nome, hora de início, hora de fim, tolerância e uma lista de intervalos.

- **Ponto NFC** — descobre o turno pelo horário da batida. A *tolerância* é a margem, em minutos, para uma batida um pouco antes do início ainda contar naquele turno. Batida fora de qualquer turno ativo é registrada e sinalizada, não bloqueada.
- **Cadenciador** — calcula os ciclos entre o início e o fim do turno, pulando os intervalos. Se um turno rodar com equipe reduzida, cadastre um takt específico para ele em *Administração → Takt Times → Escopo: somente Turno X*.
- **ProGestão** — usa o turno do colaborador e nos apontamentos de produção.

Turnos que viram a meia-noite (ex.: `22:00 → 06:00`) precisam da opção **"Este turno vira a meia-noite"** marcada.

O seed cria o Turno 1 (`06:00–17:30`, com os três intervalos originais) ativo, e os Turnos 2 e 3 desativados como ponto de partida.

---

## Leitura NFC

A Web NFC API funciona no **Chrome para Android**, em conexão **HTTPS** (o domínio do Railway já é HTTPS). Em desktop e iOS o leitor não está disponível — a tela cai automaticamente para a batida manual, que pode ser desligada em *Administração → Parâmetros*.

O UID cadastrado precisa ser exatamente o que o aparelho lê. Se um crachá novo não for reconhecido, a tela mostra o UID lido na mensagem de erro: copie e cadastre em *Administração → Crachás NFC*.

---

## Estrutura

```
├── server.js                 Express: sessão, rotas, boot
├── db/
│   ├── index.js              pool do Postgres
│   ├── schema.js             schema completo + migrações idempotentes
│   └── seed.js               turnos, crachás, produtos, admin
├── lib/turnos.js             cálculo de ciclos e detecção de turno
├── middleware/auth.js        requireAuth / requireAdmin
├── routes/                   14 arquivos de API
└── public/
    ├── css/decio.css         design system da marca
    ├── js/core.js            API, avisos, cabeçalho, voz
    ├── login.html  index.html  admin.html
    ├── ponto.html  cadenciador.html
    └── progestao/            dashboard + 7 módulos
```

---

## Perfis de acesso

- **Administrador** — configura turnos, células, colaboradores, crachás, takt times, produtos, usuários e parâmetros.
- **Operação** — usa os três sistemas, cadastra colaboradores e lança dados, mas não altera a estrutura.

---

## Backup

O Railway faz snapshots do Postgres. Para um dump manual:

```bash
pg_dump "$DATABASE_URL" > backup_$(date +%F).sql
```

Cada módulo também exporta Excel: `/api/export/ponto`, `/api/export/crachas`, `/api/export/takt`, `/api/export/ciclos`, `/api/export/paradas`, `/api/export/colaboradores`, `/api/export/ferramentas`, `/api/export/epis`, e assim por diante.
