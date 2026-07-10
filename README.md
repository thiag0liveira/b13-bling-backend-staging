# B13 Bebidas — Backend de integração com o Bling

Servidor que conecta o totem de pedidos ao Bling ERP (API v3, OAuth 2.0).

---

## Parte 1 — Criar o aplicativo no Bling (uma vez)

1. Entre no Bling com um usuário que tenha a permissão **"Cadastro de aplicativos"**
   (Preferências > Sistema > Usuários, se precisar criar/ativar essa permissão).
2. Vá em **⚙️ Configurações > Central de extensões > Área do integrador**.
3. Clique em **Criar novo aplicativo**.
4. Em **Tipo de aplicativo** escolha **API** e em uso escolha **Privado**. Avance.
5. Preencha:
   - **Nome / dados de contato** do aplicativo.
   - **URL de redirecionamento**: a URL pública do backend + `/callback`.
     - Teste local: `http://localhost:3000/callback`
     - Nuvem: `https://SEU-APP.up.railway.app/callback` (você terá essa URL na Parte 3)
6. Em **Lista de escopos**, adicione os escopos que vamos usar:
   - **Produtos** (leitura)
   - **Estoques** (leitura)
   - **Contatos** (leitura e escrita)
   - **Pedidos de venda** (leitura e escrita)
7. Salve. O Bling mostrará o **client_id** e o **client_secret** — guarde os dois.

> Limites da API: até 3 requisições por segundo e 120 mil por dia.

---

## Parte 2 — Rodar o backend (teste local primeiro)

Pré-requisito: Node.js 18 ou superior instalado.

```bash
cd bling-backend
npm install
cp .env.example .env      # no Windows: copy .env.example .env
```

Abra o `.env` e preencha `BLING_CLIENT_ID`, `BLING_CLIENT_SECRET` e
`BLING_REDIRECT_URI` (use `http://localhost:3000/callback` para teste local).

```bash
npm start
```

Agora conecte sua conta uma vez:

1. Abra no navegador: **http://localhost:3000/auth**
2. Faça login no Bling e **autorize** o aplicativo.
3. Você volta para uma tela "✅ Conta Bling conectada!".

Teste as rotas:
- http://localhost:3000/status  → deve dizer `conectado: true`
- http://localhost:3000/api/produtos  → lista seus produtos
- http://localhost:3000/api/contatos?doc=SEU_CNPJ  → busca contato por documento

Os tokens ficam salvos em `tokens.json` e se renovam sozinhos.

---

## Parte 3 — Hospedar (recomendado: Railway ou Render)

Por que nuvem e não o PC da loja: o login OAuth precisa de uma **URL pública com
HTTPS** para o redirecionamento, e o PC do totem pode estar desligado ou atrás do
roteador. Uma hospedagem simples resolve isso e fica sempre no ar.

Passos (Railway, exemplo):
1. Suba esta pasta para um repositório no GitHub.
2. Em railway.app, **New Project > Deploy from GitHub repo** e selecione o repositório.
3. Em **Variables**, cadastre `BLING_CLIENT_ID`, `BLING_CLIENT_SECRET` e
   `BLING_REDIRECT_URI` (agora com a URL pública, ex.: `https://SEU-APP.up.railway.app/callback`).
4. Railway te dá a URL pública. Volte no app do Bling e ajuste a
   **URL de redirecionamento** para exatamente essa URL + `/callback`.
5. Acesse `https://SEU-APP.up.railway.app/auth` e autorize novamente.

> Render funciona igual (New > Web Service > conecta o GitHub > Build `npm install`,
> Start `npm start`, cadastra as mesmas variáveis).

---

## Parte 4 — Ligar o totem (próximo passo, comigo)

Depois que as rotas acima responderem com seus dados reais, eu troco no totem:
- o catálogo de exemplo pela chamada a `GET /api/produtos` (com preço, estoque e imagem);
- a conciliação simulada pela chamada real a `GET /api/contatos?doc=...`;
- a finalização para chamar `POST /api/pedido`, gerando o pedido no Bling.

Me avise quando `/api/produtos` estiver listando seus produtos que seguimos daqui.
