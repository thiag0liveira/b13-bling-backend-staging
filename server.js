// =============================================================================
// B13 Bebidas — Backend de integração com o Bling ERP (API v3, OAuth 2.0)
// -----------------------------------------------------------------------------
// O que este servidor faz:
//   1) Faz o login OAuth 2.0 na sua conta Bling (fluxo Authorization Code).
//   2) Guarda os tokens em tokens.json e RENOVA sozinho quando expiram.
//   3) Expõe rotas de teste para o totem:
//        GET  /auth                 -> inicia o login no Bling
//        GET  /callback             -> recebe o código e salva os tokens
//        GET  /status               -> mostra se está conectado
//        GET  /api/produtos         -> lista produtos (com preço)
//        GET  /api/contatos?doc=... -> busca contato por CPF/CNPJ
//        POST /api/pedido           -> cria um pedido de venda
//
// Rode com:  npm install  &&  npm start
// Depois abra:  http://localhost:3000/auth   (autoriza a conta uma vez)
// =============================================================================

import express from "express";
import cors from "cors";
import fs from "fs";
import "dotenv/config"; // se preferir sem dotenv, exporte as variáveis no ambiente

const {
  BLING_CLIENT_ID,
  BLING_CLIENT_SECRET,
  BLING_REDIRECT_URI = "http://localhost:3000/callback",
  PORT = 3000,
} = process.env;

// URLs da API do Bling v3
const AUTH_URL = "https://www.bling.com.br/Api/v3/oauth/authorize";
const TOKEN_URL = "https://api.bling.com.br/Api/v3/oauth/token";
const API = "https://api.bling.com.br/Api/v3";

const TOKENS_FILE = "./tokens.json";
const app = express();
app.use(cors());
app.use(express.json());

// ------------------------- armazenamento simples de tokens -------------------
// (protótipo: arquivo local. Em produção troque por um banco de dados.)
function lerTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")); } catch { return null; }
}
function salvarTokens(t) {
  t.obtido_em = Date.now();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2));
}
function basicAuth() {
  return "Basic " + Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString("base64");
}

// troca o "authorization code" pelo access_token
async function trocarCodePorToken(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: BLING_REDIRECT_URI,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "1.0", Authorization: basicAuth() },
    body,
  });
  if (!r.ok) throw new Error("Falha ao obter token: " + (await r.text()));
  const t = await r.json();
  salvarTokens(t);
  return t;
}

// renova o token usando o refresh_token
async function renovarToken(refresh_token) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "1.0", Authorization: basicAuth() },
    body,
  });
  if (!r.ok) throw new Error("Falha ao renovar token: " + (await r.text()));
  const t = await r.json();
  salvarTokens(t);
  return t;
}

// devolve um access_token válido (renova se estiver perto de expirar)
async function getAccessToken() {
  let t = lerTokens();
  if (!t) throw new Error("Ainda não conectado ao Bling. Acesse /auth para autorizar.");
  const expiraEm = t.obtido_em + (t.expires_in - 60) * 1000; // 60s de margem
  if (Date.now() >= expiraEm) t = await renovarToken(t.refresh_token);
  return t.access_token;
}

// chamada genérica autenticada à API do Bling
async function bling(path, options = {}) {
  const token = await getAccessToken();
  const r = await fetch(API + path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", ...(options.headers || {}) },
  });
  const texto = await r.text();
  let json; try { json = texto ? JSON.parse(texto) : {}; } catch { json = { raw: texto }; }
  if (!r.ok) throw Object.assign(new Error("Erro Bling " + r.status), { status: r.status, body: json });
  return json;
}

// só dígitos do CPF/CNPJ
const soDigitos = (s) => (s || "").replace(/\D/g, "");

// ================================ ROTAS ======================================

// Início do login OAuth: manda o lojista autorizar a conta
app.get("/auth", (req, res) => {
  const url = `${AUTH_URL}?response_type=code&client_id=${BLING_CLIENT_ID}&state=b13${Date.now()}`;
  res.redirect(url);
});

// Callback: o Bling volta pra cá com ?code=...
app.get("/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Sem 'code' na URL.");
    await trocarCodePorToken(code);
    res.send("<h2>✅ Conta Bling conectada!</h2><p>Já pode fechar esta aba. Teste em <a href='/status'>/status</a> e <a href='/api/produtos'>/api/produtos</a>.</p>");
  } catch (e) {
    res.status(500).send("Erro no callback: " + e.message);
  }
});

// Status da conexão
app.get("/status", (req, res) => {
  const t = lerTokens();
  if (!t) return res.json({ conectado: false, dica: "Acesse /auth para conectar." });
  const restaSeg = Math.round((t.obtido_em + t.expires_in * 1000 - Date.now()) / 1000);
  res.json({ conectado: true, expira_em_segundos: restaSeg });
});

// Lista produtos (exemplo: página 1). Ajuste os filtros conforme a lista Atacado.
app.get("/api/produtos", async (req, res) => {
  try {
    const pagina = req.query.pagina || 1;
    const limite = req.query.limite || 100;
    const dados = await bling(`/produtos?pagina=${pagina}&limite=${limite}`);
    res.json(dados);
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// Busca contato por CPF/CNPJ (é aqui que acontece a conciliação automática)
app.get("/api/contatos", async (req, res) => {
  try {
    const doc = soDigitos(req.query.doc);
    if (!doc) return res.status(400).json({ erro: "Informe ?doc=CPF_ou_CNPJ" });
    const dados = await bling(`/contatos?pesquisa=${encodeURIComponent(doc)}`);
    // confere se algum contato retornado bate EXATAMENTE com o documento
    const lista = dados?.data || [];
    const achado = lista.find((c) => soDigitos(c.numeroDocumento) === doc) || null;
    res.json({ encontrado: !!achado, contato: achado, brutos: lista });
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// Cria um pedido de venda. Envie no corpo: { contatoId, itens:[{produtoId, quantidade, valor}] }
app.post("/api/pedido", async (req, res) => {
  try {
    const { contatoId, itens } = req.body;
    if (!contatoId || !Array.isArray(itens) || !itens.length)
      return res.status(400).json({ erro: "Envie { contatoId, itens:[{produtoId, quantidade, valor}] }" });
    const payload = {
      contato: { id: Number(contatoId) },
      itens: itens.map((i) => ({ produto: { id: Number(i.produtoId) }, quantidade: Number(i.quantidade), valor: Number(i.valor) })),
    };
    const dados = await bling(`/pedidos/vendas`, { method: "POST", body: JSON.stringify(payload) });
    res.json(dados);
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

app.get("/", (req, res) => res.send("B13 Bling Backend rodando. Comece em <a href='/auth'>/auth</a>."));

app.listen(PORT, () => console.log(`B13 Bling Backend em http://localhost:${PORT}`));
