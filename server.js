// =============================================================================
// B13 Bebidas — Backend de integração com o Bling ERP (API v3, OAuth 2.0)
// Versão 3 — persistência em DATA_DIR (Volume) + publicação da tabela + catálogo
// -----------------------------------------------------------------------------
// Rotas principais:
//   GET  /auth /callback /status         -> conexão com o Bling
//   GET  /api/produtos /categorias       -> dados do Bling
//   GET  /api/produto/:id  /api/raw      -> diagnóstico
//   GET  /api/buscar?nome=...            -> busca produtos por nome (vínculo)
//   POST /api/tabela                     -> RECEBE e guarda a tabela publicada
//   GET  /api/tabela                     -> devolve a tabela guardada
//   GET  /api/catalogo                   -> tabela + ESTOQUE/sabores do Bling (para o totem)
//   GET  /api/contatos?doc=...           -> concilia cliente por CPF/CNPJ
//   POST /api/pedido                     -> cria pedido de venda
// =============================================================================

import express from "express";
import cors from "cors";
import fs from "fs";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  BLING_CLIENT_ID, BLING_CLIENT_SECRET,
  BLING_REDIRECT_URI = "http://localhost:3000/callback",
  PORT = 3000, DATA_DIR = ".",
  GOOGLE_MAPS_KEY = "",
} = process.env;
const brlN = (n) => Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const AUTH_URL = "https://www.bling.com.br/Api/v3/oauth/authorize";
const TOKEN_URL = "https://api.bling.com.br/Api/v3/oauth/token";
const API = "https://api.bling.com.br/Api/v3";
const TOKENS_FILE = `${DATA_DIR}/tokens.json`;
const TABELA_FILE = `${DATA_DIR}/tabela.json`;
const PEND_FILE = `${DATA_DIR}/pendencias.json`;
const FUNC_FILE = `${DATA_DIR}/funcionarios.json`;
const SESSOES_FILE = `${DATA_DIR}/sessoes.json`;
const SEP_FILE  = `${DATA_DIR}/separacoes.json`;
const ACRS_FILE = `${DATA_DIR}/acrescimos.json`;
const PAG_FILE  = `${DATA_DIR}/pagamentos.json`;
const PIX_BANCOS_FILE = `${DATA_DIR}/pix_bancos.json`;
const LEDGER_FILE = `${DATA_DIR}/ledger-pagamentos.json`;
const LOG_FILE    = `${DATA_DIR}/log_pedidos.json`;
const PERDAS_FILE = `${DATA_DIR}/perdas.json`;
const CREDITOS_FILE = `${DATA_DIR}/creditos_clientes.json`;
const ENTREGAS_FILE = `${DATA_DIR}/entregas.json`;
const GTIN_INDEX_FILE = `${DATA_DIR}/gtin_index.json`;
const INSTAGRAM_CACHE_FILE = `${DATA_DIR}/instagram_cache.json`;
const EMDIG_TRACK_FILE = `${DATA_DIR}/em_digitacao_track.json`;
const FPAG_FILE = `${DATA_DIR}/formas_pagamento.json`;
const CAIXA_SESSOES_FILE = `${DATA_DIR}/caixa_sessoes.json`;
const LISTA_FARDO_FILE = `${DATA_DIR}/lista_fardo.json`;
const LISTAS_EXTRAS_FILE = `${DATA_DIR}/listas_extras.json`;
const PROPOSTAS_FILE = `${DATA_DIR}/propostas_atacado.json`;
const PROSPECCAO_FILE = `${DATA_DIR}/prospeccao.json`; // histórico de contatos + clientes ignorados
const NFCE_EMITIDAS_FILE = `${DATA_DIR}/nfce_emitidas.json`; // {pedidoId:{idNotaFiscal,numero,link,em,por}} — controle de quais pedidos já tiveram NFC-e
const ENTRADAS_CACHE_FILE = `${DATA_DIR}/entradas_cache.json`; // {mes:{status,calculadoEm,comNF,semPapel,totalCompras,processadas}} — relatório de entradas por produto
const AVISOS_FILE = `${DATA_DIR}/avisos.json`; // painel de avisos do sistema (falhas, auto-correções de estoque, divergências) pra conferência
const METAS_FILE = `${DATA_DIR}/metas.json`; // meta de venda por mês {"2026-08":50000}
const ROTAS_CONFIG_FILE = `${DATA_DIR}/rotas_config.json`; // dias de entrega + carros disponíveis
const ROTAS_DIAS_FILE = `${DATA_DIR}/rotas_dias.json`; // atribuição de pedidos a carros por dia
const ROTAS_ATRASOS_FILE = `${DATA_DIR}/rotas_atrasos.json`; // pedidos entregues em dia diferente do planejado na rota
const FPAG_DEFAULT=[
  {id:1,nome:"Dinheiro"},{id:2,nome:"PIX"},{id:3,nome:"Cartão de Crédito"},
  {id:4,nome:"Cartão de Débito"},{id:5,nome:"Transferência"},{id:6,nome:"Boleto"},
];

// IDs dos status — configurados via variáveis de ambiente ou padrões existentes
const SIT = {
  EM_ABERTO:    Number(process.env.SIT_EM_ABERTO    || 6),
  EM_DIGITACAO: Number(process.env.SIT_EM_DIGITACAO || 21),
  AGUARDANDO:   Number(process.env.SIT_AGUARDANDO   || 818795),
  EM_SEP:       Number(process.env.SIT_EM_SEP       || 817963),
  SEPARADO:     Number(process.env.SIT_SEPARADO     || 821590),
  SEP_PEND:     Number(process.env.SIT_SEP_PEND     || 819227),
  CONF_ENTREGA: Number(process.env.SIT_CONF_ENTREGA || 821611),
  VERIFICADO:   Number(process.env.SIT_VERIFICADO   || 24),
  EM_ROTA:      Number(process.env.SIT_EM_ROTA      || 820085),
  ATENDIDO:     Number(process.env.SIT_ATENDIDO     || 9),
  CANCELADO:    Number(process.env.SIT_CANCELADO    || 12),
};

const app = express();
const _iniciadoEm=new Date().toISOString();
app.get("/api/versao-deploy",(req,res)=>res.json({iniciadoEm:_iniciadoEm,agora:new Date().toISOString(),marcador:"nfce-fix-itens-data-v1"}));
const ORIGENS_PERMITIDAS=[
  "https://b13-bling-backend-production.up.railway.app",
  "https://b13-bling-backend-staging-production.up.railway.app",
  "https://app.b13bebidas.com.br",
  "http://localhost:3000","http://127.0.0.1:3000",
];

// ---- Rate limiter simples em memória (protege endpoints sensíveis de raspagem) ----
const _rateHits={}; // { chave: [timestamps] }
function rateLimit({janelaMs,max,prefixo}){
  return (req,res,next)=>{
    const ip=(req.headers["x-forwarded-for"]||"").split(",")[0].trim()||req.socket?.remoteAddress||"?";
    const chave=`${prefixo}:${ip}`;
    const agora=Date.now();
    const hits=(_rateHits[chave]||[]).filter(t=>agora-t<janelaMs);
    if(hits.length>=max){
      return res.status(429).json({erro:"Muitas requisições. Aguarde um momento e tente novamente."});
    }
    hits.push(agora); _rateHits[chave]=hits;
    next();
  };
}
// limpeza periódica pra não acumular memória
setInterval(()=>{ const agora=Date.now(); for(const k in _rateHits){ _rateHits[k]=_rateHits[k].filter(t=>agora-t<600000); if(!_rateHits[k].length) delete _rateHits[k]; } }, 300000);
app.use(cors({
  origin(origin,cb){
    // requisições sem "origin" (apps mobile, curl, mesma origem) sempre passam
    if(!origin||ORIGENS_PERMITIDAS.includes(origin)) return cb(null,true);
    cb(new Error("Origem não permitida por CORS"));
  },
}));
app.use(express.json({ limit: "5mb" }));

// Headers de segurança básicos em todas as respostas. Protegem contra:
// - clickjacking (X-Frame-Options): impede que o site seja embutido em iframe de
//   outro domínio pra enganar o usuário. SAMEORIGIN pra não quebrar o /caixa, que
//   embute o /operacional via iframe no mesmo domínio.
// - MIME sniffing (X-Content-Type-Options): navegador respeita o content-type.
// - vazamento de URL (Referrer-Policy): não manda a URL cheia pra outros sites.
app.use((req,res,next)=>{
  res.set("X-Content-Type-Options","nosniff");
  res.set("X-Frame-Options","SAMEORIGIN");
  res.set("Referrer-Policy","strict-origin-when-cross-origin");
  next();
});

// nunca deixa o navegador cachear respostas de API — já pegamos esse bug 2x
// (nav.js e /api/vendedor/meta) onde um funcionario via dado desatualizado
// simplesmente por causa do cache do navegador, nao um bug de logica.
app.use((req,res,next)=>{
  if(req.path.startsWith("/api/")) res.set("Cache-Control","no-store, no-cache, must-revalidate");
  next();
});

// ------------------------- tokens -------------------------
function lerTokens(){ try{ return JSON.parse(fs.readFileSync(TOKENS_FILE,"utf8")); }catch{ return null; } }
function salvarTokens(t){ t.obtido_em=Date.now(); fs.writeFileSync(TOKENS_FILE, JSON.stringify(t,null,2)); }
function basicAuth(){ return "Basic "+Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString("base64"); }

async function trocarCodePorToken(code){
  const body=new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:BLING_REDIRECT_URI});
  const r=await fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"1.0",Authorization:basicAuth()},body});
  if(!r.ok) throw new Error("Falha ao obter token: "+(await r.text()));
  const t=await r.json(); salvarTokens(t); return t;
}
async function renovarToken(refresh_token){
  const body=new URLSearchParams({grant_type:"refresh_token",refresh_token});
  const r=await fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"1.0",Authorization:basicAuth()},body});
  if(!r.ok) throw new Error("Falha ao renovar token: "+(await r.text()));
  const t=await r.json(); salvarTokens(t); return t;
}
async function getAccessToken(){
  let t=lerTokens();
  if(!t) throw new Error("Ainda não conectado ao Bling. Acesse /auth para autorizar.");
  if(Date.now() >= t.obtido_em+(t.expires_in-60)*1000) t=await renovarToken(t.refresh_token);
  return t.access_token;
}
async function blingRaw(path,options={},_tentativa=0){
  const token=await getAccessToken();
  const ctrl=new AbortController();
  const timeout=setTimeout(()=>ctrl.abort(),30000); // 30s timeout
  try{
    const r=await fetch(API+path,{...options,signal:ctrl.signal,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json",...(options.headers||{})}});
    clearTimeout(timeout);
    const txt=await r.text(); let j; try{ j=txt?JSON.parse(txt):{}; }catch{ j={raw:txt}; }
    if(r.status===429&&_tentativa<8){
      // limite de requisições do Bling — espera com backoff crescente e tenta de novo
      await new Promise(res=>setTimeout(res,1200*(_tentativa+1)));
      return blingRaw(path,options,_tentativa+1);
    }
    if(!r.ok){
      // o Bling 400 costuma trazer o detalhe real (qual campo falhou) em error.fields
      // ou em error.details — a mensagem de topo é genérica ("problemas na validação")
      let motivo=j?.error?.description||j?.error?.message||(Array.isArray(j?.errors)?j.errors.map(x=>x.msg||x.message).join("; "):null);
      const campos=j?.error?.fields||j?.error?.details||j?.fields;
      if(Array.isArray(campos)&&campos.length){
        const det=campos.map(f=>{
          const nome=f.element||f.field||f.campo||f.name||"";
          const msg=f.msg||f.message||f.descricao||f.description||"";
          return [nome,msg].filter(Boolean).join(": ");
        }).filter(Boolean).join(" | ");
        if(det) motivo=(motivo?motivo+" — ":"")+det;
      }
      if(!motivo) motivo=JSON.stringify(j).slice(0,300);
      throw Object.assign(new Error(`Erro Bling ${r.status}: ${motivo}`),{status:r.status,body:j});
    }
    return j;
  }catch(e){ clearTimeout(timeout); throw e; }
}
// Fila global: TODAS as chamadas ao Bling do sistema (não importa de qual endpoint/
// tela vieram) passam por aqui, uma de cada vez, com espaçamento mínimo garantido.
// Isso evita que dois processos concorrentes (ex: fechamento de caixa rodando +
// em digitação atualizando sozinho) somem chamadas e estourem o limite do Bling.
const BLING_INTERVALO_MIN=340; // ms entre quaisquer duas chamadas ao Bling (~2,9/s, o limite documentado é 3/s)
let _blingUltimaChamada=0;
// FILA COM PRIORIDADE: operações do caixa/POS (finalizar venda, editar pagamento,
// consultar preço na hora) são "alta" e sempre passam na frente. Tarefas de fundo
// pesadas (Central, Auditoria, Entradas, reconstrução de índice) são "baixa" e só
// avançam quando não há nada de alta prioridade esperando — assim elas nunca mais
// deixam o caixa "preso em Processando..." esperando atrás de uma varredura.
let _filaAlta=[], _filaBaixa=[], _blingProcessando=false;
function _blingAgendar(){
  if(_blingProcessando) return;
  _blingProcessando=true;
  _blingProcessarProximo();
}
async function _blingProcessarProximo(){
  const item=_filaAlta.shift()||_filaBaixa.shift();
  if(!item){ _blingProcessando=false; return; }
  const espera=Math.max(0,_blingUltimaChamada+BLING_INTERVALO_MIN-Date.now());
  if(espera>0) await new Promise(r=>setTimeout(r,espera));
  _blingUltimaChamada=Date.now();
  try{ const r=await blingRaw(item.path,item.options); item.resolve(r); }
  catch(e){ item.reject(e); }
  _blingProcessarProximo();
}
function bling(path,options={},prioridade="alta"){
  return new Promise((resolve,reject)=>{
    (prioridade==="baixa"?_filaBaixa:_filaAlta).push({path,options,resolve,reject});
    _blingAgendar();
  });
}
function blingLento(path,options={}){ return bling(path,options,"baixa"); } // uso: tarefas de fundo (nunca o caixa)
const soDigitos=(s)=>(s||"").replace(/\D/g,"");
// monta o bloco de endereço de entrega no formato que o Bling realmente usa —
// descobrimos (endereço sumindo mesmo com o campo certo preenchido) que a seção
// "Endereço de entrega" da tela do Bling corresponde ao objeto `etiqueta` dentro
// de `transporte` (tem até campo "nome" = nome da etiqueta, que bate com o que
// aparecia na tela). Manda os dois formatos (etiqueta + enderecoEntrega) pra
// cobrir qualquer versão da API sem depender de 100% de certeza no schema.
function montarBlocoEnderecoEntrega(end,nomeDestinatario){
  end=end||{};
  const bloco={
    endereco: end.rua||end.endereco||"",
    numero: end.numero||"S/N",
    complemento: end.complemento||"",
    bairro: end.bairro||"",
    cep: end.cep||"",
    municipio: end.cidade||end.municipio||"Belo Horizonte",
    uf: end.uf||"MG",
    pais: end.pais||"Brasil",
  };
  return { enderecoEntrega:bloco, etiqueta:{ nome:nomeDestinatario||"", ...bloco } };
}
// data (AAAA-MM-DD) no fuso do Brasil (UTC-3, sem horário de verão) — usa isso em vez de
// toISOString().slice(0,10) sempre que for guardar "o dia de hoje/desse timestamp",
// senão à noite (depois das 21h BRT) o UTC já vira o dia seguinte e as datas ficam erradas
const dataBR=(quando)=>new Date((quando?new Date(quando).getTime():Date.now())-3*60*60*1000).toISOString().slice(0,10);
// formata telefone/celular no padrão que o Bling exige pra validar o contato;
// se não tiver DDD+número válido (10 ou 11 dígitos), retorna vazio em vez de
// mandar algo torto que derruba a criação/atualização do contato inteiro
function formatarTelefoneBling(tel){
  let d=soDigitos(tel);
  // remove o "55" do Brasil se veio junto (comum quando o número é copiado
  // do WhatsApp com o +55 na frente) — senão o número fica com 12/13 dígitos
  // e é descartado silenciosamente por não bater 10 nem 11
  if((d.length===12||d.length===13) && d.startsWith("55")) d=d.slice(2);
  if(d.length===11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if(d.length===10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  if(tel) console.warn(`formatarTelefoneBling: número não reconhecido (${d.length} dígitos), não vai ser salvo:`,tel);
  return "";
}

// contato genérico para pedidos sem identificação (CONSUMIDOR FINAL)
let _contatoPadrao=null;
async function getContatoPadrao(){
  if(_contatoPadrao) return _contatoPadrao;
  if(process.env.BLING_CONTATO_PADRAO_ID){ _contatoPadrao=Number(process.env.BLING_CONTATO_PADRAO_ID); return _contatoPadrao; }
  try{
    const b=await bling(`/contatos?pesquisa=${encodeURIComponent("CONSUMIDOR FINAL")}`);
    const achado=(b.data||[]).find(c=>(c.nome||"").toUpperCase().includes("CONSUMIDOR FINAL"));
    if(achado){ _contatoPadrao=achado.id; return _contatoPadrao; }
  }catch(e){}
  const novo=await bling(`/contatos`,{method:"POST",body:JSON.stringify({nome:"CONSUMIDOR FINAL", tipo:"F", situacao:"A"})});
  _contatoPadrao=novo?.data?.id; return _contatoPadrao;
}

// ------- vendedores ATIVOS (o Bling recusa a venda se o vendedor estiver inativo) -------
// Mantém uma lista dos vendedores ativos em cache (5 min). Usada para garantir que
// toda venda saia com um vendedor ATIVO — se o vendedor do operador (ou o padrão da
// conta) estiver inativo, o Bling barra com "Vendedor inativo". Tirar o vendedor não
// resolve, porque aí o Bling usa o vendedor padrão da conta, que também pode estar inativo.
let _vendAtivosCache=null, _vendAtivosEm=0;
// mapa id->nome de TODOS os vendedores (ativos e inativos) — usado pra resolver o nome
// do vendedor nos pedidos, já que /pedidos/vendas só traz o id do vendedor, não o nome.
let _mapaVendCache=null, _mapaVendEm=0;
async function mapaVendedores(){
  if(_mapaVendCache && (Date.now()-_mapaVendEm)<5*60*1000) return _mapaVendCache;
  const mapa={};
  try{
    for(let pag=1;pag<=5;pag++){
      const r=await bling(`/vendedores?pagina=${pag}&limite=100`).catch(()=>null);
      const arr=r?.data||[];
      arr.forEach(v=>{ mapa[String(v.id)]=v.contato?.nome||v.nome||("Vendedor "+v.id); });
      if(arr.length<100) break; await sleep(150);
    }
  }catch(e){}
  if(Object.keys(mapa).length){ _mapaVendCache=mapa; _mapaVendEm=Date.now(); }
  return _mapaVendCache||mapa;
}

async function listaVendedoresAtivos(){
  if(_vendAtivosCache && (Date.now()-_vendAtivosEm) < 5*60*1000) return _vendAtivosCache;
  const ativos=[];
  try{
    for(let pag=1;pag<=5;pag++){
      const r=await bling(`/vendedores?pagina=${pag}&limite=100`).catch(()=>null);
      const arr=r?.data||[];
      arr.forEach(v=>{
        const ativo = v.situacao==="A" || v.situacao===1 || v.situacao===true;
        if(ativo) ativos.push({id:v.id, nome:v.contato?.nome||v.nome||("Vendedor "+v.id)});
      });
      if(arr.length<100) break;
      await sleep(250);
    }
  }catch(e){ console.error("Falha ao listar vendedores ativos:",e.message); }
  if(ativos.length){ _vendAtivosCache=ativos; _vendAtivosEm=Date.now(); }
  return ativos;
}
// Devolve um ID de vendedor ATIVO. Preferência: o preferido (ex.: vendedor do operador)
// se ativo -> o padrão do .env se ativo -> o primeiro vendedor ativo encontrado.
// Se não conseguir listar os vendedores (erro/rede), devolve o preferido sem alterar.
async function vendedorAtivoId(preferidoId){
  const ativos=await listaVendedoresAtivos();
  if(!ativos.length) return preferidoId!=null ? Number(preferidoId) : (Number(process.env.BLING_VENDEDOR_ID)||null);
  const ok=id=> id!=null && ativos.some(v=>String(v.id)===String(id));
  if(ok(preferidoId)) return Number(preferidoId);
  const env=Number(process.env.BLING_VENDEDOR_ID)||null;
  if(ok(env)) return env;
  return ativos[0].id;
}

// ------------------------- OAuth -------------------------
app.get("/auth",(req,res)=> res.redirect(`${AUTH_URL}?response_type=code&client_id=${BLING_CLIENT_ID}&state=b13${Date.now()}`));
app.get("/logo",(req,res)=>res.sendFile(path.join(__dirname,"logo.png")));
app.get("/loja-fundo",(req,res)=>res.sendFile(path.join(__dirname,"loja-fundo.png")));
app.get("/logo-ofertas",(req,res)=>res.sendFile(path.join(__dirname,"logo-ofertas.jpg")));
app.use("/promo", express.static(path.join(__dirname, "promo"))); // imagens promocionais fixas (splash do totem)

// ---- Comprovantes de conferência (foto/vídeo) — salvos como arquivo real no volume, nunca em base64 no JSON de log ----
const COMPROVANTES_DIR = `${DATA_DIR}/comprovantes`;
try { fs.mkdirSync(COMPROVANTES_DIR, { recursive: true }); } catch (e) {}
app.use("/comprovantes", express.static(COMPROVANTES_DIR));
function extPorMime(mime) {
  mime = String(mime || "").toLowerCase();
  if (mime.indexOf("webm") >= 0) return "webm";
  if (mime.indexOf("mp4") >= 0) return "mp4";
  if (mime.indexOf("quicktime") >= 0 || mime.indexOf("mov") >= 0) return "mov";
  if (mime.indexOf("png") >= 0) return "png";
  if (mime.indexOf("webp") >= 0) return "webp";
  return "jpg";
}
app.post("/api/comprovante/:id", express.json({ limit: "25mb" }), (req, res) => {
  try {
    const { dataUrl, tipo, funcionarioId, funcionarioNome, evento } = req.body || {};
    if (!dataUrl || typeof dataUrl !== "string") return res.status(400).json({ erro: "dataUrl obrigatório" });
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ erro: "dataUrl inválido" });
    const mime = m[1]; const b64 = m[2];
    const buf = Buffer.from(b64, "base64");
    const ext = extPorMime(mime);
    const nomeArq = `${req.params.id}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(COMPROVANTES_DIR, nomeArq), buf);
    const url = `/comprovantes/${nomeArq}`;
    addLog(req.params.id, evento || "comprovante_conferencia", funcionarioId, funcionarioNome, { tipo: tipo || (ext === "jpg" || ext === "png" || ext === "webp" ? "foto" : "video"), url, mime });
    res.json({ ok: true, url });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
app.get("/musica-fundo",(req,res)=>{
  const arq=path.join(__dirname,"musica-fundo.mp3");
  if(!fs.existsSync(arq)) return res.status(404).send("Música de fundo ainda não configurada");
  res.sendFile(arq);
});
app.get("/login",(req,res)=>res.sendFile(path.join(__dirname,"login.html")));
app.get("/nav.js",(req,res)=>{
  res.setHeader("Content-Type","application/javascript");
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate");
  res.send(`
// B13 Nav — módulo de autenticação compartilhado
const B13_BACKEND="${process.env.RAILWAY_PUBLIC_DOMAIN?'https://'+process.env.RAILWAY_PUBLIC_DOMAIN:''}";
const B13_SIT={AGUARDANDO:${SIT.AGUARDANDO},EM_SEP:${SIT.EM_SEP},SEP_PEND:${SIT.SEP_PEND},SEPARADO:${SIT.SEPARADO},CONF_ENTREGA:${SIT.CONF_ENTREGA},VERIFICADO:${SIT.VERIFICADO}};

function b13GetSession(){ try{ const s=sessionStorage.getItem("b13sess")||localStorage.getItem("b13sess"); if(s){ sessionStorage.setItem("b13sess",s); return JSON.parse(s); } return null; }catch(e){ return null; } }
function b13SetSession(f){ try{ sessionStorage.setItem("b13sess",JSON.stringify(f)); }catch(e){} }
function b13ClearSession(){ try{ sessionStorage.removeItem("b13sess"); }catch(e){} }
function b13Pode(acao){
  const f=b13GetSession(); if(!f) return false;
  const n=f.permissoes||[f.nivel];
  return b13PodeComPermissoes(acao,n);
}
function b13PodeComPermissoes(acao,n){
  n=n||[];
  if(n.includes("admin")) return true;
  if(n.includes(acao)) return true; // permissão granular marcada diretamente pro funcionário
  const mapa={
    ver_aguardando:["financeiro_atacado","vendedor","gerente"],
    receber_pagamento:["financeiro_atacado"],
    enviar_separacao:["financeiro_atacado","vendedor","gerente"],
    ver_separacao:["expedicao","gerente"],
    ver_pend:["conferente","gerente"],
    ver_separado:["conferente","gerente"],
    conferir:["conferente","gerente"],
    editar_pedido:["gerente"],
    ver_dashboard:["gerente"],
    ver_funcionarios:["admin"],
    ver_listas:["gerente","admin"],
  };
  return (mapa[acao]||[]).some(x=>n.includes(x));
}
function b13RequireLogin(){ if(!b13GetSession()){ location.href="/login?next="+encodeURIComponent(location.pathname); return false; } return true; }
// checa se o funcionário logado tem acesso a uma aba específica, usando a
// MESMA lista/regras do menu lateral — fonte única de verdade
function b13PodeAba(href){
  const l=(window.B13_NAV_LINKS||[]).find(x=>x.href===href);
  if(!l) return true; // aba não cadastrada na lista: não bloqueia (evita travar telas fora do menu, tipo /login)
  return l.acoes.some(a=>b13Pode(a));
}
// bloqueia a página inteira com uma mensagem de acesso negado se a aba não for permitida.
// Uso: no topo de cada página, logo depois do require de login:
//   if(!b13RequireLogin()) return;
//   if(!b13BloquearSeSemAcesso("/caixa")) return;
function b13BloquearSeSemAcesso(href){
  if(b13PodeAba(href)) return true;
  document.addEventListener("DOMContentLoaded",function(){
    document.body.innerHTML=\`
      <style>
        @media (min-width:769px){
          body > *:not(#b13nav):not(button[onclick="b13ToggleNav()"]):not(#b13navOverlay){ margin-left:200px }
        }
      </style>
      \${(typeof b13RenderNav==="function")?b13RenderNav(href):""}
      <div style="max-width:420px;margin:20vh auto;text-align:center;color:#fff;font-family:Arial;padding:0 16px">
        <div style="font-size:40px;margin-bottom:10px">🚫</div>
        <h2>Acesso negado</h2>
        <p style="color:#9a95c9">Seu usuário não tem permissão para acessar esta página.</p>
        <a href="/operacional" style="color:#FF0082">← Voltar</a>
      </div>\`;
  });
  window.__b13SemAcesso=true;
  return false;
}
function b13Logout(){ b13ClearSession(); location.href="/login"; }

// Lista única das "abas" do sistema — usada pra montar o menu lateral E pra
// mostrar no cadastro de Funcionários quais abas cada permissão libera.
window.B13_NAV_LINKS=[
  // grupo:"" (ou ausente) = link solto no topo. Os demais viram seções recolhíveis.
  {href:"/central",label:"🏠 Central",acoes:["acesso_central"]},
  {href:"/avisos",label:"🔔 Avisos",acoes:["acesso_avisos"]},
  {href:"/operacional",label:"⚙️ Operacional",acoes:["acesso_operacional","ver_aguardando","ver_separacao","conferir"]},
  {href:"/pedidos-online",label:"🛒 Pedidos",acoes:["acesso_pedidos_online"]},
  {href:"/painel-pedidos",label:"📺 Painel de Pedidos",acoes:["acesso_painel_pedidos","ver_aguardando","ver_separacao","conferir"]},

  {grupo:"Vendas & Caixa",href:"/frente-caixa",label:"🧾 Frente de Caixa",acoes:["acesso_frente_caixa","receber_pagamento"]},
  {grupo:"Vendas & Caixa",href:"/caixa-atacado",label:"🧾 Caixa Atacado",acoes:["acesso_caixa_atacado","receber_pagamento"]},
  {grupo:"Vendas & Caixa",href:"/venda-atacado",label:"🛒 Venda Atacado",acoes:["acesso_venda_atacado","receber_pagamento","editar_pedido"]},
  {grupo:"Vendas & Caixa",href:"/propostas",label:"📄 Propostas",acoes:["acesso_propostas","receber_pagamento","editar_pedido"]},
  {grupo:"Vendas & Caixa",href:"/caixa",label:"💳 Caixa",acoes:["acesso_caixa","receber_pagamento"]},
  {grupo:"Vendas & Caixa",href:"/gestao-caixas",label:"🗃️ Gestão de Caixas",acoes:["acesso_gestao_caixas"]},
  {grupo:"Vendas & Caixa",href:"/gestao-nfce",label:"🧾 Gestão de NFC-e",acoes:["acesso_gestao_nfce"]},

  {grupo:"Estoque",href:"/estoque",label:"📦 Estoque (painel)",acoes:["acesso_estoque_painel"]},
  {grupo:"Estoque",href:"/estoque-simples",label:"⚡ Ajuste rápido",acoes:["acesso_estoque"]},
  {grupo:"Estoque",href:"/entrada-estoque",label:"📥 Entrada de Estoque",acoes:["acesso_entrada_estoque"]},
  {grupo:"Estoque",href:"/entradas",label:"🧾 Entradas NF / Sem papel",acoes:["acesso_entradas_nf"]},
  {grupo:"Estoque",href:"/movimentacoes",label:"🔄 Movimentações",acoes:["acesso_movimentacoes","editar_pedido","admin"]},

  {grupo:"Listas & Imagens",href:"/imagens",label:"📷 Imagens",acoes:["acesso_imagens","admin"]},
  {grupo:"Listas & Imagens",href:"/listas-extras",label:"📂 Listas Extras",acoes:["acesso_listas_extras","editar_pedido"]},
  {grupo:"Listas & Imagens",href:"/listas",label:"📄 Listas de Preço",acoes:["acesso_listas_preco","ver_listas"]},
  {grupo:"Listas & Imagens",href:"/lista-fardo",label:"📋 Lista de Fardos",acoes:["acesso_lista_fardo","editar_pedido"]},
  {grupo:"Listas & Imagens",href:"/etiquetas",label:"🏷 Etiquetas",acoes:["acesso_etiquetas","editar_pedido"]},
  {grupo:"Listas & Imagens",href:"/tabela-atacado",label:"🗂️ Tabela Atacado",acoes:["acesso_tabela","ver_listas"]},

  {grupo:"Logística",href:"/expedicao",label:"🚚 Expedição",acoes:["acesso_expedicao","ver_separacao"]},
  {grupo:"Logística",href:"/mesa-separacao",label:"🖥️ Mesa de Separação",acoes:["acesso_mesa_separacao"]},
  {grupo:"Logística",href:"/conferencia",label:"🔍 Conferência",acoes:["acesso_conferencia","conferir"]},
  {grupo:"Logística",href:"/rotas",label:"🗺️ Gerenciamento de Rota",acoes:["acesso_rotas","editar_pedido"]},

  {grupo:"Gestão",href:"/dashboard",label:"📊 Dashboard",acoes:["acesso_dashboard","ver_dashboard"]},
  {grupo:"Gestão",href:"/perdas",label:"📉 Perdas",acoes:["acesso_perdas","ver_dashboard"]},
  {grupo:"Gestão",href:"/vendedor",label:"🎯 Apoio ao Vendedor",acoes:["acesso_vendedor","receber_pagamento","editar_pedido"]},
  {grupo:"Gestão",href:"/gestao",label:"📋 Gestão",acoes:["acesso_gestao","editar_pedido"]},
  {grupo:"Gestão",href:"/funcionarios",label:"👥 Funcionários",acoes:["ver_funcionarios"]},
];

// monta o menu: links soltos no topo e o resto em seções recolhíveis (a seção da
// página atual já abre aberta; o estado fica salvo por usuário no navegador)
function b13NavHtml(links,ativo){
  const item=(l)=>\`<a href="\${l.href}" style="display:flex;align-items:center;gap:8px;padding:10px 14px;color:\${l.href===ativo?'#fff':'#cfc9f5'};text-decoration:none;font-weight:700;font-size:13px;border-left:3px solid \${l.href===ativo?'#FF0082':'transparent'};background:\${l.href===ativo?'rgba(255,0,130,.1)':'transparent'}">\${l.label}</a>\`;
  const soltos=links.filter(l=>!l.grupo);
  const grupos=[];
  links.filter(l=>l.grupo).forEach(l=>{ let g=grupos.find(x=>x.nome===l.grupo); if(!g){ g={nome:l.grupo,itens:[]}; grupos.push(g); } g.itens.push(l); });
  let abertos={};
  try{ abertos=JSON.parse(localStorage.getItem("b13navAbertos")||"{}"); }catch(e){}
  return soltos.map(item).join("")+grupos.map(g=>{
    const temAtivo=g.itens.some(l=>l.href===ativo);
    const aberto=temAtivo||abertos[g.nome]===true;
    return \`<div>
      <div onclick="b13ToggleGrupo('\${g.nome}')" style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;margin-top:4px;color:#9a95c9;font-size:11px;font-weight:900;text-transform:uppercase;cursor:pointer;letter-spacing:.5px">
        <span>\${g.nome}</span><span id="b13gseta-\${g.nome.replace(/[^a-zA-Z]/g,'')}" style="font-size:10px">\${aberto?'▾':'▸'}</span>
      </div>
      <div id="b13grupo-\${g.nome.replace(/[^a-zA-Z]/g,'')}" style="display:\${aberto?'block':'none'}">\${g.itens.map(item).join("")}</div>
    </div>\`;
  }).join("");
}
function b13ToggleGrupo(nome){
  const k=nome.replace(/[^a-zA-Z]/g,'');
  const el=document.getElementById("b13grupo-"+k), seta=document.getElementById("b13gseta-"+k);
  if(!el) return;
  const abrir=el.style.display==="none";
  el.style.display=abrir?"block":"none";
  if(seta) seta.textContent=abrir?"▾":"▸";
  try{ const a=JSON.parse(localStorage.getItem("b13navAbertos")||"{}"); a[nome]=abrir; localStorage.setItem("b13navAbertos",JSON.stringify(a)); }catch(e){}
}

// ---- sino de novos pedidos do totem/site (a marca "já vi" é POR USUÁRIO) ----
let _b13SinoTimer=null;
async function b13ChecarNovosPedidos(){
  const f=b13GetSession(); if(!f) return;
  try{
    const j=await fetch(B13_BACKEND+"/api/pedidos-online/novos/"+encodeURIComponent(f.id)).then(r=>r.json());
    const el=document.getElementById("b13sino"), bd=document.getElementById("b13sinoBadge");
    if(!el||!bd) return;
    window._b13Novos=j;
    if(j.novos>0){ el.style.display="block"; bd.textContent=j.novos>99?"99+":j.novos; }
    else { el.style.display="none"; }
  }catch(e){}
}
function b13AbrirNovosPedidos(){
  const j=window._b13Novos||{novos:0,pedidos:[]};
  const fmtHora=(ms)=>{ if(!ms) return ""; const d=new Date(Number(ms)); const hj=new Date();
    const hh=d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
    return d.toDateString()===hj.toDateString()?("hoje "+hh):(d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})+" "+hh); };
  const corSit=(s)=>{ const t=String(s||"").toLowerCase();
    if(t.indexOf("aguardando")>=0) return "#ffe600";
    if(t.indexOf("separa")>=0) return "#29ABE2";
    if(t.indexOf("atendido")>=0) return "#3ce88a";
    if(t.indexOf("cancel")>=0) return "#ff8090";
    return "#9a95c9"; };
  const linhas=(j.pedidos||[]).map(p=>{
    const org=(p.origem==="totem")?"🖥️ Totem":((p.origem==="site")?"🌐 Site":("🧑‍💼 "+(p.vendedor||"Atacado")));
    return \`<div style="border-bottom:1px solid #2a2660;padding:8px 0">
      <div style="display:flex;justify-content:space-between;gap:8px;font-size:13px">
        <span><b>#\${p.numero}</b> \${p.cliente||""}</span>
        <b>R$ \${(Number(p.total)||0).toLocaleString("pt-BR",{minimumFractionDigits:2})}</b>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#9a95c9;margin-top:3px">
        <span>\${org} · \${p.tipo==="entrega"?"🛵 entrega":"🏪 retirada"}</span>
        <span>\${fmtHora(p.criadoEm)}</span>
      </div>
      <div style="margin-top:4px"><span style="background:\${corSit(p.situacao)};color:#000;border-radius:5px;font-size:10px;font-weight:900;padding:2px 7px">\${String(p.situacao||"—").toUpperCase()}</span></div>
    </div>\`;
  }).join("")||'<div style="color:#9a95c9">Nenhum novo.</div>';
  document.getElementById("b13qrModal").innerHTML=\`
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:200;padding:16px" onclick="if(event.target===this)document.getElementById('b13qrModal').innerHTML=''">
      <div style="background:#151233;border:1px solid #2c2660;border-radius:16px;padding:18px;max-width:440px;width:100%;max-height:80vh;overflow:auto">
        <div style="font-weight:900;font-size:16px;margin-bottom:2px">🔔 \${j.novos} novo(s) pedido(s)</div>
        <div style="color:#9a95c9;font-size:11px;margin-bottom:10px">Marcados como vistos automaticamente.</div>
        <div>\${linhas}</div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button onclick="document.getElementById('b13qrModal').innerHTML=''" style="flex:1;padding:10px;border:none;border-radius:10px;background:#1c1846;color:#fff;font-weight:800;cursor:pointer">Fechar</button>
          <button onclick="location.href='/pedidos-online'" style="flex:1;padding:10px;border:none;border-radius:10px;background:#FF0082;color:#fff;font-weight:800;cursor:pointer">Ver todos</button>
        </div>
      </div>
    </div>\`;
  // abrir JÁ conta como visto — não precisa clicar em nada
  b13MarcarPedidosVistos(true);
}
async function b13MarcarPedidosVistos(manterModal){
  const f=b13GetSession(); if(!f) return;
  try{ await fetch(B13_BACKEND+"/api/pedidos-online/marcar-visto/"+encodeURIComponent(f.id),{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}); }catch(e){}
  if(!manterModal) document.getElementById("b13qrModal").innerHTML="";
  const el=document.getElementById("b13sino"); if(el) el.style.display="none"; // zera o contador na hora
  b13ChecarNovosPedidos();
}

function b13IniciarSino(){
  const f=b13GetSession(); if(!f) return;
  const gruposSino=["admin","gerente","lider_caixa","financeiro","financeiro_atacado","separacao","conferencia"];
  const pode=gruposSino.includes(f.nivel)||(f.permissoes||[]).some(p=>gruposSino.includes(p))||b13Pode("ver_aguardando");
  if(!pode) return;
  b13ChecarNovosPedidos();
  clearInterval(_b13SinoTimer);
  _b13SinoTimer=setInterval(b13ChecarNovosPedidos,60000);
}

function b13RenderNav(ativo){
  const f=b13GetSession(); if(!f) return "";
  const links=B13_NAV_LINKS.filter(l=>l.acoes.some(a=>b13Pode(a)));
  // o funcionário pode autorizar caixa? (admin/gerente/líder) → nome clicável abre o QR
  const gruposQr=["admin","gerente","lider_caixa","financeiro","financeiro_atacado"];
  const temQr=gruposQr.includes(f.nivel)||(f.permissoes||[]).some(p=>gruposQr.includes(p));
  const nomeTopo=temQr
    ? \`<span onclick="b13MostrarMeuQr()" style="cursor:pointer;text-decoration:underline dotted #00e0b0;text-underline-offset:3px" title="Toque pra ver seu QR do caixa">\${f.nome} <span style="font-size:11px">📱</span></span>\`
    : f.nome;

  return \`<style>body{padding-top:44px !important}@media(min-width:900px){#b13topbar{left:200px}}</style>
    <div id="b13topbar" style="position:fixed;top:0;left:0;right:0;height:44px;background:linear-gradient(180deg,#2b2870,#262366);border-bottom:2px solid #FF0082;display:flex;align-items:center;gap:10px;padding:0 12px 0 52px;z-index:98">
      <div style="flex:1"></div>
      <div id="b13sino" onclick="b13AbrirNovosPedidos()" title="Novos pedidos do totem/site" style="position:relative;cursor:pointer;font-size:18px;display:none;padding:2px 6px">🔔
        <span id="b13sinoBadge" style="position:absolute;top:-4px;right:-4px;background:#FF0082;color:#fff;border-radius:10px;font-size:10px;font-weight:900;padding:1px 5px;min-width:16px;text-align:center">0</span>
      </div>
      <div style="text-align:right;font-size:13px;color:#fff;font-weight:700">\${nomeTopo} <span style="color:#9a95c9;font-weight:400;font-size:11px">· \${f.nivel}</span></div>
    </div>
    <div id="b13nav" style="position:fixed;top:0;left:0;bottom:0;width:200px;background:linear-gradient(180deg,#2b2870,#262366);border-right:2px solid #FF0082;display:flex;flex-direction:column;z-index:100;transform:translateX(-100%);transition:.25s">
    <div style="padding:14px 12px;border-bottom:1px solid rgba(255,0,130,.3)">
      <div style="font-weight:900;font-size:13px;color:#fff">\${f.nome}</div>
      <div style="font-size:11px;color:#9a95c9">\${f.nivel}</div>
    </div>
    <nav style="flex:1;padding:8px 0;overflow-y:auto">
      \${b13NavHtml(links,ativo)}
    </nav>
    <div style="padding:10px 12px;border-top:1px solid rgba(255,0,130,.3)">
      <button onclick="b13Logout()" style="width:100%;padding:8px;border:1px solid #514c96;border-radius:8px;background:transparent;color:#9a95c9;cursor:pointer;font-size:12px">Sair</button>
    </div>
  </div>
  <button onclick="b13ToggleNav()" style="position:fixed;top:6px;left:12px;z-index:101;background:#262366;border:1px solid #FF0082;border-radius:8px;color:#fff;padding:6px 10px;cursor:pointer;font-size:18px">☰</button>
  <div id="b13navOverlay" onclick="b13ToggleNav()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99"></div>
  <div id="b13qrModal"></div>\`;
}
// dispara o sino automaticamente assim que a barra existir na tela
setTimeout(function(){ try{ if(document.getElementById("b13sino")) b13IniciarSino(); }catch(e){} }, 800);

// mostra o QR do caixa do próprio usuário logado (em qualquer página). Só funciona
// pra quem pode autorizar (o backend valida). O QR fica embaçado até revelar.
function b13MostrarMeuQr(){
  const f=b13GetSession(); if(!f) return;
  const host=document.getElementById("b13qrModal")||document.body;
  host.innerHTML=\`<div id="b13qrBg" onclick="if(event.target===this)document.getElementById('b13qrModal').innerHTML=''" style="position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:16px;z-index:200">
    <div style="background:#151233;border:1px solid #2c2660;border-radius:16px;padding:20px;max-width:340px;width:100%;text-align:center">
      <div style="font-weight:800;margin-bottom:4px">📱 Seu QR do caixa</div>
      <div style="font-size:12px;color:#9a95c9;margin-bottom:12px">Autoriza ações no Frente de Caixa. Muda todo dia. Mostre no leitor quando pedirem autorização.</div>
      <div id="b13qrWrap" style="padding:14px;background:#0f0d24;border:1px solid #2c2660;border-radius:10px"><div style="color:#9a95c9">Gerando…</div></div>
      <button onclick="document.getElementById('b13qrModal').innerHTML=''" style="width:100%;margin-top:14px;padding:10px;border:1px solid #514c96;border-radius:8px;background:transparent;color:#cfc9f5;cursor:pointer">Fechar</button>
    </div>
  </div>\`;
  // carrega a lib de QR se ainda não tiver, e busca o token do dia
  const desenhar=()=>{
    fetch((B13_BACKEND||"")+"/api/pdv/meu-qr/"+f.id,{headers:{"X-Auth-Token":f.token||""}})
      .then(r=>r.json()).then(j=>{
        const wrap=document.getElementById("b13qrWrap"); if(!wrap) return;
        if(j.erro){ wrap.innerHTML='<div style="color:#ffbfce">'+j.erro+'</div>'; return; }
        window._b13QrToken=j.token;
        wrap.innerHTML=\`<div style="font-size:11px;color:#00e0b0;margin-bottom:8px">Válido só hoje (\${(j.dia||"").split("-").reverse().join("/")})</div>
          <div id="b13qrHolder" style="display:inline-block;padding:10px;background:#fff;border-radius:8px;filter:blur(11px);transition:filter .2s"></div>
          <div style="display:flex;gap:8px;margin-top:12px;justify-content:center">
            <button id="b13qrRevelar" onclick="b13RevelarMeuQr()" style="padding:8px 12px;border:none;border-radius:8px;background:#FF0082;color:#fff;font-weight:800;cursor:pointer;font-size:12px">👁️ Revelar</button>
            <button onclick="b13CopiarMeuQr()" style="padding:8px 12px;border:none;border-radius:8px;background:#1c1846;color:#fff;font-weight:800;cursor:pointer;font-size:12px">📋 Copiar código</button>
          </div>\`;
        new QRCode(document.getElementById("b13qrHolder"),{text:j.token,width:180,height:180,correctLevel:QRCode.CorrectLevel.M});
      }).catch(()=>{ const w=document.getElementById("b13qrWrap"); if(w) w.innerHTML='<div style="color:#ffbfce">Erro ao gerar o QR.</div>'; });
  };
  if(typeof QRCode==="undefined"){
    const s=document.createElement("script");
    s.src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    s.onload=desenhar; document.head.appendChild(s);
  } else desenhar();
}
let _b13QrTimer=null;
function b13RevelarMeuQr(){
  const h=document.getElementById("b13qrHolder"), b=document.getElementById("b13qrRevelar");
  if(!h) return;
  h.style.filter="none"; if(b){ b.textContent="👁️ Visível"; b.disabled=true; b.style.opacity=".6"; }
  clearTimeout(_b13QrTimer);
  _b13QrTimer=setTimeout(()=>{ if(h) h.style.filter="blur(11px)"; if(b){ b.textContent="👁️ Revelar"; b.disabled=false; b.style.opacity="1"; } },20000);
}
function b13CopiarMeuQr(){
  const t=window._b13QrToken; if(!t) return;
  if(navigator.clipboard) navigator.clipboard.writeText(t).then(()=>alert("✅ Código copiado!")).catch(()=>prompt("Copie o código:",t));
  else prompt("Copie o código:",t);
}

function b13ToggleNav(){
  const nav=document.getElementById("b13nav");
  const ov=document.getElementById("b13navOverlay");
  if(!nav) return;
  const open=nav.style.transform==="translateX(0px)"||nav.style.transform==="translateX(0%)";
  nav.style.transform=open?"translateX(-100%)":"translateX(0%)";
  if(ov) ov.style.display=open?"none":"block";
}
`);
});
app.get("/callback",async(req,res)=>{
  try{ const {code}=req.query; if(!code) return res.status(400).send("Sem 'code'."); await trocarCodePorToken(code);
    res.send("<h2>✅ Conta Bling conectada!</h2><p>Pode fechar. Teste em <a href='/status'>/status</a>.</p>");
  }catch(e){ res.status(500).send("Erro no callback: "+e.message); }
});
app.get("/status",(req,res)=>{
  const t=lerTokens(); if(!t) return res.json({conectado:false,dica:"Acesse /auth."});
  res.json({conectado:true, expira_em_segundos:Math.round((t.obtido_em+t.expires_in*1000-Date.now())/1000), tabela_publicada: !!lerTabela()});
});

// ------------------------- Dados / diagnóstico -------------------------
app.get("/api/produtos",async(req,res)=>{ try{ res.json(await bling(`/produtos?pagina=${req.query.pagina||1}&limite=${req.query.limite||100}`)); }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }});
app.get("/api/categorias",async(req,res)=>{ try{ res.json(await bling(`/categorias/produtos?limite=100`)); }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }});
app.get("/api/produto/:id",async(req,res)=>{ try{ res.json(await bling(`/produtos/${req.params.id}`)); }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }});
app.get("/api/raw",async(req,res)=>{ try{ const p=req.query.path; if(!p||!p.startsWith("/")) return res.status(400).json({erro:"?path=/endpoint"}); res.json(await bling(p)); }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }});
// Busca produto por nome (para acrescentar em pedidos)
app.get("/api/produtos/buscar", async(req,res)=>{
  try{
    const q=req.query.q||"";
    if(!q) return res.json({data:[]});
    const est=await getEstoqueMap();
    const prods=Object.values(est)
      .filter(p=>p.nome&&p.nome.toLowerCase().includes(q.toLowerCase()))
      .slice(0,10);
    // busca preço do Bling para cada produto
    const resultado=[];
    for(const p of prods){
      let preco=p.preco||0;
      if(!preco&&p.id){
        try{
          await new Promise(r=>setTimeout(r,150));
          const pj=await bling(`/produtos/${p.id}`);
          preco=pj?.data?.preco||0;
        }catch(e){}
      }
      resultado.push({id:p.id,codigo:p.codigo,nome:p.nome,preco,imagem:p.imagem||""});
    }
    res.json({data:resultado});
  }catch(e){ res.status(500).json({erro:e.message,data:[]}); }
});

// Debug: busca pedidos dos últimos 3 dias por situação
app.get("/api/debug/pedidos-hoje", async(req,res)=>{
  try{
    const agora=new Date();
    const offsetBR=3*60*60*1000;
    const hoje=new Date(agora-offsetBR).toISOString().slice(0,10);
    const ontem=new Date(agora-offsetBR-86400000).toISOString().slice(0,10);
    // busca sem filtro de situação
    const [rHoje,rOntem]=await Promise.all([
      bling(`/pedidos/vendas?pagina=1&limite=100&dataInicial=${hoje}&dataFinal=${hoje}`),
      bling(`/pedidos/vendas?pagina=1&limite=100&dataInicial=${ontem}&dataFinal=${ontem}`),
    ]);
    const contar=(arr)=>{ const s={}; (arr||[]).forEach(p=>{ const sid=p.situacao?.id; s[sid]=(s[sid]||0)+1; }); return s; };
    // busca com filtro de situações
    const params=new URLSearchParams({pagina:1,limite:100,dataInicial:ontem,dataFinal:hoje});
    [SIT.AGUARDANDO,SIT.EM_SEP,SIT.SEP_PEND,SIT.SEPARADO].filter(Boolean).forEach(id=>params.append("idsSituacoes[]",id));
    const rFiltrado=await bling(`/pedidos/vendas?${params.toString()}`);
    res.json({
      hoje,ontem,
      pedidosHoje:{total:rHoje.data?.length||0,porSituacao:contar(rHoje.data)},
      pedidosOntem:{total:rOntem.data?.length||0,porSituacao:contar(rOntem.data)},
      comFiltroSituacao:{total:rFiltrado.data?.length||0,exemplos:(rFiltrado.data||[]).slice(0,3).map(p=>({numero:p.numero,sit:p.situacao?.id,nome:p.situacao?.nome}))},
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});
app.get("/api/situacoes",async(req,res)=>{ try{ const m=req.query.modulo; res.json(await bling(m?`/situacoes/modulos/${m}`:`/situacoes/modulos`)); }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }});

// ---- helpers ----
const lerJSON=(f,def={})=>{ try{return JSON.parse(fs.readFileSync(f,"utf8"));}catch{return def;} };
const salvarJSON=(f,d)=>fs.writeFileSync(f,JSON.stringify(d));
// Hash de senha forte: scrypt com sal único por usuário (formato salvo: "salt:hash").
// Antigo (SHA-256 com sal fixo compartilhado) ainda é reconhecido pra não invalidar
// senhas já cadastradas — migra sozinho pro formato novo no próximo login com sucesso.
const hashSenhaAntigo=(s)=>crypto.createHash("sha256").update(s+(process.env.SALT||"b13salt")).digest("hex");
function hashSenha(s){
  const salt=crypto.randomBytes(16).toString("hex");
  const hash=crypto.scryptSync(s,salt,64).toString("hex");
  return `${salt}:${hash}`;
}
function verificarSenha(senhaDigitada,armazenado){
  if(!armazenado) return false;
  if(armazenado.includes(":")){
    const [salt,hash]=armazenado.split(":");
    try{
      const hashDigitado=crypto.scryptSync(senhaDigitada,salt,64).toString("hex");
      return crypto.timingSafeEqual(Buffer.from(hash,"hex"),Buffer.from(hashDigitado,"hex"));
    }catch(e){ return false; }
  }
  // formato antigo (sem sal por usuário) — ainda aceito pra compatibilidade
  return hashSenhaAntigo(senhaDigitada)===armazenado;
}

// ---- SESSÕES (token emitido no login, exigido pra ações administrativas sensíveis) ----
function lerSessoes(){ return lerJSON(SESSOES_FILE,{}); }
function salvarSessoes(s){ salvarJSON(SESSOES_FILE,s); }
function criarSessao(f){
  const sessoes=lerSessoes();
  const token=crypto.randomBytes(24).toString("hex");
  // sessão dura 7 dias e é renovada a cada uso (ver renovarSessao) — assim ninguém
  // é deslogado no meio do expediente; só expira depois de 7 dias SEM usar.
  sessoes[token]={funcionarioId:f.id,nome:f.nome,nivel:f.nivel,permissoes:f.permissoes||[f.nivel],criadoEm:Date.now(),expiraEm:Date.now()+7*24*3600*1000};
  salvarSessoes(sessoes);
  return token;
}
const DURACAO_SESSAO_MS=7*24*3600*1000;
// estende a validade da sessão a cada requisição autenticada (renovação deslizante)
function renovarSessao(sessoes,token,s){
  const novoExpira=Date.now()+DURACAO_SESSAO_MS;
  // só grava se mudou bastante (evita escrever no disco a cada request)
  if(novoExpira - (s.expiraEm||0) > 3600*1000){
    s.expiraEm=novoExpira; sessoes[token]=s; try{ salvarSessoes(sessoes); }catch(e){}
  }
}
// Regra de senha forte: mínimo 6 caracteres, com maiúscula, minúscula e número
function senhaForte(s){
  return typeof s==="string" && s.length>=6 && /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
}
// Middleware: exige apenas sessão válida (qualquer funcionário logado, não só admin)
function requireSessao(req,res,next){
  const token=req.headers["x-auth-token"];
  if(!token) return res.status(401).json({erro:"Não autenticado — faça login novamente"});
  const sessoes=lerSessoes();
  const s=sessoes[token];
  if(!s||s.expiraEm<Date.now()) return res.status(401).json({erro:"Sessão expirada — faça login novamente"});
  renovarSessao(sessoes,token,s); // renovação deslizante: enquanto usa, não expira
  req.sessao=s;
  next();
}
// Middleware: exige token de sessão válido de um admin (ou de quem tem "admin" nas permissões)
function requireAdmin(req,res,next){
  const token=req.headers["x-auth-token"];
  if(!token) return res.status(401).json({erro:"Não autenticado — faça login novamente"});
  const sessoes=lerSessoes();
  const s=sessoes[token];
  if(!s||s.expiraEm<Date.now()) return res.status(401).json({erro:"Sessão expirada — faça login novamente"});
  if(s.nivel!=="admin"&&!(s.permissoes||[]).includes("admin")) return res.status(403).json({erro:"Sem permissão de administrador"});
  renovarSessao(sessoes,token,s); // renovação deslizante
  req.sessao=s;
  next();
}

// ---- FUNCIONÁRIOS ----
app.get("/api/funcionarios",(req,res)=>{
  const funcs=lerJSON(FUNC_FILE,{});
  res.json({data:Object.values(funcs).map(f=>({id:f.id,nome:f.nome,login:f.login||"",nivel:f.nivel,permissoes:f.permissoes||[f.nivel],ativo:f.ativo,codigoConfirmacao:f.codigoConfirmacao||"",temPin:!!f.pinConfirmacao,precisaTrocarSenha:!!f.precisaTrocarSenha,vendedorBlingId:f.vendedorBlingId||null,vendedorBlingNome:f.vendedorBlingNome||""}))});
});
app.post("/api/funcionarios",requireAdmin,(req,res)=>{
  const {nome,nivel}=req.body||{};
  const senha=req.body.senha||"12345"; // senha padrão — o funcionário troca no primeiro acesso
  if(!nome||!nivel) return res.status(400).json({erro:"nome e nivel obrigatórios"});
  const funcs=lerJSON(FUNC_FILE,{});
  const id="f"+Date.now()+crypto.randomBytes(4).toString("hex");
  // verificar login duplicado
  const _loginNovo=String(req.body.login||"").toLowerCase().trim();
  if(req.body.login && Object.values(funcs).some(f=>String(f.login||"").toLowerCase().trim()===_loginNovo))
    return res.status(400).json({erro:"Login já em uso por outro funcionário"});
  // código de confirmação (1 letra + 2 números), sem repetir um já existente
  const letras="ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let codigoConfirmacao;
  do{
    codigoConfirmacao=letras[Math.floor(Math.random()*letras.length)]+String(Math.floor(Math.random()*100)).padStart(2,"0");
  }while(Object.values(funcs).some(f=>f.codigoConfirmacao===codigoConfirmacao));
  funcs[id]={id,nome,login:req.body.login||"",nivel,permissoes:req.body.permissoes||[nivel],senhaHash:hashSenha(senha),ativo:true,criadoEm:Date.now(),
    precisaTrocarSenha:true, // sempre pede pra trocar a senha padrão no primeiro acesso
    codigoConfirmacao,pinConfirmacao:req.body.pinConfirmacao||"",
    vendedorBlingId:req.body.vendedorBlingId?Number(req.body.vendedorBlingId):null,vendedorBlingNome:req.body.vendedorBlingNome||""};
  salvarJSON(FUNC_FILE,funcs); res.json({ok:true,id,codigoConfirmacao,senhaPadrao:senha});
});
app.patch("/api/funcionarios/:id",requireAdmin,(req,res)=>{
  const funcs=lerJSON(FUNC_FILE,{}); const f=funcs[req.params.id];
  if(!f) return res.status(404).json({erro:"funcionário não encontrado"});
  if(req.body.nome) f.nome=req.body.nome;
  if(req.body.login){
    const outros=Object.values(lerJSON(FUNC_FILE,{})).filter(x=>x.id!==req.params.id);
    const _loginEdit=String(req.body.login||"").toLowerCase().trim();
    if(outros.some(x=>String(x.login||"").toLowerCase().trim()===_loginEdit)) return res.status(400).json({erro:"Login já em uso"});
    f.login=req.body.login;
  }
  if(req.body.nivel) f.nivel=req.body.nivel;
  if(req.body.permissoes) f.permissoes=req.body.permissoes;
  if(typeof req.body.ativo==="boolean") f.ativo=req.body.ativo;
  if(req.body.senha) { f.senhaHash=hashSenha(req.body.senha); f.precisaTrocarSenha=true; } // reset manual de senha pelo admin também força troca
  if(req.body.resetarSenhaPadrao){ f.senhaHash=hashSenha("12345"); f.precisaTrocarSenha=true; }
  if(req.body.pinConfirmacao!==undefined) f.pinConfirmacao=req.body.pinConfirmacao;
  if(req.body.codigoConfirmacao!==undefined) f.codigoConfirmacao=req.body.codigoConfirmacao.toUpperCase();
  if(req.body.vendedorBlingId!==undefined) f.vendedorBlingId=req.body.vendedorBlingId?Number(req.body.vendedorBlingId):null;
  if(req.body.vendedorBlingNome!==undefined) f.vendedorBlingNome=req.body.vendedorBlingNome||"";
  if(req.body.gerarCodigo){
    const letras="ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let novoCodigo;
    do{
      novoCodigo=letras[Math.floor(Math.random()*letras.length)]+String(Math.floor(Math.random()*100)).padStart(2,"0");
    }while(Object.values(funcs).some(x=>x.codigoConfirmacao===novoCodigo));
    f.codigoConfirmacao=novoCodigo;
  }
  salvarJSON(FUNC_FILE,funcs); res.json({ok:true,codigoConfirmacao:f.codigoConfirmacao});
});
app.delete("/api/funcionarios/:id",requireAdmin,(req,res)=>{
  const funcs=lerJSON(FUNC_FILE,{}); if(!funcs[req.params.id]) return res.status(404).json({erro:"não encontrado"});
  delete funcs[req.params.id]; salvarJSON(FUNC_FILE,funcs); res.json({ok:true});
});
// Endpoint antigo de reset de senha via URL foi removido por segurança (sem
// autenticação, com ID previsível e senha exposta na URL — permitia tomada de
// conta por qualquer pessoa). Reset de senha agora só via PUT /api/funcionarios/:id
// (já usado pela tela de Funcionários, que exige estar logado como admin no app).

// Limite de tentativas de login por IP — evita força bruta de senha
const _loginTentativas={}; // ip -> {tentativas, bloqueadoAte}
function checarLimiteLogin(ip){
  const agora=Date.now();
  const info=_loginTentativas[ip]||{tentativas:0,primeiraEm:agora,bloqueadoAte:0};
  if(info.bloqueadoAte>agora) return {bloqueado:true,restanteMs:info.bloqueadoAte-agora};
  return {bloqueado:false,info};
}
function registrarFalhaLogin(ip){
  const agora=Date.now();
  const info=_loginTentativas[ip]||{tentativas:0,primeiraEm:agora,bloqueadoAte:0};
  // reseta contador se a janela de 15 min já passou
  if(agora-info.primeiraEm>15*60*1000){ info.tentativas=0; info.primeiraEm=agora; }
  info.tentativas++;
  if(info.tentativas>=6) info.bloqueadoAte=agora+10*60*1000; // 10 min de bloqueio após 6 tentativas erradas
  _loginTentativas[ip]=info;
}
function limparTentativasLogin(ip){ delete _loginTentativas[ip]; }

app.post("/api/funcionarios/login",(req,res)=>{
  const ip=req.ip||req.headers["x-forwarded-for"]||req.socket.remoteAddress||"desconhecido";
  const limite=checarLimiteLogin(ip);
  if(limite.bloqueado){
    return res.status(429).json({erro:`Muitas tentativas erradas. Tente de novo em ${Math.ceil(limite.restanteMs/60000)} min.`});
  }
  const {login,senha,nivel}=req.body||{};
  const funcs=lerJSON(FUNC_FILE,{});
  // busca por login+senha (se tiver login), senão só pela senha (compatibilidade)
  const loginNorm=String(login||"").toLowerCase().trim();
  const f=Object.values(funcs).find(x=>{
    // usuário não diferencia maiúscula/minúscula nem espaços sobrando; a SENHA continua exata
    const loginOk=login?String(x.login||"").toLowerCase().trim()===loginNorm:true;
    return loginOk&&verificarSenha(senha||"",x.senhaHash)&&x.ativo&&(!nivel||x.nivel===nivel||(x.permissoes||[]).includes(nivel)||x.nivel==="admin");
  });
  if(!f){ registrarFalhaLogin(ip); return res.status(401).json({erro:"Login ou senha incorretos"}); }
  limparTentativasLogin(ip);
  // migra sozinho pro hash forte (scrypt) se ainda estava no formato antigo
  if(!f.senhaHash.includes(":")){ f.senhaHash=hashSenha(senha); salvarJSON(FUNC_FILE,funcs); }
  const token=criarSessao(f);
  res.json({ok:true,funcionario:{id:f.id,nome:f.nome,nivel:f.nivel,permissoes:f.permissoes||[f.nivel],precisaTrocarSenha:!!f.precisaTrocarSenha,token}});
});

// troca de senha pelo próprio funcionário logado — usada tanto no fluxo
// obrigatório do primeiro acesso quanto numa troca voluntária futura
app.post("/api/funcionarios/trocar-senha",requireSessao,(req,res)=>{
  const {senhaAtual,novaSenha}=req.body||{};
  if(!senhaAtual||!novaSenha) return res.status(400).json({erro:"Informe a senha atual e a nova senha"});
  if(!senhaForte(novaSenha)) return res.status(400).json({erro:"A nova senha precisa ter pelo menos 6 caracteres, com letra maiúscula, minúscula e número."});
  const funcs=lerJSON(FUNC_FILE,{});
  const f=funcs[req.sessao.funcionarioId];
  if(!f) return res.status(404).json({erro:"Funcionário não encontrado"});
  if(!verificarSenha(senhaAtual,f.senhaHash)) return res.status(401).json({erro:"Senha atual incorreta"});
  f.senhaHash=hashSenha(novaSenha);
  f.precisaTrocarSenha=false;
  salvarJSON(FUNC_FILE,funcs);
  res.json({ok:true});
});

// ---- LOCKS DE PEDIDO (quem está com o pedido) ----
const LOCK_TIMEOUT=15*60*1000; // 15 minutos
function lerLocks(){ return lerJSON(SEP_FILE,{}); }
function salvarLocks(o){ salvarJSON(SEP_FILE,o); }
function liberarLock(pedidoId, funcionarioId, funcionarioNome, motivo){
  const locks=lerLocks(); const id=String(pedidoId);
  if(locks[id]){
    addLog(id,`pedido_liberado_${locks[id].tipo||"separacao"}`,
      funcionarioId||locks[id].funcionarioId,
      funcionarioNome||locks[id].funcionarioNome,
      {motivo:motivo||"concluido"});
    delete locks[id]; salvarLocks(locks);
  }
}
function limparLocksExpirados(){
  const locks=lerLocks(); const agora=Date.now(); let mudou=false;
  Object.entries(locks).forEach(([id,lock])=>{ if(agora-lock.ultimaAtividade>LOCK_TIMEOUT){ delete locks[id]; mudou=true; } });
  if(mudou) salvarLocks(locks);
  return locks;
}

// pegar lock de um pedido
app.post("/api/separacoes",(req,res)=>{
  const {pedidoId,funcionarioId,funcionarioNome,tipo,assumir}=req.body||{};
  if(!pedidoId||!funcionarioId) return res.status(400).json({erro:"pedidoId e funcionarioId obrigatórios"});
  const locks=limparLocksExpirados(); const id=String(pedidoId);
  const lockAtual=locks[id];
  // se tem lock de outro e não está assumindo → bloqueia
  if(lockAtual && lockAtual.funcionarioId!==funcionarioId && !assumir){
    return res.status(409).json({erro:"pedido_bloqueado",lock:lockAtual});
  }
  // remove qualquer lock anterior deste funcionário (garante só 1 por vez)
  Object.entries(locks).forEach(([pid,lk])=>{
    if(lk.funcionarioId===funcionarioId && pid!==id){
      addLog(pid,"pedido_liberado_automatico",funcionarioId,funcionarioNome,{motivo:"abriu outro pedido"});
      delete locks[pid];
    }
  });
  // registra quem assumiu no log
  if(lockAtual && lockAtual.funcionarioId!==funcionarioId && assumir){
    addLog(id,"pedido_assumido",funcionarioId,funcionarioNome,{de:lockAtual.funcionarioNome,tipo});
  } else if(!lockAtual){
    addLog(id,`pedido_aberto_${tipo||"separacao"}`,funcionarioId,funcionarioNome,{});
  }
  locks[id]={pedidoId,funcionarioId,funcionarioNome,tipo:tipo||"separacao",inicio:Date.now(),ultimaAtividade:Date.now()};
  salvarLocks(locks); res.json({ok:true});
});

// atualizar atividade (heartbeat)
app.patch("/api/separacoes/:id",(req,res)=>{
  const locks=lerLocks(); const id=String(req.params.id);
  if(locks[id] && locks[id].funcionarioId===req.body?.funcionarioId){
    locks[id].ultimaAtividade=Date.now(); salvarLocks(locks);
  }
  res.json({ok:true});
});

app.get("/api/separacoes",(req,res)=>{ res.json({data:limparLocksExpirados()}); });

// ===================== MESA DE SEPARAÇÃO (multi-operador) =====================
// Tela pra monitor touch: vários separadores trabalhando ao mesmo tempo, cada um
// numa coluna. Guarda quem está ATIVO na mesa (independente de login).
const MESA_FILE=`${DATA_DIR}/mesa_separacao.json`; // {ativos:[funcionarioId], em}
function lerMesa(){ const d=lerJSON(MESA_FILE,{ativos:[]}); if(!Array.isArray(d.ativos)) d.ativos=[]; return d; }
// SOMENTE o grupo expedição — nem admin, nem gerente, nem permissão avulsa de separação
function _ehExpedicao(f){ if(!f||f.ativo===false) return false; const p=f.permissoes||[]; return f.nivel==="expedicao"||p.includes("expedicao"); }
// remove da mesa quem não é mais da expedição (ou foi excluído) — senão sobra uma
// coluna com o ID cru de alguém que não existe mais na lista
function lerMesaValidada(){
  const mesa=lerMesa();
  const funcs=lerJSON(FUNC_FILE,{});
  const validos=mesa.ativos.filter(id=>_ehExpedicao(funcs[id]));
  if(validos.length!==mesa.ativos.length){ mesa.ativos=validos; mesa.em=Date.now(); salvarJSON(MESA_FILE,mesa); }
  return mesa;
}
// funcionários que podem separar (grupo expedição / com permissão de separação)
app.get("/api/mesa/funcionarios",(req,res)=>{
  try{
    const funcs=lerJSON(FUNC_FILE,{});
    const mesa=lerMesa();
    const lista=Object.entries(funcs)
      .filter(([id,f])=>_ehExpedicao(f))
      .map(([id,f])=>({id, nome:f.nome||"—", nivel:f.nivel||"", ativoNaMesa:mesa.ativos.includes(String(id))}))
      .sort((a,b)=>a.nome.localeCompare(b.nome));
    res.json({data:lista, ativos:mesa.ativos,
      ...(lista.length?{}:{aviso:"Nenhum funcionário no grupo expedição. Em Funcionários, defina o nível/permissão 'expedicao' para quem vai separar."})});
  }catch(e){ res.status(500).json({erro:e.message}); }
});
app.post("/api/mesa/toggle/:funcionarioId",(req,res)=>{
  try{
    const id=String(req.params.funcionarioId);
    const funcs=lerJSON(FUNC_FILE,{});
    if(!_ehExpedicao(funcs[id])) return res.status(400).json({erro:"esse funcionário não é do grupo expedição"});
    const mesa=lerMesaValidada();
    const i=mesa.ativos.indexOf(id);
    if(i>=0) mesa.ativos.splice(i,1); else mesa.ativos.push(id);
    mesa.em=Date.now();
    salvarJSON(MESA_FILE,mesa);
    res.json({ok:true, ativo:i<0, ativos:mesa.ativos});
  }catch(e){ res.status(500).json({erro:e.message}); }
});
// estado da mesa: fila de pedidos na ORDEM DE CONFIRMAÇÃO + quem está com o quê
app.get("/api/mesa/estado",async(req,res)=>{
  try{
    const mesa=lerMesaValidada();
    const funcs=lerJSON(FUNC_FILE,{});
    const locks=limparLocksExpirados();
    // pedidos aguardando separação (mesma fila da expedição), do mais antigo pro mais novo
    const n=new Date(Date.now()-3*60*60*1000);
    const hoje=n.toISOString().slice(0,10);
    const ini=new Date(n-30*86400000).toISOString().slice(0,10);
    const params=new URLSearchParams({pagina:1,limite:100,dataInicial:ini,dataFinal:hoje});
    [SIT.AGUARDANDO,SIT.EM_SEP].filter(Boolean).forEach(id=>params.append("idsSituacoes[]",id));
    let pedidos=[];
    try{ const r=await bling(`/pedidos/vendas?${params.toString()}`); pedidos=r?.data||[]; }catch(e){}
    // ordem de confirmação = ordem em que entraram na fila (número do pedido)
    pedidos.sort((a,b)=>(Number(a.numero)||a.id)-(Number(b.numero)||b.id));
    const emSeparacao={}; // funcionarioId -> pedido
    Object.values(locks||{}).forEach(l=>{ if(l&&l.funcionarioId) emSeparacao[String(l.funcionarioId)]={pedidoId:l.pedidoId, desde:l.em||l.desde||null, nome:l.funcionarioNome||""}; });
    res.json({
      ativos: mesa.ativos.filter(id=>funcs[id]).map(id=>({ id, nome:funcs[id].nome||"—", separando: emSeparacao[String(id)]||null })),
      fila: pedidos.map(p=>({ id:p.id, numero:p.numero, cliente:p.contato?.nome||"—", total:Number(p.total)||0,
        data:p.data, situacaoId:Number(p.situacao?.id||0), situacao:nomeSituacao(Number(p.situacao?.id||0)),
        emSeparacaoPor: Object.values(locks||{}).find(l=>String(l.pedidoId)===String(p.id))?.funcionarioNome || null })),
      locks,
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});
app.get("/mesa-separacao", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "mesa-separacao.html")); });


// Painel de acompanhamento (monitor de TV): junta os pedidos por situação com
// quem está separando (locks). Divide em 4 grupos pra tela.
app.get("/api/painel-pedidos", async(req,res)=>{
  try{
    const locks=limparLocksExpirados();
    // busca todos os pedidos nas situações que interessam ao painel
    const params=new URLSearchParams({pagina:1,limite:100});
    [SIT.EM_SEP,SIT.SEP_PEND,SIT.SEPARADO].filter(Boolean).forEach(id=>params.append("idsSituacoes[]",id));
    const r=await bling(`/pedidos/vendas?${params.toString()}`);
    const pedidos=r.data||[];

    const aguardando=[], separando=[], pendencia=[], separado=[];
    for(const p of pedidos){
      const sit=p.situacao?.id;
      const base={numero:p.numero,id:p.id,cliente:p.contato?.nome||"—",total:p.total||0};
      if(sit===SIT.SEPARADO){ separado.push(base); }
      else if(sit===SIT.SEP_PEND){ pendencia.push(base); }
      else if(sit===SIT.EM_SEP){
        const lock=locks[String(p.id)];
        if(lock && lock.tipo==="separacao"){ separando.push({...base,funcionario:lock.funcionarioNome||"—"}); }
        else { aguardando.push(base); }
      }
    }
    const ordena=a=>a.sort((x,y)=>String(x.numero).localeCompare(String(y.numero)));
    res.json({
      aguardando:ordena(aguardando),
      separando:ordena(separando),
      pendencia:ordena(pendencia),
      separado:ordena(separado),
      atualizadoEm:Date.now(),
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.delete("/api/separacoes/:id",(req,res)=>{
  const locks=lerLocks(); const id=String(req.params.id);
  const {funcionarioId,funcionarioNome,tipo}=req.body||{};
  if(locks[id]) addLog(id,`pedido_liberado_${locks[id].tipo||"separacao"}`,funcionarioId||locks[id].funcionarioId,funcionarioNome||locks[id].funcionarioNome,{});
  delete locks[id]; salvarLocks(locks); res.json({ok:true});
});

// ---- ACRÉSCIMOS (itens novos em pedidos já separados) ----
app.post("/api/acrescimos",(req,res)=>{
  const {pedidoId,numero,cliente,itensNovos}=req.body||{};
  if(!pedidoId||!itensNovos?.length) return res.status(400).json({erro:"pedidoId e itensNovos obrigatórios"});
  const acrs=lerJSON(ACRS_FILE,{});
  acrs[String(pedidoId)]={pedidoId,numero,cliente,itensNovos,em:Date.now(),status:"pendente"};
  salvarJSON(ACRS_FILE,acrs); res.json({ok:true});
});
app.get("/api/acrescimos",(req,res)=>{ res.json({data:Object.values(lerJSON(ACRS_FILE,{}))}); });
app.patch("/api/acrescimos/:id",(req,res)=>{
  const acrs=lerJSON(ACRS_FILE,{}); const a=acrs[String(req.params.id)];
  if(!a) return res.status(404).json({erro:"não encontrado"});
  if(req.body.status) a.status=req.body.status;
  salvarJSON(ACRS_FILE,acrs); res.json({ok:true});
});

// ---- PAGAMENTOS ----
function lerPag(){ return lerJSON(PAG_FILE,{}); }
function salvarPag(o){ salvarJSON(PAG_FILE,o); }

// ---- LEDGER DIÁRIO (ficha local de cada pedido: data em que foi CRIADO x
// data em que foi de fato PAGO — essa segunda data, uma vez detectada, fica
// travada pra sempre, então o fechamento de um dia já fechado nunca muda) ----
function lerLedger(){ return lerJSON(LEDGER_FILE,{}); }
function salvarLedger(o){ salvarJSON(LEDGER_FILE,o); }

// Atualiza as parcelas do pedido no Bling de verdade (via PUT, já comprovado
// que funciona nesse sistema), substituindo a parcela única "placeholder"
// pelas formas de pagamento reais usadas no recebimento. Algumas situações
// (Em Separação, Separado, Em Rota etc) bloqueiam edição direta no Bling —
// usa o mesmo desbloqueio via "Em Digitação" já usado pra editar itens.
// tenta destravar o pedido pra edição: testa situações editáveis até uma transição
// ser ACEITA por este Bling (cada conta tem um fluxo de situações diferente).
async function _destravarSituacao(id){
  const cands=[SIT.EM_DIGITACAO, SIT.EM_ABERTO, SIT.VERIFICADO].filter(Boolean);
  for(const c of cands){
    try{ await bling(`/pedidos/vendas/${id}/situacoes/${c}`,{method:"PATCH"}); return c; }
    catch(e){ /* transição não definida pra esta conta — tenta a próxima */ }
  }
  return null;
}
// restaura a situação original CAMINHANDO até ela (passos intermediários podem falhar
// se a transição não existir; o importante é o passo final chegar no alvo).
async function _restaurarSituacao(id, alvo){
  let caminho;
  if(alvo===SIT.ATENDIDO) caminho=[SIT.EM_SEP,SIT.SEPARADO,SIT.ATENDIDO];
  else if(alvo===SIT.SEPARADO) caminho=[SIT.EM_SEP,SIT.SEPARADO];
  else caminho=[alvo];
  for(const s of caminho){
    if(!s) continue;
    try{ await bling(`/pedidos/vendas/${id}/situacoes/${s}`,{method:"PATCH"}); }
    catch(e){ /* segue pros próximos passos */ }
    await new Promise(r=>setTimeout(r,350));
  }
}
async function atualizarParcelasBling(id,parcelas,opts={}){
  const SIT_EM_DIGITACAO=21;
  const STATUS_BLOQUEADOS=[SIT.EM_SEP,SIT.SEP_PEND,SIT.SEPARADO,SIT.CONF_ENTREGA,SIT.EM_ROTA,SIT.ATENDIDO];
  try{
    const rPed=opts.ped?{data:opts.ped}:await bling(`/pedidos/vendas/${id}`);
    const ped=rPed?.data; if(!ped) return {ok:false,erro:"pedido não encontrado"};
    const sitAtual=ped.situacao?.id;
    if(sitAtual===SIT.CANCELADO) return {ok:false,erro:"Pedido Cancelado não pode ser editado."};
    const precisaUnlock=STATUS_BLOQUEADOS.includes(sitAtual);
    // modo "somar": mantém as parcelas que já existem no pedido no Bling e
    // acrescenta as novas (usado em pagamento adicional) — em vez de substituir
    let parcelasFinais=parcelas;
    if(opts.append){
      const parcelasExistentes=(ped.parcelas||[]).map(p=>({valor:p.valor,formaId:p.formaPagamento?.id})).filter(p=>p.formaId&&(Number(p.valor)||0)>0);
      parcelasFinais=[...parcelasExistentes,...parcelas];
    }
    const payload={
      data:ped.data,
      contato:{id:ped.contato?.id},
      itens:(ped.itens||[]).map(i=>({produto:{id:i.produto?.id},quantidade:i.quantidade,valor:i.valor})),
      observacoes:[String(ped.observacoes||"").trim(), String(opts.obsExtra||"").trim()].filter(Boolean).join("\n"),
      parcelas:parcelasFinais.filter(p=>(Number(p.valor)||0)>0).map(p=>({
        formaPagamento:{id:p.formaId}, dataVencimento:ped.data, valor:+Number(p.valor).toFixed(2),
      })),
    };
    if(ped.transporte) payload.transporte={
      fretePorConta:ped.transporte.fretePorConta??0, frete:ped.transporte.frete||0,
      ...(ped.transporte.enderecoEntrega?{enderecoEntrega:ped.transporte.enderecoEntrega}:{}),
    };
    if(ped.vendedor?.id) payload.vendedor={id:ped.vendedor.id};
    if(ped.loja?.id) payload.loja={id:ped.loja.id};
    // preserva desconto e outras despesas (senão o PUT zera no Bling)
    if(ped.desconto&&ped.desconto.valor!=null) payload.desconto={valor:Number(ped.desconto.valor)||0,unidade:ped.desconto.unidade||"REAL"};
    if(opts.outrasDespesas!=null) payload.outrasDespesas=+Number(opts.outrasDespesas).toFixed(2);
    else if(ped.outrasDespesas!=null) payload.outrasDespesas=+Number(ped.outrasDespesas).toFixed(2);

    let resultado, fezUnlock=false, restauracao=null;
    try{
      resultado=await bling(`/pedidos/vendas/${id}`,{method:"PUT",body:JSON.stringify(payload)});
    }catch(e1){
      // qualquer erro na 1ª tentativa, se o pedido estava numa situação bloqueada,
      // tenta o caminho de desbloquear/editar/restaurar — antes só tentava quando
      // o erro vinha com status exatamente 400, mas o Bling nem sempre retorna
      // esse código pra "situação bloqueada", o que fazia falhar silenciosamente
      // (o pagamento ficava salvo aqui no sistema, mas não ia pro Bling)
      if(!precisaUnlock) throw e1;
      // situação bloqueada — desbloqueia tentando situações editáveis que este Bling aceite
      const sitDestravado=await _destravarSituacao(id);
      if(!sitDestravado) throw e1;
      fezUnlock=true;
      await new Promise(r=>setTimeout(r,400));
      try{
        resultado=await bling(`/pedidos/vendas/${id}`,{method:"PUT",body:JSON.stringify(payload)});
      }finally{
        // sempre restaura a situação original (caminhando até ela), mesmo se o PUT falhar.
        // Atendido/Separado: com retry (o Bling pode reclamar de estoque na re-baixa).
        await new Promise(r=>setTimeout(r,400));
        if(sitAtual===SIT.ATENDIDO||sitAtual===SIT.SEPARADO){
          const itensEst=(ped.itens||[]).map(i=>({produtoId:i.produto?.id,nome:i.descricao||"",quantidade:i.quantidade}));
          restauracao=await _restaurarSituacaoComRetry(id, sitAtual, itensEst);
        } else {
          await _restaurarSituacao(id, sitAtual);
        }
      }
    }
    return {ok:true,resposta:resultado,fezUnlock,restauracao};
  }catch(e){ console.error("[atualizarParcelasBling] falhou pedido",id,"status",e.status,"body:",JSON.stringify(e.body||{})); return {ok:false,erro:e.message,status:e.status,body:e.body}; }
}

// acrescenta uma nota nas observações do pedido no Bling (sem apagar o que já
// tinha escrito) — usado pra registrar valor previsto x valor efetivamente
// pago quando teve abatimento por item danificado/não entregue na entrega.
// Usa o mesmo esquema de desbloquear/editar/restaurar situação quando necessário.
async function acrescentarObservacaoBling(id,notaAdicional){
  const SIT_EM_DIGITACAO=21;
  const STATUS_BLOQUEADOS=[SIT.EM_SEP,SIT.SEP_PEND,SIT.SEPARADO,SIT.CONF_ENTREGA,SIT.EM_ROTA];
  try{
    const rPed=await bling(`/pedidos/vendas/${id}`);
    const ped=rPed?.data; if(!ped) return {ok:false,erro:"pedido não encontrado"};
    const sitAtual=ped.situacao?.id;
    const precisaUnlock=STATUS_BLOQUEADOS.includes(sitAtual);
    const obsAtual=ped.observacoes||"";
    const payload={
      data:ped.data,
      contato:{id:ped.contato?.id},
      itens:(ped.itens||[]).map(i=>({produto:{id:i.produto?.id},quantidade:i.quantidade,valor:i.valor})),
      observacoes:(obsAtual?obsAtual+"\n":"")+notaAdicional,
      ...(ped.parcelas?.length?{parcelas:ped.parcelas.map(p=>({formaPagamento:{id:p.formaPagamento?.id},dataVencimento:p.dataVencimento||ped.data,valor:p.valor}))}:{}),
    };
    if(ped.transporte) payload.transporte={
      fretePorConta:ped.transporte.fretePorConta??0, frete:ped.transporte.frete||0,
      ...(ped.transporte.enderecoEntrega?{enderecoEntrega:ped.transporte.enderecoEntrega}:{}),
    };
    if(ped.vendedor?.id) payload.vendedor={id:ped.vendedor.id};
    if(ped.loja?.id) payload.loja={id:ped.loja.id};

    const tentarPut=()=>bling(`/pedidos/vendas/${id}`,{method:"PUT",body:JSON.stringify(payload)});
    let fezUnlock=false;
    try{
      await tentarPut();
    }catch(e1){
      if(!precisaUnlock) throw e1;
      await bling(`/pedidos/vendas/${id}/situacoes/${SIT_EM_DIGITACAO}`,{method:"PATCH"});
      fezUnlock=true;
      await new Promise(r=>setTimeout(r,400));
      try{
        await tentarPut();
      }finally{
        await new Promise(r=>setTimeout(r,400));
        for(let t=0;t<3;t++){
          try{ await bling(`/pedidos/vendas/${id}/situacoes/${sitAtual}`,{method:"PATCH"}); break; }
          catch(e){ await new Promise(r=>setTimeout(r,600*(t+1))); }
        }
      }
    }
    return {ok:true,fezUnlock};
  }catch(e){ console.error("[acrescentarObservacaoBling] falhou pedido",id,"status",e.status,"body:",JSON.stringify(e.body||{})); return {ok:false,erro:e.message,status:e.status,body:e.body}; }
}

// extrai o maximo de detalhe possivel de um erro do Bling — a mensagem
// generica ("houveram erros de validacao") normalmente vem acompanhada de uma
// lista de campos especificos com o motivo real, que a mensagem sozinha nao mostra
function detalheErroBling(resultado){
  if(!resultado) return "erro desconhecido";
  const body=resultado.body;
  const campos=body?.error?.fields;
  if(Array.isArray(campos)&&campos.length){
    return campos.map(f=>`${f.element||f.field||"?"}: ${f.msg||f.message||JSON.stringify(f)}`).join(" | ");
  }
  return resultado.erro||"erro desconhecido";
}

app.post("/api/pagamentos/:id",async(req,res)=>{
  try{
    const {valor,formaId,formaNome,obs,funcionarioId,funcionarioNome,substituir,valorEsperado,parcelas,somar}=req.body||{};
    if(!valor||!formaId) return res.status(400).json({erro:"valor e formaId obrigatórios"});
    if(Number(valor)<0) return res.status(400).json({erro:"Valor de pagamento não pode ser negativo"});
    // se o chamador informou qual valor era esperado (ex: total já ajustado por
    // ocorrências na entrega), valida que bate exatamente — defesa extra além
    // da trava no frontend
    if(valorEsperado!=null){
      const diff=+(Number(valor)-Number(valorEsperado)).toFixed(2);
      if(Math.abs(diff)>0.01){
        return res.status(400).json({erro:`Valor informado (R$ ${Number(valor).toFixed(2)}) não bate com o valor esperado (R$ ${Number(valorEsperado).toFixed(2)}).`});
      }
    }
    const pags=lerPag(); const id=String(req.params.id);
    if(!pags[id]) pags[id]={pedidoId:id,valorPago:0,historico:[],statusPagamento:"pendente"};
    const p=pags[id];
    // suporta múltiplas formas de pagamento (split) — registra uma entrada por parcela
    const listaParcelas=Array.isArray(parcelas)&&parcelas.length
      ? parcelas
      : [{valor,formaId,formaNome,obs}];
    // substituir=true: reinicia o valor (não soma). somar=true: força somar,
    // mesmo que já tivesse pago antes (ex: pagamento adicional de verdade,
    // que não deve ser confundido com uma repetição da mesma ação).
    // Sem nenhuma das duas flags explícitas, cai no heurístico antigo (evita
    // duplicar valor se a mesma tela for reenviada sem querer).
    const jaTinhaPago=(p.statusPagamento==="pago"||p.statusPagamento==="parcial")&&(p.valorPago||0)>0;
    const modoSubstituir=somar?false:(substituir||jaTinhaPago);
    if(modoSubstituir){
      p.historico.push({valor:Number(valor),formaId,formaNome,obs,funcionarioId,funcionarioNome,em:Date.now(),tipo:"substituicao",valorAnterior:p.valorPago||0});
      listaParcelas.forEach(pc=>{
        const v=Number(pc.valor)||0; if(v<=0) return;
        p.historico.push({valor:v,formaId:pc.formaId,formaNome:pc.formaNome,obs:pc.obs||"",funcionarioId,funcionarioNome,em:Date.now(),tipo:"substituicao_detalhe"});
      });
      p.valorPago=+Number(valor).toFixed(2);
    } else {
      p.valorPago=+(p.valorPago+Number(valor)).toFixed(2);
      listaParcelas.forEach(pc=>{
        const v=Number(pc.valor)||0; if(v<=0) return;
        p.historico.push({valor:v,formaId:pc.formaId,formaNome:pc.formaNome,obs:pc.obs||"",funcionarioId,funcionarioNome,em:Date.now(),tipo:"normal"});
      });
    }
    // busca total do pedido pra comparar
    try{
      const ped=await bling(`/pedidos/vendas/${id}`); const total=ped?.data?.total||0;
      p.valorPedido=+Number(total).toFixed(2);
      p.statusPagamento=p.valorPago>=p.valorPedido?"pago":p.valorPago>0?"parcial":"pendente";
    }catch(e){}
    salvarPag(pags);
    addLog(id, "pagamento_registrado", funcionarioId, funcionarioNome, {valor:Number(valor),formaNome,statusPagamento:p.statusPagamento});
    // lança a(s) forma(s) de pagamento no Bling de verdade. Se for pagamento
    // adicional (somar), mantém as parcelas que já existiam lá e acrescenta;
    // senão, substitui a parcela única "placeholder" pelas parcelas reais.
    const parcelasParaBling=(listaParcelas.length?listaParcelas:[{valor,formaId}]).map(pc=>({valor:pc.valor,formaId:pc.formaId}));
    const blingFinanceiroResultado=await atualizarParcelasBling(id,parcelasParaBling,{append:!!somar});
    // avisa o front se a sincronização com o Bling falhou — antes respondia
    // ok:true mesmo quando o Bling não recebia a forma de pagamento nova,
    // e ninguém ficava sabendo (o pagamento ficava só salvo aqui no sistema)
    const avisoBling=blingFinanceiroResultado.ok?null:`⚠️ Pagamento salvo no sistema, mas NÃO foi possível atualizar a forma de pagamento no Bling: ${detalheErroBling(blingFinanceiroResultado)}. Confira/ajuste manualmente no Bling.`;
    if(avisoBling) addLog(id,"erro_sync_pagamento_bling",funcionarioId,funcionarioNome,{erro:detalheErroBling(blingFinanceiroResultado),status:blingFinanceiroResultado.status||null,bodyBruto:JSON.stringify(blingFinanceiroResultado.body||{}).slice(0,500)});
    res.json({ok:true,pagamento:p,_blingFinanceiro:blingFinanceiroResultado,avisoBling});
  }catch(e){ res.status(500).json({erro:e.message}); }
});
app.get("/api/pagamentos",(req,res)=>{ res.json({data:lerPag()}); });
app.post("/api/pagamentos/:id/resetar",(req,res)=>{
  const id=String(req.params.id); const {funcionarioId,funcionarioNome}=req.body||{};
  const pags=lerPag();
  if(pags[id]){
    const antigo=pags[id].valorPago||0;
    pags[id].valorPago=0; pags[id].statusPagamento="pendente";
    pags[id].historico=pags[id].historico||[];
    pags[id].historico.push({valor:0,tipo:"resetado",em:Date.now(),funcionarioId,funcionarioNome,valorAnterior:antigo});
    salvarPag(pags);
    addLog(id,"pagamento_resetado",funcionarioId,funcionarioNome,{valorAnterior:antigo});
  }
  res.json({ok:true});
});

// Parcela "à vista": vencimento no mesmo dia (ou antes) da data da venda.
// O Bling baixa esse tipo de parcela automaticamente no caixa/banco na hora
// que o pedido é salvo, então não gera conta a receber em aberto — tratamos
// como paga. Parcela a prazo (vencimento futuro) fica pendente.
function parcelaEhAVista(p,ped){
  if(!p?.dataVencimento||!ped?.data) return false;
  return String(p.dataVencimento)<=String(ped.data);
}

// Cache de nomes de forma de pagamento do Bling (busca a lista inteira 1x só)
const _formaPagCache={};
async function nomeFormaPagamentoId(id){
  if(!id) return "Não identificada";
  if(_formaPagCache[id]) return _formaPagCache[id];
  try{
    const r=await bling("/formas-pagamentos");
    (r?.data||[]).forEach(f=>{ _formaPagCache[f.id]=f.descricao||f.nome||`Forma ${f.id}`; });
  }catch(e){}
  return _formaPagCache[id]||`Forma ${id}`;
}

// ===== GESTÃO DE NFC-e =====
// Puxa do Bling os pedidos em "Aguardando Separação" (situação criada só pelo nosso
// sistema: totem, site e atacado) pra emitir a NFC-e depois, em vez de na finalização.
function lerNfceEmitidas(){ return lerJSON(NFCE_EMITIDAS_FILE,{}); }
function salvarNfceEmitidas(d){ salvarJSON(NFCE_EMITIDAS_FILE,d); }

// LISTA rápida dos pedidos aguardando separação (dados básicos; produtos e formas
// são carregados por pedido no /detalhe, pra não travar com dezenas de chamadas)
app.get("/api/nfce/pedidos-aguardando",async(req,res)=>{
  try{
    const sit=SIT.AGUARDANDO;
    let pedidos=[], pagina=1;
    for(let i=0;i<5;i++){ // até 500 pedidos
      const p=new URLSearchParams({pagina:String(pagina), limite:"100"});
      p.append("idsSituacoes[]", String(sit));
      const r=await bling(`/pedidos/vendas?${p.toString()}`);
      const arr=r?.data||[];
      pedidos=pedidos.concat(arr);
      if(arr.length<100) break;
      pagina++; await sleep(150);
    }
    const emitidas=lerNfceEmitidas();
    const lista=pedidos.map(pd=>({
      id:pd.id, numero:pd.numero,
      cliente:pd.contato?.nome||"—",
      data:pd.data||"", total:pd.total||0,
      jaEmitida: !!emitidas[String(pd.id)],
      nfce: emitidas[String(pd.id)]||null,
    })).sort((a,b)=>Number(b.numero||0)-Number(a.numero||0));
    res.json({data:lista, total:lista.length});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// EMITE a NFC-e de um pedido (mesma chamada usada na finalização: gera + envia).
// Registra em NFCE_EMITIDAS_FILE pra não emitir duas vezes e mostrar como emitida.
app.post("/api/nfce/pedido/:id/emitir",async(req,res)=>{
  try{
    const idOuNumero=String(req.params.id);
    const emitidas=lerNfceEmitidas();
    if(emitidas[idOuNumero]) return res.status(400).json({erro:"Esse pedido já teve NFC-e emitida.", nfce:emitidas[idOuNumero]});
    // RESOLVE o pedido: tenta pelo id interno; se não achar, tenta pelo número.
    let pedidoId=null;
    try{ const d=await bling(`/pedidos/vendas/${idOuNumero}`).then(r=>r?.data); if(d?.id) pedidoId=d.id; }catch(e){}
    if(!pedidoId){
      try{ const r=await bling(`/pedidos/vendas?numero=${encodeURIComponent(idOuNumero)}`); const a=(r?.data||[])[0]; if(a?.id) pedidoId=a.id; }catch(e){}
    }
    if(!pedidoId) return res.status(404).json({erro:`Pedido não encontrado no Bling (id/número ${idOuNumero}). Pode ter sido excluído ou o registro do caixa está com um id diferente.`});
    if(emitidas[String(pedidoId)]) return res.status(400).json({erro:"Esse pedido já teve NFC-e emitida.", nfce:emitidas[String(pedidoId)]});
    // gera a NFC-e a partir do pedido (igual o botão "Gerar NFC-e" do Bling)
    const gerado=await bling(`/pedidos/vendas/${pedidoId}/gerar-nfce`,{method:"POST"});
    const idNotaFiscal=gerado?.data?.id||gerado?.data?.idNotaFiscal||null;
    if(!idNotaFiscal) return res.status(400).json({erro:"O Bling não retornou o ID da NFC-e gerada.", detalhe:gerado});
    let link=null, envioErro=null, numeroNota=null;
    try{
      await bling(`/nfce/${idNotaFiscal}/enviar`,{method:"POST"});
      try{ const det=await bling(`/nfce/${idNotaFiscal}`); link=det?.data?.linkDanfe||det?.data?.linkPDF||null; numeroNota=det?.data?.numero||null; }catch(e){}
    }catch(e){ envioErro=e.message; } // nota gerada mas não transmitida — fica "Pendente" no Bling, dá pra reenviar
    const registro={ idNotaFiscal, numeroNota, link, em:Date.now(), por:(req.body?.operador||""), envioErro:envioErro||null };
    emitidas[String(pedidoId)]=registro;
    if(String(pedidoId)!==idOuNumero) emitidas[idOuNumero]=registro; // marca pelos dois pra não duplicar
    salvarNfceEmitidas(emitidas);
    res.json({ok:true, pedidoId, nfce:registro, envioErro});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// DIAGNÓSTICO FISCAL: pra cada produto do pedido, mostra o que o Bling tem de dado
// fiscal (NCM, origem, CEST, GTIN) e o que está faltando pra emitir NFC-e. Não altera
// nada — só lê. Os CST/CSOSN de ICMS/PIS/COFINS vêm do grupo de tributação / natureza
// de operação no Bling (definidos com o contador), então aqui a gente sinaliza os
// campos-base do produto e devolve o bloco fiscal cru pra conferência.
app.get("/api/nfce/diagnostico-fiscal/:pedidoId",async(req,res)=>{
  try{
    const ped=await bling(`/pedidos/vendas/${req.params.pedidoId}`).then(r=>r?.data);
    if(!ped) return res.status(404).json({erro:"pedido não encontrado"});
    const itens=ped.itens||[];
    const produtos=[];
    for(const it of itens){
      const pid=it.produto?.id;
      let prod=null;
      try{ prod=await bling(`/produtos/${pid}`).then(r=>r?.data); }catch(e){}
      const trib=prod?.tributacao||{};
      const faltando=[];
      if(!trib.ncm) faltando.push("NCM");
      if(trib.origem===undefined||trib.origem===null||trib.origem==="") faltando.push("Origem");
      produtos.push({
        id:pid, nome:it.descricao||prod?.nome||"produto",
        ncm:trib.ncm||null,
        origem:(trib.origem!==undefined?trib.origem:null),
        cest:trib.cest||null,
        gtin:prod?.gtin||prod?.codigo||null,
        tributacao:trib,   // bloco fiscal cru pra conferência
        faltando,
      });
      await sleep(120);
    }
    res.json({
      pedidoId:ped.id, numero:ped.numero,
      naturezaOperacao: ped.naturezaOperacao||null,
      produtos,
      produtosComPendencia: produtos.filter(p=>p.faltando.length).length,
    });
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// LISTA as vendas do CAIXA ATACADO do mês vigente. Produtos e formas já vêm do
// movimento do caixa — rápido, sem consultar o Bling item a item.
// NFC-e realmente emitidas no Bling (endpoint /nfce) — usado pra cruzar com as vendas
// e saber o que de fato tem nota, inclusive as emitidas direto no PDV do varejo.
app.get("/api/nfce/emitidas-bling",async(req,res)=>{
  try{
    const dias=Math.min(Number(req.query.dias||7),31);
    const ini=new Date(Date.now()-dias*86400000);
    const di=`${ini.getFullYear()}-${String(ini.getMonth()+1).padStart(2,"0")}-${String(ini.getDate()).padStart(2,"0")}`;
    const df=_hojeISO();
    let arr=[], pag=1;
    for(let i=0;i<10;i++){
      const r=await bling(`/nfce?dataEmissaoInicial=${di} 00:00:00&dataEmissaoFinal=${df} 23:59:59&pagina=${pag}&limite=100`);
      const d=r?.data||[]; arr=arr.concat(d);
      if(d.length<100) break; pag++; await sleep(150);
    }
    const notas=arr.map(n=>({ id:n.id, numero:n.numero, serie:n.serie, dataEmissao:n.dataEmissao,
      situacao:Number(n.situacao), autorizada:Number(n.situacao)===5,
      cliente:n.contato?.nome||"—", valor:Number(n.valorNota??n.valor??0) }));
    res.json({ dias, total:notas.length, autorizadas:notas.filter(n=>n.autorizada).length, data:notas });
  }catch(e){ res.status(e.status||500).json({erro:e.message}); }
});

app.get("/api/nfce/vendas-caixa-atacado",(req,res)=>{
  try{
    const now=new Date();
    const ini=new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const fim=new Date(now.getFullYear(), now.getMonth()+1, 1).getTime();
    const emitidas=lerNfceEmitidas();
    const dCx=lerCaixaSessoes();
    const porPedido={};
    (dCx.sessoes||[]).forEach(s=>{
      if((s.tipoCaixa||"frente")!=="atacado") return; // só caixa atacado
      (s.movimentos||[]).forEach(m=>{
        if(m.tipo!=="venda" || m.cancelado) return;
        if(!(m.em>=ini && m.em<fim)) return; // mês vigente
        const pid=String(m.pedidoId);
        // mesmo pedido pode ter +de 1 movimento (reaberto/editado) — fica o mais recente
        if(porPedido[pid] && porPedido[pid]._em>=m.em) return;
        porPedido[pid]={
          pedidoId:m.pedidoId, numero:m.numero||m.pedidoId,
          cliente:m.clienteNome||"Consumidor Final",
          em:m.em, _em:m.em, total:m.total||0,
          produtos:(m.itens||[]).map(i=>({nome:i.nome||"produto",quantidade:i.quantidade,valor:i.valor})),
          formas:(m.pagamentos||[]).map(p=>({forma:p.formaNome||"—",valor:p.valor})),
          operador:m.operador||"",
          jaEmitida: !!emitidas[pid], nfce: emitidas[pid]||null,
        };
      });
    });
    const vendas=Object.values(porPedido).map(v=>{ delete v._em; return v; }).sort((a,b)=>b.em-a.em);
    res.json({data:vendas, total:vendas.length, mes:`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// DETALHE de um pedido: produtos e formas de pagamento (resolve o nome da forma)
app.get("/api/nfce/pedido/:id/detalhe",async(req,res)=>{
  try{
    const d=await bling(`/pedidos/vendas/${req.params.id}`).then(r=>r?.data);
    if(!d) return res.status(404).json({erro:"pedido não encontrado"});
    const produtos=(d.itens||[]).map(it=>({
      nome: it.descricao||it.produto?.nome||"produto",
      quantidade: it.quantidade, valor: it.valor,
    }));
    const formas=[];
    for(const pc of (d.parcelas||[])){
      const nome=await nomeFormaPagamentoId(pc.formaPagamento?.id);
      formas.push({ forma:nome, valor:pc.valor });
    }
    const emitidas=lerNfceEmitidas();
    res.json({
      id:d.id, numero:d.numero, cliente:d.contato?.nome||"—", total:d.total||0,
      produtos, formas,
      jaEmitida: !!emitidas[String(d.id)], nfce: emitidas[String(d.id)]||null,
    });
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// Busca reversa: acha o ID de uma forma de pagamento pelo nome (ex: "Ficha Financeira")
let _formaPagIdPorNomeCache={};
async function getFormaPagamentoIdPorNome(nomeAlvo){
  const chave=nomeAlvo.toLowerCase();
  if(_formaPagIdPorNomeCache[chave]!==undefined) return _formaPagIdPorNomeCache[chave];
  try{
    const r=await bling("/formas-pagamentos");
    const achado=(r?.data||[]).find(f=>(f.descricao||f.nome||"").toLowerCase().includes(chave));
    _formaPagIdPorNomeCache[chave]=achado?.id||null;
  }catch(e){ _formaPagIdPorNomeCache[chave]=null; }
  return _formaPagIdPorNomeCache[chave];
}

// Buscar histórico de pagamento de um pedido específico
app.get("/api/pagamentos/:id",async(req,res)=>{
  try{
    const pags=lerPag(); const id=String(req.params.id);
    const pagLocal=pags[id]||null;
    
    // Se tem pagamento local, verifica divergência com Bling
    if(pagLocal){
      // registros antigos podem ter sido gravados sem statusPagamento — infere pra não aparecer como "não pago"
      if(!pagLocal.statusPagamento){
        const vp=Number(pagLocal.valorPago||0), vped=Number(pagLocal.valorPedido||0);
        pagLocal.statusPagamento = vped>0 ? (vp>=vped-0.05?"pago":(vp>0?"parcial":"pendente")) : (vp>0?"pago":"pendente");
      }
      try{
        const rPed=await bling(`/pedidos/vendas/${id}`);
        const ped=rPed?.data||{};
        const parcelas=ped.parcelas||[];
        const parcelasPagas=parcelas.filter(p=>parcelaEhAVista(p,ped));
        if(parcelasPagas.length>0){
          const valorBling=+parcelasPagas.reduce((s,p)=>s+(p.valor||0),0).toFixed(2);
          const valorLocal=+(pagLocal.valorPago||0);
          const diff=Math.abs(valorBling-valorLocal);
          if(diff>0.05){
            return res.json({data:{...pagLocal,_divergencia:{
              valorLocal,valorBling,
              diff:+(valorBling-valorLocal).toFixed(2),
              msg:`Divergência: sistema R$ ${valorLocal.toFixed(2)}, Bling R$ ${valorBling.toFixed(2)}`
            }}});
          }
        }
      }catch(e){ /* silencioso */ }
      return res.json({data:pagLocal});
    }

    // Verifica se passou pelo nosso fluxo
    const logPedido=(lerLog()[id]||[]);
    const passouPeloNossoFluxo=logPedido.some(e=>
      ["pedido_criado_totem","separar_para_entregar","enviado_separacao_pago","pedido_aberto_separacao",
       "separacao_completa","separacao_com_falta","conferido_entrega","conferido_retirada",
       "pagamento_registrado","recebido_cliente_separou"].includes(e.evento)
    );
    if(passouPeloNossoFluxo) return res.json({data:null});

    // Pedido do Bling direto — verifica parcelas (mesma lógica usada no fechamento de caixa)
    const rPed=await bling(`/pedidos/vendas/${id}`);
    const ped=rPed?.data||{};
    const totalPed=+(ped.total||ped.totalProdutos||0);
    const resolvido=await resolverPagamentoPedido(ped,null,logPedido);
    if(resolvido.valorPago>0.01){
      return res.json({data:{
        pedidoId:id,valorPago:resolvido.valorPago,valorPedido:totalPed,
        statusPagamento:resolvido.statusPagamento,
        historico:resolvido.historico,
        _doBling:true
      }});
    }
    res.json({data:null});
  }catch(e){ res.json({data:null}); }
});




app.get("/api/formas-pagamento",async(req,res)=>{
  // tenta o Bling primeiro com endpoint correto
  try{
    const r=await bling("/formas-pagamentos");
    if(r?.data?.length) return res.json({data:r.data.map(f=>({id:f.id,nome:f.descricao||f.nome||String(f.id)}))});
  }catch(e){}
  // fallback: formas salvas localmente
  try{ const salvas=JSON.parse(fs.readFileSync(FPAG_FILE,"utf8"));
    res.json({data:salvas.length?salvas:FPAG_DEFAULT}); }
  catch(e){ res.json({data:FPAG_DEFAULT}); }
});
app.post("/api/formas-pagamento",(req,res)=>{
  const {formas}=req.body||{};
  if(!Array.isArray(formas)) return res.status(400).json({erro:"formas deve ser array"});
  fs.writeFileSync(FPAG_FILE,JSON.stringify(formas));
  res.json({ok:true,total:formas.length});
});

// ---- FLUXO DE PEDIDOS ----
// Enviar pedido pra separação (com ou sem pagamento)
app.post("/api/fluxo/:id/enviar-separacao",async(req,res)=>{
  try{
    const {funcionarioId,funcionarioNome,pagamento}=req.body||{};
    const id=String(req.params.id);
    // pedido de RETIRADA precisa sempre receber o pagamento antes de separar —
    // não existe "retirar sem pagar". Se não veio pagamento junto, bloqueia.
    if(!pagamento?.valor){
      const entregas=lerJSON(ENTREGAS_FILE,{});
      const entInfo=entregas[id]||null;
      let ehEntrega=entInfo?entInfo.tipo==="entrega":null;
      if(ehEntrega===null){
        try{
          const ped=await bling(`/pedidos/vendas/${id}`).then(r=>r?.data);
          const freteCalc=+(((ped?.total||0)-(ped?.totalProdutos||0))).toFixed(2);
          ehEntrega=freteCalc>0.01;
        }catch(e){ ehEntrega=true; } // se não conseguir checar, não bloqueia (evita falso positivo)
      }
      if(!ehEntrega){
        return res.status(400).json({erro:"Pedido de RETIRADA precisa receber o pagamento antes de ir pra separação."});
      }
    }
    // registra pagamento se veio — valida no servidor que o valor bate
    // EXATAMENTE com o total do pedido (não confia só na checagem do navegador)
    if(pagamento?.valor&&pagamento?.formaId){
      const ped=await bling(`/pedidos/vendas/${id}`).then(r=>r?.data).catch(()=>null);
      const totalPed=+(ped?.total||ped?.totalProdutos||0);
      const valorInformado=+Number(pagamento.valor).toFixed(2);
      const diff=+(valorInformado-totalPed).toFixed(2);
      if(Math.abs(diff)>0.01){
        return res.status(400).json({erro:`Valor do pagamento (R$ ${valorInformado.toFixed(2)}) não confere com o total do pedido (R$ ${totalPed.toFixed(2)}). ${diff>0?"Valor maior":"Valor menor"} que o esperado.`});
      }
      const pags=lerPag();
      if(!pags[id]) pags[id]={pedidoId:id,valorPago:0,historico:[],statusPagamento:"pendente"};
      // se o pedido já tinha pagamento registrado (voltou pra essa etapa por
      // algum motivo), NÃO soma — o valor informado já é o total confirmado,
      // então substitui, deixando um marcador no histórico pra auditoria
      const jaTinhaPago=(pags[id].statusPagamento==="pago"||pags[id].statusPagamento==="parcial")&&(pags[id].valorPago||0)>0;
      if(jaTinhaPago){
        pags[id].historico.push({valor:valorInformado,formaId:pagamento.formaId,formaNome:pagamento.formaNome,funcionarioId,funcionarioNome,em:Date.now(),tipo:"substituicao",valorAnterior:pags[id].valorPago});
      }
      // suporta múltiplas formas de pagamento (split) — registra uma entrada por parcela
      const parcelas=Array.isArray(pagamento.parcelas)&&pagamento.parcelas.length
        ? pagamento.parcelas
        : [{valor:pagamento.valor,formaId:pagamento.formaId,formaNome:pagamento.formaNome,obs:""}];
      parcelas.forEach(pc=>{
        const v=Number(pc.valor)||0; if(v<=0) return;
        pags[id].historico.push({valor:v,formaId:pc.formaId,formaNome:pc.formaNome,obs:pc.obs||"",funcionarioId,funcionarioNome,em:Date.now()});
      });
      pags[id].valorPago=valorInformado; // sempre = valor confirmado, nunca soma com o que já existia
      pags[id].statusPagamento="pago"; salvarPag(pags);
      // lança a(s) forma(s) de pagamento no Bling de verdade
      await atualizarParcelasBling(id,parcelas.map(pc=>({valor:pc.valor,formaId:pc.formaId})));
    }
    // muda status no Bling
    await bling(`/pedidos/vendas/${id}/situacoes/${SIT.EM_SEP}`,{method:"PATCH"});
    addLog(id, pagamento?.valor?"enviado_separacao_pago":"separar_para_entregar", funcionarioId, funcionarioNome, pagamento?{valor:pagamento.valor,formaNome:pagamento.formaNome}:{});
    res.json({ok:true});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// Registrar resultado da expedição (separado ou separado c/ pendências)
app.post("/api/fluxo/:id/separacao-concluida",async(req,res)=>{
  try{
    const {faltas,texto}=req.body||{}; const id=String(req.params.id);
    const temFalta=faltas&&faltas.length>0;
    const novoSit=temFalta?SIT.SEP_PEND:SIT.SEPARADO;
    if(!novoSit) return res.status(400).json({erro:"Status SEPARADO/SEP_PEND não configurado. Configure SIT_SEPARADO e SIT_SEP_PEND no Railway."});
    // registra pendências
    if(temFalta){
      const pend=lerPend();
      const ped=await bling(`/pedidos/vendas/${id}`).then(r=>r.data).catch(()=>({}));
      pend[id]={pedidoId:id,numero:ped.numero,cliente:ped.contato?.nome||"",telefone:ped.contato?.celular||"",faltas,sugestao:"",status:"pendente",em:Date.now()};
      salvarPend(pend);
      if(texto) try{ await bling(`/pedidos/vendas/${id}`,{method:"PUT",body:JSON.stringify({data:ped.data,contato:{id:ped.contato?.id},itens:(ped.itens||[]).map(i=>({produto:{id:i.produto?.id},quantidade:i.quantidade,valor:i.valor})),observacoes:(ped.observacoes?ped.observacoes+" | ":"")+texto})}); }catch(e){}
    }
    await bling(`/pedidos/vendas/${id}/situacoes/${novoSit}`,{method:"PATCH"});
    addLog(id, temFalta?"separacao_com_falta":"separacao_completa", req.body?.funcionarioId, req.body?.funcionarioNome, temFalta?{faltas}:{});
    // libera o lock ao concluir separação
    liberarLock(id, req.body?.funcionarioId, req.body?.funcionarioNome, "separacao_concluida");
    res.json({ok:true,situacao:novoSit,temFalta});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// Registrar acréscimo/retirada e voltar pra expedição
app.post("/api/fluxo/:id/acrescimo",async(req,res)=>{
  try{
    const {itensNovos,itensRetirados,numero,cliente}=req.body||{}; const id=String(req.params.id);
    const acrs=lerJSON(ACRS_FILE,{});
    acrs[id]={pedidoId:id,numero,cliente,itensNovos:itensNovos||[],itensRetirados:itensRetirados||[],em:Date.now(),status:"pendente"};
    salvarJSON(ACRS_FILE,acrs);
    const {funcionarioId,funcionarioNome}=req.body||{};
    // log detalhado de cada item acrescentado/retirado
    if(itensNovos?.length) addLog(id,"itens_acrescentados",funcionarioId,funcionarioNome,{itens:itensNovos.map(i=>i.descricao)});
    if(itensRetirados?.length) addLog(id,"itens_retirados",funcionarioId,funcionarioNome,{itens:itensRetirados.map(i=>i.descricao)});
    addLog(id,"voltou_separacao",funcionarioId,funcionarioNome,{motivo:"acréscimo/retirada"});
    // volta pra em separação
    await bling(`/pedidos/vendas/${id}/situacoes/${SIT.EM_SEP}`,{method:"PATCH"});
    // atualiza pagamento: recalcula diferença
    const pags=lerPag();
    if(pags[id]){
      const ped=await bling(`/pedidos/vendas/${id}`).then(r=>r.data).catch(()=>null);
      if(ped) { pags[id].valorPedido=+Number(ped.total).toFixed(2);
        pags[id].statusPagamento=pags[id].valorPago>=pags[id].valorPedido?"pago":pags[id].valorPago>0?"parcial":"pendente";
        salvarPag(pags); }
    }
    res.json({ok:true});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// Seguir sem pendências (pedido c/ pendências vai direto pra SEPARADO sem voltar expedição)
app.post("/api/fluxo/:id/seguir-sem-pendencias",async(req,res)=>{
  try{
    const id=String(req.params.id); const {funcionarioId,funcionarioNome}=req.body||{};
    if(!SIT.SEPARADO) return res.status(400).json({erro:"Status SEPARADO não configurado"});
    await bling(`/pedidos/vendas/${id}/situacoes/${SIT.SEPARADO}`,{method:"PATCH"});
    const pend=lerPend(); if(pend[id]){pend[id].status="resolvido";salvarPend(pend);}
    liberarLock(id,funcionarioId,funcionarioNome,"seguiu_sem_pendencias");
    addLog(id,"seguiu_sem_pendencias",funcionarioId,funcionarioNome,{});
    res.json({ok:true});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// Conferência final → entrega vai pra EM ROTA, retirada vai pra ATENDIDO
app.post("/api/fluxo/:id/conferido",async(req,res)=>{
  try{
    const {funcionarioId,funcionarioNome,tipoEntrega}=req.body||{}; const id=String(req.params.id);
    const pags=lerPag(); const pag=pags[id]||null;
    const pago=pag&&pag.statusPagamento==="pago";
    const novoSit=tipoEntrega==="retirada"?SIT.ATENDIDO:SIT.EM_ROTA;
    if(!novoSit) return res.status(400).json({erro:"Status EM_ROTA ou ATENDIDO não configurado."});
    await bling(`/pedidos/vendas/${id}/situacoes/${novoSit}`,{method:"PATCH"});
    liberarLock(id,funcionarioId,funcionarioNome,"conferido");
    addLog(id,`conferido_${tipoEntrega||"entrega"}`,funcionarioId,funcionarioNome,{pago,valorPago:pag?.valorPago||0,tipoEntrega,novoSit});
    res.json({ok:true,situacao:novoSit,pago,valorPago:pag?.valorPago||0,valorPedido:pag?.valorPedido||0,tipoEntrega});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// Confirmar entrega (EM ROTA → ATENDIDO) com registro de perdas/danos
// Análise de perdas — lista as ocorrências (não entregue / danificado) com fotos,
// quantidades e valores, filtrando por período opcional.
app.get("/api/perdas", async(req,res)=>{
  try{
    const {dataInicial,dataFinal}=req.query;
    const iniTs=dataInicial?new Date(dataInicial+"T00:00:00-03:00").getTime():null;
    const fimTs=dataFinal?new Date(dataFinal+"T23:59:59-03:00").getTime():null;
    const perdasObj=lerJSON(PERDAS_FILE,{});
    let ocorrencias=Object.values(perdasObj);
    if(iniTs) ocorrencias=ocorrencias.filter(o=>(o.em||0)>=iniTs);
    if(fimTs) ocorrencias=ocorrencias.filter(o=>(o.em||0)<=fimTs);
    ocorrencias.sort((a,b)=>(b.em||0)-(a.em||0));

    // enriquece com número do pedido e nome do cliente (best-effort, do Bling)
    const detalhes=[];
    let totalNaoEntregue=0, totalDanificado=0, qtdNaoEntregue=0, qtdDanificado=0;
    for(const o of ocorrencias){
      let numero=o.pedidoId, cliente="—";
      try{ const pj=await bling(`/pedidos/vendas/${o.pedidoId}`).then(r=>r?.data); if(pj){ numero=pj.numero||o.pedidoId; cliente=pj.contato?.nome||"—"; } }catch(e){}
      const nEnt=(o.itensNaoEntregues||[]).map(i=>({...i,tipo:"nao_entregue"}));
      const dan=(o.itensDanificados||[]).map(i=>({...i,tipo:"danificado"}));
      nEnt.forEach(i=>{ totalNaoEntregue+=(i.valorItem||0); qtdNaoEntregue+=(i.quantidadeAfetada||i.quantidade||1); });
      dan.forEach(i=>{ totalDanificado+=(i.valorItem||0); qtdDanificado+=(i.quantidadeAfetada||i.quantidade||1); });
      detalhes.push({
        pedidoId:o.pedidoId, numero, cliente, em:o.em, resolucao:o.resolucao||"",
        funcionarioNome:o.funcionarioNome||"", valorAbatido:o.valorAbatido||0,
        itens:[...nEnt,...dan],
      });
    }
    res.json({
      ocorrencias:detalhes,
      resumo:{
        totalOcorrencias:detalhes.length,
        totalNaoEntregue:+totalNaoEntregue.toFixed(2), qtdNaoEntregue,
        totalDanificado:+totalDanificado.toFixed(2), qtdDanificado,
        totalGeral:+(totalNaoEntregue+totalDanificado).toFixed(2),
      },
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.post("/api/fluxo/:id/confirmar-entrega",async(req,res)=>{
  try{
    const {funcionarioId,funcionarioNome,itensNaoEntregues,itensDanificados,valorAbatido,resolucao,clienteId,clienteNome}=req.body||{};
    const id=String(req.params.id);

    // trava: não deixa confirmar entrega sem o pagamento (considerando abatimento de ocorrências)
    const pags=lerPag();
    const pagoVal=+(pags[id]?.valorPago||0);
    const pj=await bling(`/pedidos/vendas/${id}`).then(r=>r?.data).catch(()=>null);
    const totalPed=+(pj?.total||pj?.totalProdutos||0);
    const saldoFinal=+(totalPed-Number(valorAbatido||0)).toFixed(2);
    if(pagoVal<saldoFinal-0.01){
      return res.status(400).json({erro:`Não é possível confirmar entrega sem receber o pagamento. Falta R$ ${(saldoFinal-pagoVal).toFixed(2)}.`});
    }

    // compara com o dia que esse pedido tinha sido planejado no Gerenciamento
    // de Rota (se tiver passado por lá) — pra saber se a entrega aconteceu no
    // dia certo ou se teve que "escorregar" pra outro dia
    let avisoAgendamento=null;
    const hojeBR2=new Date(Date.now()-3*60*60*1000).toISOString().slice(0,10);
    const agendamento=acharAgendamentoPedido(id);
    if(agendamento && agendamento.data!==hojeBR2){
      avisoAgendamento=`📅 Esse pedido estava planejado pra sair na rota do dia ${agendamento.data.split('-').reverse().join('/')}, mas a entrega só foi confirmada em ${hojeBR2.split('-').reverse().join('/')}.`;
      const atrasos=lerJSON(ROTAS_ATRASOS_FILE,{});
      atrasos[id]={pedidoId:id,dataPlanejada:agendamento.data,dataEntregaReal:hojeBR2,carroId:agendamento.carroId,em:Date.now()};
      salvarJSON(ROTAS_ATRASOS_FILE,atrasos);
    }

    if(itensNaoEntregues?.length||itensDanificados?.length){
      const perdas=lerJSON(PERDAS_FILE,{});
      perdas[id]={pedidoId:id,itensNaoEntregues:itensNaoEntregues||[],itensDanificados:itensDanificados||[],valorAbatido:valorAbatido||0,resolucao,funcionarioId,funcionarioNome,em:Date.now()};
      salvarJSON(PERDAS_FILE,perdas);
      if(resolucao==="credito"&&clienteId&&valorAbatido>0){
        const creds=lerJSON(CREDITOS_FILE,{});
        const cId=String(clienteId);
        if(!creds[cId]) creds[cId]={clienteId:cId,clienteNome:clienteNome||"",credito:0,historico:[]};
        creds[cId].credito=+((creds[cId].credito||0)+valorAbatido).toFixed(2);
        creds[cId].historico.push({pedidoId:id,valor:valorAbatido,em:Date.now(),motivo:"dano/não entregue"});
        salvarJSON(CREDITOS_FILE,creds);
      }
      addLog(id,"entrega_com_ocorrencia",funcionarioId,funcionarioNome,{valorAbatido,resolucao,naoEntregues:itensNaoEntregues?.length||0,danificados:itensDanificados?.length||0});
    }
    // se teve abatimento (dano/não entregue), a Bling ainda está com os itens/total
    // ORIGINAIS — sem reduzir isso lá, a parcela de pagamento (menor, já ajustada)
    // não bate com o total do pedido e o Bling rejeita a atualização (erro 400).
    // Reduz os itens afetados no Bling e, se dessa vez a sincronização passar,
    // tenta de novo sincronizar o pagamento (que pode ter falhado antes por causa
    // desse descompasso).
    let avisoItensBling=null;
    if(Number(valorAbatido||0)>0 && pj?.itens?.length){
      const todasOcorrencias=[...(itensNaoEntregues||[]),...(itensDanificados||[])];
      const itensNovos=pj.itens.map((it,ix)=>{
        const ocorr=todasOcorrencias.find(o=>o.ix===ix);
        const qtdOriginal=it.quantidade||0;
        const qtdFinal=ocorr?Math.max(0,qtdOriginal-(ocorr.quantidadeAfetada||0)):qtdOriginal;
        return {produtoId:it.produto?.id,quantidade:qtdFinal,valor:it.valor};
      }).filter(i=>i.produtoId&&i.quantidade>0);
      const resItens=await atualizarItensBling(id,itensNovos);
      if(!resItens.ok){
        avisoItensBling=`⚠️ Entrega confirmada, mas não foi possível reduzir os itens no Bling: ${detalheErroBling(resItens)}. O pagamento pode não bater com o total do pedido lá — confira manualmente.`;
      } else {
        // itens corrigidos — tenta de novo sincronizar o pagamento com o novo total
        const histAtual=lerPag()[id]?.historico||[];
        const formaUltima=[...histAtual].reverse().find(h=>h.formaId);
        if(formaUltima) await atualizarParcelasBling(id,[{valor:pagoVal,formaId:formaUltima.formaId}],{}).catch(()=>{});
      }
    }
    // se teve abatimento (dano/não entregue), grava no Bling — nas observações
    // do pedido — o valor que era previsto e o quanto foi efetivamente pago,
    // pra ficar registrado no próprio pedido, não só no sistema interno
    let avisoObsBling=null;
    if(Number(valorAbatido||0)>0){
      const tipos=[];
      if(itensDanificados?.length) tipos.push(`${itensDanificados.length} produto(s) danificado(s)`);
      if(itensNaoEntregues?.length) tipos.push(`${itensNaoEntregues.length} item(ns) não entregue(s)`);
      const dataHoraBR=new Date(Date.now()-3*60*60*1000).toLocaleString("pt-BR");
      const nota=`[Entrega ${dataHoraBR}] Valor previsto: R$ ${totalPed.toFixed(2)} — Valor pago: R$ ${pagoVal.toFixed(2)} (abatimento de R$ ${Number(valorAbatido).toFixed(2)} — ${tipos.join(" e ")}).`;
      const resObs=await acrescentarObservacaoBling(id,nota);
      if(!resObs.ok) avisoObsBling=`⚠️ Entrega confirmada, mas não foi possível gravar a observação no Bling: ${detalheErroBling(resObs)}.`;
    }
    await bling(`/pedidos/vendas/${id}/situacoes/${SIT.ATENDIDO}`,{method:"PATCH"});
    liberarLock(id,funcionarioId,funcionarioNome,"entrega_confirmada");
    addLog(id,"entrega_confirmada",funcionarioId,funcionarioNome,{});
    res.json({ok:true,avisoObsBling,avisoItensBling,avisoAgendamento});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

app.get("/api/entregas",(req,res)=>res.json({data:lerJSON(ENTREGAS_FILE,{})}));

app.get("/api/perdas",(req,res)=>res.json({data:Object.values(lerJSON(PERDAS_FILE,{}))}));
app.get("/api/perdas/:id",(req,res)=>{ const p=lerJSON(PERDAS_FILE,{}); res.json({data:p[String(req.params.id)]||null}); });
app.get("/api/creditos/:clienteId",(req,res)=>{ const c=lerJSON(CREDITOS_FILE,{}); res.json({data:c[String(req.params.clienteId)]||null}); });

// Retorna os status configurados (para uso no frontend)
app.get("/api/fluxo/status",(req,res)=>res.json({sit:SIT}));

// ---- ANALYTICS / DASHBOARD ----
app.get("/api/analytics", async (req,res)=>{
  try{
    const agora=Date.now();
    const {de, ate}=req.query;
    // usa fuso de Brasília (UTC-3) para calcular datas
    const offsetBR=3*60*60*1000;
    const hojeBR=new Date(agora-offsetBR).toISOString().slice(0,10);
    const tsInicio=de?new Date(de+"T03:00:00.000Z").getTime():agora-30*24*60*60*1000;
    const tsFim=ate?new Date(ate+"T03:00:00.000Z").getTime()+86399999:agora;
    const dentroP=ts=>ts>=tsInicio&&ts<=tsFim;

    // carrega todos os dados
    const log=lerLog(); const pags=lerPag();
    const pend=lerPend(); const acrs=lerJSON(ACRS_FILE,{});
    const perdas=Object.values(lerJSON(PERDAS_FILE,{})).filter(p=>dentroP(p.em||0));
    const totalPerdas=+perdas.reduce((s,p)=>s+(p.valorAbatido||0),0).toFixed(2);
    const perdaNaoEntregue=+perdas.reduce((s,p)=>s+(p.itensNaoEntregues||[]).reduce((ss,i)=>ss+(i.valorItem||0),0),0).toFixed(2);
    const perdaDanificado=+perdas.reduce((s,p)=>s+(p.itensDanificados||[]).reduce((ss,i)=>ss+(i.valorItem||0),0),0).toFixed(2);

    // busca pedidos do Bling no período (usa datas em horário de Brasília)
    const dataI=de||new Date(agora-30*24*60*60*1000-offsetBR).toISOString().slice(0,10);
    const dataF=ate||hojeBR;
    // busca todos os pedidos com paginação completa
    const buscarTodosPedidos=async(dataInicial,dataFinal)=>{
      const todos=[];
      const sits=[SIT.AGUARDANDO,SIT.EM_SEP,SIT.SEP_PEND,SIT.SEPARADO,SIT.CONF_ENTREGA,SIT.VERIFICADO,9].filter(Boolean);
      for(let pg=1;pg<=300;pg++){
        const p=new URLSearchParams({pagina:pg,limite:100,dataInicial,dataFinal});
        sits.forEach(id=>p.append("idsSituacoes[]",id));
        try{
          const r=await bling(`/pedidos/vendas?${p.toString()}`);
          // fallback sem filtro de situação se retornar vazio na primeira página
          if(pg===1&&(!r.data||r.data.length===0)){
            const p2=new URLSearchParams({pagina:1,limite:100,dataInicial,dataFinal});
            const r2=await bling(`/pedidos/vendas?${p2.toString()}`);
            if(r2.data?.length) { todos.push(...r2.data); break; }
          }
          const arr=r.data||[];
          todos.push(...arr);
          if(arr.length<100) break;
          await new Promise(r=>setTimeout(r,350)); // respeita o limite de req/s do Bling a cada página
        }catch(e){ break; }
      }
      return todos;
    };
    let pedidosBling=[];
    try{ pedidosBling=await buscarTodosPedidos(dataI,dataF); }catch(e){}

    // ---- métricas por funcionário ----
    const porFunc={};
    const addMetric=(fId,fNome,metrica,valor=1)=>{
      if(!fId) return;
      if(!porFunc[fId]) porFunc[fId]={id:fId,nome:fNome||fId,pedidosSeparados:0,tempoSepTotal:0,tempoSepCount:0,pendencias:0,conferidos:0,pagamentosRecebidos:0,valorRecebido:0,pedidosAssumidos:0,acrescimos:0,retiradas:0};
      porFunc[fId][metrica]=(porFunc[fId][metrica]||0)+valor;
    };

    // processa log
    const tempoSepPorPedido={};
    Object.entries(log).forEach(([pedId,eventos])=>{
      if(!Array.isArray(eventos)) return;
      const evPeriodo=eventos.filter(e=>dentroP(e.em));
      evPeriodo.forEach(e=>{
        const {evento,funcionarioId,funcionarioNome,em}=e;
        if(evento==="separacao_completa"||evento==="separacao_com_falta"){
          addMetric(funcionarioId,funcionarioNome,"pedidosSeparados");
          if(evento==="separacao_com_falta") addMetric(funcionarioId,funcionarioNome,"pendencias");
          // calcula tempo de separação
          const inicio=tempoSepPorPedido[pedId];
          if(inicio){ const dur=(em-inicio)/60000; addMetric(funcionarioId,funcionarioNome,"tempoSepTotal",dur); addMetric(funcionarioId,funcionarioNome,"tempoSepCount"); }
        }
        if(evento==="pedido_aberto_separacao") tempoSepPorPedido[pedId]=em;
        if(evento==="conferido_entrega"||evento==="conferido_retirada") addMetric(funcionarioId,funcionarioNome,"conferidos");
        if(evento==="pagamento_registrado"){ addMetric(funcionarioId,funcionarioNome,"pagamentosRecebidos"); }
        if(evento==="pedido_assumido") addMetric(funcionarioId,funcionarioNome,"pedidosAssumidos");
        if(evento==="itens_acrescentados") addMetric(funcionarioId,funcionarioNome,"acrescimos");
        if(evento==="itens_retirados") addMetric(funcionarioId,funcionarioNome,"retiradas");
      });
    });

    // pagamentos por funcionário
    Object.values(pags).forEach(pag=>{
      (pag.historico||[]).filter(h=>dentroP(h.em)).forEach(h=>{
        if(h.funcionarioId) addMetric(h.funcionarioId,h.funcionarioNome,"valorRecebido",h.valor||0);
      });
    });

    // ---- métricas financeiras ----
    let totalRecebido=0, totalPendente=0, porForma={};
    // busca contas a receber do Bling no período
    try{
      for(let pg=1;pg<=10;pg++){
        const pr=new URLSearchParams({pagina:pg,limite:100,dataEmissaoInicial:dataI,dataEmissaoFinal:dataF});
        const rc=await bling(`/contas/receber?${pr.toString()}`);
        const contas=rc.data||[];
        contas.forEach(c=>{
          const val=c.valor||0;
          if(c.situacao==="recebido"||c.situacao==="recebida"||(c.situacao&&c.situacao.toLowerCase().includes("receb"))){
            totalRecebido+=val;
            const k=c.formaPagamento?.descricao||c.portador?.descricao||"Outros";
            porForma[k]=(porForma[k]||0)+val;
          } else {
            totalPendente+=val;
          }
        });
        if(contas.length<100) break;
        if(pg%3===0) await new Promise(r=>setTimeout(r,400));
      }
    }catch(e){
      // fallback: usa o nosso registro de pagamentos
      Object.values(pags).forEach(pag=>{
        (pag.historico||[]).filter(h=>dentroP(h.em)).forEach(h=>{
          totalRecebido+=h.valor||0;
          const k=h.formaNome||"Outros"; porForma[k]=(porForma[k]||0)+(h.valor||0);
        });
      });
      pedidosBling.filter(p=>p.situacao?.id===SIT.AGUARDANDO||p.situacao?.id===SIT.EM_SEP).forEach(p=>{ totalPendente+=p.total||0; });
    }

    // ---- métricas operacionais ----
    const totalPedidos=pedidosBling.length;
    const comPendencia=Object.values(pend).filter(p=>dentroP(p.em||0)).length;
    const taxaPendencia=totalPedidos>0?Math.round(comPendencia/totalPedidos*100):0;
    const ticketMedio=totalPedidos>0?pedidosBling.reduce((s,p)=>s+(p.total||0),0)/totalPedidos:0;

    // pedidos por hora do dia — usa dataAlteracao ou dataCriacao se disponível
    const porHora=Array(24).fill(0);
    pedidosBling.forEach(p=>{
      const dt=p.dataCriacao||p.dataAlteracao||p.dataEmissao||null;
      if(dt){ try{ const h=new Date(dt).getHours(); if(h>=0&&h<24) porHora[h]++; }catch(e){} }
    });

    // carrega situações pra mapear ids → nomes
    let mapSitNomes={};
    try{ const rs=await bling("/situacoes/modulos/98310"); (rs.data||[]).forEach(s=>mapSitNomes[s.id]=s.nome); }catch(e){}

    // pedidos por status atual — com valor
    const porStatus={}, porStatusValor={};
    pedidosBling.forEach(p=>{
      const sitId=p.situacao?.id;
      const k=mapSitNomes[sitId]||p.situacao?.nome||"Outros";
      porStatus[k]=(porStatus[k]||0)+1;
      porStatusValor[k]=(porStatusValor[k]||0)+(p.total||0);
    });

    // tempo médio de fluxo completo (totem → verificado) por pedido
    let tempoFluxoTotal=0, tempoFluxoCount=0;
    Object.entries(log).forEach(([pedId,eventos])=>{
      if(!Array.isArray(eventos)) return;
      const criado=eventos.find(e=>e.evento==="enviado_separacao_pago"||e.evento==="separar_para_entregar");
      const concluido=eventos.find(e=>e.evento==="conferido_entrega"||e.evento==="conferido_retirada");
      if(criado&&concluido&&dentroP(criado.em)){ tempoFluxoTotal+=(concluido.em-criado.em)/60000; tempoFluxoCount++; }
    });

    // pedidos por dia (período atual)
    const porDia={};
    pedidosBling.forEach(p=>{ if(p.data){ const d=p.data.slice(0,10); porDia[d]=(porDia[d]||0)+1; } });

    // valor por dia (período atual)
    const valorPorDia={};
    pedidosBling.forEach(p=>{ if(p.data){ const d=p.data.slice(0,10); valorPorDia[d]=(valorPorDia[d]||0)+(p.total||0); } });

    // período anterior — mesmo número de dias, período anterior
    const durMs=tsFim-tsInicio;
    const diasPeriodo=Math.round(durMs/86400000);
    // se for 1 dia (hoje), compara com mesmo dia da semana anterior (7 dias atrás) como o Bling
    const offsetAnt=diasPeriodo<=1?7*86400000:durMs;
    const tsInicioAnt=tsInicio-offsetAnt; const tsFimAnt=tsFim-offsetAnt;
    const dataIAnt=new Date(tsInicioAnt).toISOString().slice(0,10);
    const dataFAnt=new Date(tsFimAnt).toISOString().slice(0,10);
    let pedidosAnt=[], totalAnt=0, prodVendidosAnt=0;
    try{
      pedidosAnt=await buscarTodosPedidos(dataIAnt,dataFAnt);
      totalAnt=pedidosAnt.reduce((s,p)=>s+(p.total||0),0);
    }catch(e){}

    // valor por dia período anterior (mapeado para as mesmas datas do atual)
    const valorPorDiaAnt={};
    pedidosAnt.forEach(p=>{ if(p.data){ const d=p.data.slice(0,10); valorPorDiaAnt[d]=(valorPorDiaAnt[d]||0)+(p.total||0); } });

    // Top 10 SKUs mais vendidos — busca detalhes dos pedidos atendidos
    const skuCount={}, skuNome={};
    let totalProdVendidos=0;
    const pedidosAtend=pedidosBling.filter(p=>p.situacao?.id===9||p.situacao?.id===SIT.VERIFICADO);
    for(const ped of pedidosAtend.slice(0,50)){ // busca até 50 pedidos com delay
      try{
        const rp=await bling(`/pedidos/vendas/${ped.id}`);
        const itens=rp?.data?.itens||[];
        itens.forEach(i=>{
          const cod=i.produto?.codigo||i.codigo||"?";
          const nome=i.descricao||i.produto?.nome||cod;
          const qtd=i.quantidade||0;
          skuCount[cod]=(skuCount[cod]||0)+qtd;
          skuNome[cod]=nome;
          totalProdVendidos+=qtd;
        });
      }catch(e){}
      if(pedidosAtend.indexOf(ped)%5===4) await new Promise(r=>setTimeout(r,400));
    }
    const top10=Object.entries(skuCount).sort((a,b)=>b[1]-a[1]).slice(0,10)
      .map(([cod,qtd])=>({codigo:cod,nome:skuNome[cod]||cod,quantidade:qtd}));

    // comparativo
    // total vendido só dos atendidos (igual ao Bling)
    const totalAtual=pedidosBling.filter(p=>p.situacao?.id===9).reduce((s,p)=>s+(p.total||0),0);
    const varPedidos=pedidosAnt.length>0?Math.round((pedidosBling.length-pedidosAnt.length)/pedidosAnt.length*100):null;
    const varValor=totalAnt>0?Math.round((totalAtual-totalAnt)/totalAnt*100):null;

    res.json({
      periodo:{de:dataI,ate:dataF},
      operacional:{ totalPedidos, totalProdVendidos, comPendencia, taxaPendencia:taxaPendencia+"%",
        ticketMedio:+ticketMedio.toFixed(2), porStatus, porStatusValor,
        tempoMedioFluxo:tempoFluxoCount>0?+(tempoFluxoTotal/tempoFluxoCount).toFixed(1):null,
        comparativo:{totalPedidosAnt:pedidosAnt.length,varPedidos,totalAtual:+totalAtual.toFixed(2),totalAnt:+totalAnt.toFixed(2),varValor} },
      financeiro:{ totalRecebido:+totalRecebido.toFixed(2), totalPendente:+totalPendente.toFixed(2), porForma,
        perdas:{total:totalPerdas,naoEntregue:perdaNaoEntregue,danificado:perdaDanificado,ocorrencias:perdas.length} },
      funcionarios:Object.values(porFunc).map(f=>({...f,
        tempoMedioSep:f.tempoSepCount>0?+(f.tempoSepTotal/f.tempoSepCount).toFixed(1):null,
        taxaPendencia:f.pedidosSeparados>0?Math.round(f.pendencias/f.pedidosSeparados*100):0
      })).sort((a,b)=>b.pedidosSeparados-a.pedidosSeparados),
      graficos:{ porHora, porDia, valorPorDia, valorPorDiaAnt, top10 }
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// ---- LOG DE PEDIDOS ----
function lerLog(){ return lerJSON(LOG_FILE,{}); }
function salvarLog(o){ salvarJSON(LOG_FILE,o); }
function addLog(pedidoId, evento, funcionarioId, funcionarioNome, detalhes={}){
  const log=lerLog(); const id=String(pedidoId);
  if(!log[id]) log[id]=[];
  log[id].push({evento,funcionarioId,funcionarioNome,detalhes,em:Date.now()});
  salvarLog(log);
}
app.get("/api/log/:id",(req,res)=>{
  const log=lerLog(); res.json({data:log[String(req.params.id)]||[]});
});
app.post("/api/log/:id",(req,res)=>{
  const {evento,funcionarioId,funcionarioNome,detalhes}=req.body||{};
  addLog(req.params.id,evento,funcionarioId,funcionarioNome,detalhes);
  res.json({ok:true});
});
app.get("/api/buscar",async(req,res)=>{
  try{
    const nome=(req.query.nome||"").trim();
    if(nome.length<2) return res.json({data:[]});
    const t=nome.toLowerCase();
    const porId={};

    // 1) índice local — rápido e acha o termo em qualquer parte do nome
    //    (ex.: "aperol" acha "APERITIVO APEROL 750ML")
    const indice=lerJSON(GTIN_INDEX_FILE,{});
    Object.values(indice).forEach(p=>{
      if((p.nome||"").toLowerCase().includes(t) || String(p.codigo||"").toLowerCase()===t){
        porId[p.produtoId]={id:p.produtoId,nome:p.nome,codigo:p.codigo,estoque:null,preco:p.preco??null,imagem:p.imagem||null};
      }
    });

    // 2) SEMPRE consulta o Bling também — assim produtos cadastrados depois da
    //    última reconstrução do índice já aparecem, sem precisar atualizar nada.
    //    Filtra pelo termo pra descartar a lista genérica que o Bling devolve.
    try{
      const d=await bling(`/produtos?nome=${encodeURIComponent(nome)}&limite=100`);
      (d.data||[]).forEach(p=>{ if((p.nome||"").toLowerCase().includes(t)) porId[p.id]={id:p.id,nome:p.nome,codigo:p.codigo,
        estoque:p.estoque?.saldoVirtualTotal ?? null,
        preco: p.preco!=null ? +p.preco : (porId[p.id]?.preco ?? null),
        imagem: p.imagemURL || p.imagem?.link?.grande || porId[p.id]?.imagem || null }; });
    }catch(e){}

    res.json({data:Object.values(porId)});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// ------------------------- Tabela publicada -------------------------
function lerTabela(){ try{ return JSON.parse(fs.readFileSync(TABELA_FILE,"utf8")); }catch{ return null; } }
app.post("/api/tabela",(req,res)=>{
  try{ const {model,meta}=req.body||{}; if(!Array.isArray(model)) return res.status(400).json({erro:"Envie { model, meta }"});
    const dados={model,meta:meta||{},publicadoEm:Date.now()};
    fs.writeFileSync(TABELA_FILE, JSON.stringify(dados));
    res.json({ok:true, produtos: model.reduce((s,c)=>s+((c.itens&&c.itens.length)||0),0)});
  }catch(e){ res.status(500).json({erro:e.message}); }
});
// salva a imagem da tabela de preços (gerada na tela /tabela) pra o vendedor compartilhar
const TABELA_IMG_FILE=`${DATA_DIR}/tabela_precos_atual.png`;
app.post("/api/tabela/salvar-imagem", express.json({limit:"12mb"}), (req,res)=>{
  try{
    const dataUrl=req.body?.imagem||"";
    const m=dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
    if(!m) return res.status(400).json({erro:"imagem inválida"});
    fs.writeFileSync(TABELA_IMG_FILE, Buffer.from(m[1],"base64"));
    fs.writeFileSync(TABELA_IMG_FILE+".meta", JSON.stringify({em:Date.now()}));
    res.json({ok:true});
  }catch(e){ res.status(500).json({erro:e.message}); }
});
// serve a última imagem salva
app.get("/api/tabela/imagem-atual",(req,res)=>{
  try{
    if(!fs.existsSync(TABELA_IMG_FILE)) return res.status(404).json({erro:"nenhuma tabela salva ainda"});
    res.set("Content-Type","image/png"); res.set("Cache-Control","no-store");
    res.sendFile(TABELA_IMG_FILE);
  }catch(e){ res.status(500).json({erro:e.message}); }
});
// info da última imagem (quando foi gerada)
app.get("/api/tabela/imagem-info",(req,res)=>{
  try{
    if(!fs.existsSync(TABELA_IMG_FILE)) return res.json({existe:false});
    let em=null; try{ em=JSON.parse(fs.readFileSync(TABELA_IMG_FILE+".meta","utf8")).em; }catch(e){}
    res.json({existe:true,em});
  }catch(e){ res.json({existe:false}); }
});

app.get("/api/tabela",(req,res)=> res.json(lerTabela()||{model:[],meta:{}}));

// estoque atual de vários produtos de uma vez (usa o endpoint de saldos do Bling)
app.post("/api/tabela/estoques",async(req,res)=>{
  try{
    const ids=(req.body?.ids||[]).map(Number).filter(Boolean);
    if(!ids.length) return res.json({estoques:{}});
    const estoques={};
    // o endpoint de saldos aceita vários idsProdutos por vez — processa em blocos de 40
    for(let i=0;i<ids.length;i+=40){
      const bloco=ids.slice(i,i+40);
      const qs=bloco.map(id=>`idsProdutos[]=${id}`).join("&");
      try{
        const r=await bling(`/estoques/saldos?${qs}`);
        (r?.data||[]).forEach(s=>{ estoques[s.produto?.id]=s.saldoVirtualTotal ?? s.saldoFisicoTotal ?? 0; });
      }catch(e){}
      await new Promise(r=>setTimeout(r,250));
    }
    res.json({estoques});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// ------------------------- Catálogo p/ o totem (tabela + estoque ao vivo) -------------------------
let _estCache={t:0,map:null};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function getEstoqueMap(){
  if(_estCache.map && Date.now()-_estCache.t < 300000) return _estCache.map; // cache 5 min
  const map={};
  for(let pg=1; pg<=40; pg++){
    const d=await bling(`/produtos?pagina=${pg}&limite=100`);
    const arr=d.data||[]; if(!arr.length) break;
    arr.forEach(p=>{ map[String(p.codigo)]={estoque:p.estoque?.saldoVirtualTotal ?? 0, nome:p.nome, id:p.id, imagem:p.imagemURL||"", preco:+(p.preco||0)}; });
    if(arr.length<100) break;
    await sleep(400); // respeita o limite de 3 req/s do Bling
  }
  _estCache={t:Date.now(),map}; return map;
}
app.get("/api/catalogo",async(req,res)=>{
  try{
    const tab=lerTabela();
    if(!tab||!tab.model) return res.json({categorias:[],aviso:"Nenhuma tabela publicada ainda."});
    const est=await getEstoqueMap();
    const cats={};
    tab.model.forEach(c=>{
      if(!cats[c.t]) cats[c.t]={nome:c.t,col:c.col,produtos:[]};
      (c.itens||[]).forEach(it=>{
        if(it.desabilitado) return; // produto marcado como desabilitado na tabela não aparece no totem/site
        const sabores=(it.bling||[]).map(b=>{ const e=est[String(b.codigo)];
          return {codigo:b.codigo, id:(e&&e.id)||b.id||null, nome:b.nome||(e&&e.nome)||"", estoque:e?e.estoque:(b.estoque??null), imagem:(e&&e.imagem)||""}; });
        const estoqueTotal = sabores.length ? sabores.reduce((s,x)=>s+(x.estoque||0),0) : null;
        const imagem = (sabores.find(s=>s.imagem)||{}).imagem || "";
        // usa o id interno da tabela + primeiro código Bling como id único do produto
        const prodId = it.id + "_" + (sabores[0]?.codigo||"0");
        cats[c.t].produtos.push({id:prodId,nome:it.nome,obs:it.obs||"",preco:it.preco,un:it.caixa||1,sabores,estoqueTotal,imagem});
      });
    });
    res.json({categorias:Object.values(cats).filter(c=>c.produtos&&c.produtos.length), meta:tab.meta||{}, atualizadoEm:tab.publicadoEm||null});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// ------------------------- Contatos / Pedido -------------------------
app.get("/api/contatos/:id",async(req,res)=>{
  try{ res.json(await bling(`/contatos/${req.params.id}`)); }
  catch(e){ res.status(e.status||500).json({erro:e.message}); }
});
app.get("/api/contatos",rateLimit({janelaMs:60000,max:12,prefixo:"contatos"}),async(req,res)=>{
  try{
    // busca por NOME -> devolve uma LISTA de candidatos pra escolher
    const nome=(req.query.nome||"").trim();
    if(nome){
      if(nome.length<3) return res.status(400).json({erro:"digite ao menos 3 letras"});
      const d=await bling(`/contatos?pesquisa=${encodeURIComponent(nome)}&limite=20`);
      const l=d?.data||[];
      const lista=l.slice(0,20).map(c=>({
        id:c.id, nome:c.nome||"",
        documento:soDigitos(c.numeroDocumento)||"",
        telefone:c.telefone||c.celular||"",
      }));
      return res.json({modo:"nome", lista});
    }
    const doc=soDigitos(req.query.doc); if(!doc) return res.status(400).json({erro:"?doc=CPF_ou_CNPJ ou ?nome=..."});
    // tenta buscar pelo número do documento
    const d=await bling(`/contatos?pesquisa=${encodeURIComponent(doc)}`); let l=d?.data||[];
    let a=l.find(c=>soDigitos(c.numeroDocumento)===doc)||null;
    // se não achou, tenta buscar com formatação (CPF: 000.000.000-00, CNPJ: 00.000.000/0000-00)
    if(!a){
      let docFmt=doc;
      if(doc.length===11) docFmt=`${doc.slice(0,3)}.${doc.slice(3,6)}.${doc.slice(6,9)}-${doc.slice(9)}`;
      if(doc.length===14) docFmt=`${doc.slice(0,2)}.${doc.slice(2,5)}.${doc.slice(5,8)}/${doc.slice(8,12)}-${doc.slice(12)}`;
      const d2=await bling(`/contatos?pesquisa=${encodeURIComponent(docFmt)}`); const l2=d2?.data||[];
      a=l2.find(c=>soDigitos(c.numeroDocumento)===doc)||null;
    }
    // terceira tentativa: busca por todos os contatos com esse documento (sem filtro)
    if(!a){
      const d3=await bling(`/contatos?numeroDocumento=${encodeURIComponent(doc)}`); const l3=d3?.data||[];
      a=l3.find(c=>soDigitos(c.numeroDocumento)===doc)||null;
    }
    if(!a) return res.json({encontrado:false,contato:null});
    // busca detalhe completo (com endereço, telefone, celular, email)
    let detalhe=a;
    try{ const dj=await bling(`/contatos/${a.id}`); detalhe=dj?.data||a; }catch(e){}
    const end=detalhe.endereco?.geral||{};
    res.json({encontrado:true, contato:{
      id:detalhe.id, nome:detalhe.nome||"",
      documento:soDigitos(detalhe.numeroDocumento)||doc,
      telefone:detalhe.telefone||"", celular:detalhe.celular||"",
      email:detalhe.email||"",
      endereco:{ cep:end.cep||"", rua:end.endereco||"", numero:end.numero||"",
        complemento:end.complemento||"", bairro:end.bairro||"",
        cidade:end.municipio||"", uf:end.uf||"" }
    }});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});
// ---------------- FRENTE DE CAIXA (PDV varejo, venda balcao) ----------------
// Cria o pedido direto no Bling já como Atendido (venda de balcão, sem separação),
// registra o(s) pagamento(s) (pode ser dividido entre formas) e tenta emitir a NFCe.
// ---------------- CONTROLE DE CAIXA (sessões: abertura, movimentos, fechamento) ----------------
function lerCaixaSessoes(){ return lerJSON(CAIXA_SESSOES_FILE,{sessoes:[]}); }
function salvarCaixaSessoes(d){ salvarJSON(CAIXA_SESSOES_FILE,d); }
// marca um movimento de venda (em QUALQUER sessão, aberta ou fechada) como ALTERADO,
// troca as formas de pagamento exibidas e guarda o histórico do que mudou — pra o
// "Minhas Vendas" mostrar o pedido em vermelho com o que aconteceu.
// quem recebeu um pedido no caixa (operador da sessão onde a venda foi lançada) — pra
// mostrar na nota e facilitar reabrir no caixa da pessoa certa
function recebidoPorDoPedido(pedidoId){
  try{
    const idStr=String(pedidoId);
    const d=lerCaixaSessoes();
    for(const s of (d.sessoes||[])){
      for(const m of (s.movimentos||[])){
        if(m.tipo==="venda" && String(m.pedidoId)===idStr){
          return { operador: m.operador || s.operador || "", tipoCaixa: s.tipoCaixa||"", sessaoAberta: !s.fechadaEm };
        }
      }
    }
  }catch(e){}
  return { operador:"", tipoCaixa:"", sessaoAberta:null };
}
function marcarMovimentoAlterado(pedidoId, novosPagamentos, alteracao, opts={}){
  try{
    const idStr=String(pedidoId);
    const d=lerCaixaSessoes();
    let achou=false;
    for(const s of (d.sessoes||[])){
      let mexeu=false;
      for(const m of (s.movimentos||[])){
        if(m.tipo==="venda" && String(m.pedidoId)===idStr){
          m.alterado=true;
          if(opts.cancelado) m.cancelado=true;
          if(opts.novoTotal!=null) m.total=+Number(opts.novoTotal).toFixed(2);
          if(opts.frete!=null) m.frete=+Number(opts.frete).toFixed(2);
          if(Array.isArray(opts.itens)&&opts.itens.length) m.itens=opts.itens;
          m.alteracoes=[...(m.alteracoes||[]), ...(Array.isArray(opts.alteracoesExtra)?opts.alteracoesExtra:[]), alteracao];
          if(Array.isArray(novosPagamentos)&&novosPagamentos.length) m.pagamentos=novosPagamentos;
          achou=true; mexeu=true;
        }
      }
      // se a sessão está FECHADA e tem resumo congelado, recalcula pra refletir a alteração
      if(mexeu && s.fechadaEm && s.resumoFinal){ try{ s.resumoFinal=resumoSessaoCaixa(s); }catch(e){} }
    }
    if(achou) salvarCaixaSessoes(d);
    return achou;
  }catch(e){ console.error("[marcarMovimentoAlterado]",e.message); return false; }
}
function sessaoCaixaAberta(funcionarioId,tipoCaixa){
  const d=lerCaixaSessoes();
  const tipo=tipoCaixa||"frente"; // retrocompat: sessões antigas sem tipo contam como "frente"
  const casaTipo=(s)=>(s.tipoCaixa||"frente")===tipo;
  if(funcionarioId) return (d.sessoes||[]).find(s=>!s.fechadaEm&&s.funcionarioId===funcionarioId&&casaTipo(s))||null;
  return (d.sessoes||[]).find(s=>!s.fechadaEm&&casaTipo(s))||null;
}
// Resumo consolidado de uma sessão: soma vendas por forma, sangrias, suprimentos
function resumoSessaoCaixa(sessao){
  const movs=sessao.movimentos||[];
  const vendas=movs.filter(m=>m.tipo==="venda" && !m.cancelado);
  const sangrias=movs.filter(m=>m.tipo==="sangria");
  const suprimentos=movs.filter(m=>m.tipo==="suprimento");

  const porForma={};
  vendas.forEach(v=>{
    (v.pagamentos||[]).forEach(p=>{
      const nome=p.formaNome||"Não identificada";
      if(!porForma[nome]) porForma[nome]={valor:0,qtd:0};
      porForma[nome].valor+=Number(p.valor)||0;
      porForma[nome].qtd++;
    });
  });

  const ehDinheiro=(nome)=>String(nome||"").toLowerCase().includes("dinheiro");
  const vendasDinheiro=Object.entries(porForma).filter(([n])=>ehDinheiro(n)).reduce((s,[,v])=>s+v.valor,0);
  const totalVendas=Object.values(porForma).reduce((s,v)=>s+v.valor,0);
  const totalSangrias=sangrias.reduce((s,m)=>s+(Number(m.valor)||0),0);
  const totalSuprimentos=suprimentos.reduce((s,m)=>s+(Number(m.valor)||0),0);

  // o que deveria ter na gaveta agora, só em dinheiro
  const esperadoGavetaCalc=+(Number(sessao.trocoInicial||0)+vendasDinheiro+totalSuprimentos-totalSangrias).toFixed(2);
  // se um gestor ajustou o esperado manualmente, usa esse valor (mas mantém o calculado visível)
  const temManual=(sessao.esperadoGavetaManual!==undefined&&sessao.esperadoGavetaManual!==null&&sessao.esperadoGavetaManual!=="");
  const esperadoGaveta=temManual?+Number(sessao.esperadoGavetaManual).toFixed(2):esperadoGavetaCalc;

  return {
    trocoInicial:+Number(sessao.trocoInicial||0).toFixed(2),
    qtdVendas:vendas.length,
    totalVendas:+totalVendas.toFixed(2),
    vendasDinheiro:+vendasDinheiro.toFixed(2),
    totalSangrias:+totalSangrias.toFixed(2),
    totalSuprimentos:+totalSuprimentos.toFixed(2),
    esperadoGaveta,
    esperadoGavetaCalc,
    esperadoGavetaManual:temManual?+Number(sessao.esperadoGavetaManual).toFixed(2):null,
    porForma:Object.entries(porForma).map(([nome,v])=>({nome,valor:+v.valor.toFixed(2),qtd:v.qtd})).sort((a,b)=>b.valor-a.valor),
  };
}

// DIAGNÓSTICO temporário: conta quantos pedidos o filtro idsSituacoes retorna pra
// cada status usado na rota — confirma se os IDs de Em aberto/Em digitação batem.
app.get("/api/diag/contar-situacoes",async(req,res)=>{
  try{
    const offsetBR=3*60*60*1000;
    const dataFim=new Date(Date.now()-offsetBR+7*86400000).toISOString().slice(0,10);
    const dataIni=new Date(Date.now()-offsetBR-60*86400000).toISOString().slice(0,10);
    const alvos={
      "EM_ABERTO(6)":SIT.EM_ABERTO, "EM_DIGITACAO(21)":SIT.EM_DIGITACAO,
      "AGUARDANDO":SIT.AGUARDANDO, "SEPARADO":SIT.SEPARADO, "SEP_PEND":SIT.SEP_PEND, "EM_ROTA":SIT.EM_ROTA,
    };
    const contagem={};
    const exemplos={};
    for(const [nome,id] of Object.entries(alvos)){
      const p=new URLSearchParams({pagina:1,limite:100,dataInicial:dataIni,dataFinal:dataFim});
      p.append("idsSituacoes[]",id);
      let arr=[];
      try{ arr=await bling(`/pedidos/vendas?${p.toString()}`).then(r=>r?.data||[]); }catch(e){ contagem[nome]="ERRO:"+e.message; continue; }
      contagem[nome]=arr.length;
      exemplos[nome]=arr.slice(0,3).map(x=>({numero:x.numero,situacaoId:x.situacao?.id,total:x.total}));
      await new Promise(r=>setTimeout(r,300));
    }
    res.json({periodo:{dataIni,dataFim}, contagem, exemplos, SIT});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});
// DIAGNÓSTICO temporário: lista as situações de pedido de venda cadastradas no
// Bling do usuário, pra confirmar os IDs reais de "Em aberto" e "Em digitação".
app.get("/api/diag/situacoes",async(req,res)=>{
  try{
    // módulo de pedidos de venda no Bling v3
    let r=null;
    try{ r=await bling(`/situacoes/modulos`); }catch(e){}
    // tenta também o endpoint direto de situações
    let sits=null;
    try{ sits=await bling(`/situacoes`); }catch(e){ sits={erro:e.message}; }
    res.json({modulos:r, situacoes:sits, SIT_atual:SIT});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});
// DIAGNÓSTICO temporário: explica por que um pedido (pelo número) aparece ou não
// na montagem de rota. Uso: /api/diag/rota-pedido/50301
app.get("/api/diag/rota-pedido/:numero",async(req,res)=>{
  try{
    const num=String(req.params.numero);
    // a API v3 do Bling NÃO tem filtro por "numero" na listagem — então varre as
    // páginas procurando o número exato (o campo do pedido é .numero).
    let achado=null;
    for(let pag=1;pag<=30 && !achado;pag++){
      const p=new URLSearchParams({pagina:pag,limite:100});
      let arr=[];
      try{ arr=await bling(`/pedidos/vendas?${p.toString()}`).then(r=>r?.data||[]); }catch(e){ break; }
      achado=arr.find(x=>String(x.numero)===num)||null;
      if(arr.length<100) break;
      await new Promise(r=>setTimeout(r,300));
    }
    if(!achado) return res.json({achou:false, motivo:"número não encontrado varrendo as páginas de pedidos"});
    const det=await bling(`/pedidos/vendas/${achado.id}`).then(r=>r?.data);
    const frete=+(det?.transporte?.frete||0);
    const endObj = det?.transporte?.enderecoEntrega?.endereco ? det.transporte.enderecoEntrega
                 : det?.transporte?.etiqueta?.endereco ? det.transporte.etiqueta : null;
    let enderecoTxt = endObj?[endObj.endereco,endObj.numero,endObj.bairro,endObj.municipio,endObj.uf].filter(Boolean).join(", "):"";
    if(!enderecoTxt && det?.observacoes){ const m=det.observacoes.match(/ENTREGA\s*—\s*([^(]+)/); if(m) enderecoTxt=m[1].trim(); }
    const situacaoId=Number(det?.situacao?.id||0);
    const statusEntram=[SIT.EM_ABERTO,SIT.EM_DIGITACAO,SIT.AGUARDANDO,SIT.SEPARADO,SIT.SEP_PEND,SIT.EM_ROTA];
    res.json({
      achou:true, id:achado.id, numero:achado.numero,
      total:+(det?.total||0),
      situacaoId, situacaoNome:det?.situacao?.nome||"",
      _checagens:{
        statusEntraNaRota: statusEntram.includes(situacaoId),
        passaFiltroValor_1000: +(det?.total||0)>=1000,
        temFrete: frete>0, frete,
        temEndereco: !!enderecoTxt, enderecoDetectado: enderecoTxt||"(nenhum)",
        ehEntrega: (frete>0 || !!enderecoTxt),
      },
      transporteCru: det?.transporte||null,
      observacoes: det?.observacoes||"",
    });
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});
// status atual do caixa (aberto/fechado + resumo se aberto)
// DIAGNÓSTICO: descobre o que a API de caixas do Bling suporta (GET/POST) —
// usado pra avaliar a viabilidade de espelhar o caixa no Bling
app.get("/api/diag/caixas-bling", async(req,res)=>{
  const resultado={};
  // 1) lista caixas
  try{
    const hoje=dataBR();
    const trintaDiasAtras=new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    const r=await bling(`/caixas?dataInicial=${trintaDiasAtras}&dataFinal=${hoje}`);
    resultado.get_caixas={ok:true,qtd:(r?.data||[]).length,amostra:(r?.data||[]).slice(0,3)};
  }catch(e){ resultado.get_caixas={ok:false,erro:e.message,status:e.status}; }

  // 2) tenta detalhe do primeiro caixa (se houver)
  try{
    const primeiroId=resultado.get_caixas?.amostra?.[0]?.id;
    if(primeiroId){
      const r=await bling(`/caixas/${primeiroId}`);
      resultado.get_caixa_detalhe={ok:true,dados:r?.data};
    } else resultado.get_caixa_detalhe={ok:false,motivo:"nenhum caixa encontrado pra testar"};
  }catch(e){ resultado.get_caixa_detalhe={ok:false,erro:e.message,status:e.status}; }

  // 3) testa se POST /caixas existe (sem body válido — só pra ver se responde 404 ou erro de validação)
  try{
    await bling(`/caixas`,{method:"POST",body:JSON.stringify({})});
    resultado.post_caixas={existe:true,observacao:"aceitou POST vazio (inesperado)"};
  }catch(e){
    resultado.post_caixas={
      existe: e.status!==404 && e.status!==405,
      status:e.status,
      erro:e.message,
      interpretacao: e.status===404?"endpoint NAO existe":(e.status===405?"metodo POST nao permitido (so leitura)":"endpoint existe, mas exige campos - da pra criar via API"),
    };
  }
  res.json(resultado);
});

// DIAGNÓSTICO: pedidos que aparecem em MAIS DE UM caixa hoje (venda duplicada em 2 caixas)
app.get("/api/diag/pedidos-duplicados",(req,res)=>{
  try{
    // ?dias=N limita a janela (padrão: TUDO). ?dias=1 = só hoje.
    const dias=req.query.dias?Number(req.query.dias):null;
    const desde=dias?(Date.now()-dias*86400000):0;
    const d=lerCaixaSessoes();
    const porPedido={}; // pedidoId -> [ocorrências]
    for(const s of (d.sessoes||[])){
      for(const m of (s.movimentos||[])){
        if(m.tipo!=="venda") continue;
        if(m.em<desde) continue;
        const pid=String(m.pedidoId||m.numero||"");
        if(!pid) continue;
        (porPedido[pid]=porPedido[pid]||[]).push({
          sessaoId:s.id, operador:s.operador||"—", tipoCaixa:s.tipoCaixa||"frente",
          sessaoAberta:!s.fechadaEm, numero:m.numero||m.pedidoId, total:m.total, em:m.em,
          quando:new Date(m.em).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"}),
          alterado:!!m.alterado, cancelado:!!m.cancelado, origem:m.origem||""
        });
      }
    }
    // Dois tipos de duplicidade:
    //  A) EM CAIXAS DIFERENTES  -> grave: a venda pode estar contando 2x no fechamento
    //  B) NA MESMA SESSÃO       -> suspeito: normalmente é reabertura/edição do pedido,
    //     mas se as duas linhas estiverem ativas (nenhuma cancelada) pode ser duplicidade real
    const emCaixasDiferentes=[], naMesmaSessao=[];
    for(const [pid,ocs] of Object.entries(porPedido)){
      const ativas=ocs.filter(o=>!o.cancelado);
      const sessoes=new Set(ativas.map(o=>o.sessaoId));
      if(sessoes.size>=2){
        emCaixasDiferentes.push({ pedidoId:pid, numero:ativas[0]?.numero, vezes:ativas.length,
          somaTotais:+ativas.reduce((a,o)=>a+(Number(o.total)||0),0).toFixed(2), caixas:ocs });
      } else if(ativas.length>=2){
        naMesmaSessao.push({ pedidoId:pid, numero:ativas[0]?.numero, vezes:ativas.length,
          somaTotais:+ativas.reduce((a,o)=>a+(Number(o.total)||0),0).toFixed(2), caixas:ocs });
      }
    }
    emCaixasDiferentes.sort((a,b)=>b.vezes-a.vezes);
    naMesmaSessao.sort((a,b)=>b.vezes-a.vezes);
    res.json({
      janela: dias?`últimos ${dias} dia(s)`:"todo o histórico",
      totalPedidosAnalisados:Object.keys(porPedido).length,
      qtdEmCaixasDiferentes:emCaixasDiferentes.length,
      qtdNaMesmaSessao:naMesmaSessao.length,
      resumo: emCaixasDiferentes.length
        ? `⚠️ ${emCaixasDiferentes.length} pedido(s) registrados em CAIXAS DIFERENTES (pode contar 2x no fechamento).`
        : (naMesmaSessao.length? `✅ Nenhum em caixas diferentes. ${naMesmaSessao.length} com 2+ lançamentos na mesma sessão (normalmente reabertura/edição — confira).` : "✅ Nenhuma duplicidade encontrada."),
      emCaixasDiferentes,
      naMesmaSessao
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// DIAGNÓSTICO: mostra onde está o frete de um pedido (pra achar o campo certo no Bling)
// investiga um pedido específico: todas as ocorrências no caixa (com dados completos),
// o pedido/parcelas reais no Bling, e se o fechamento daquela sessão está contando 2x
// COMPARA Central x Fechamento de Caixa no mesmo dia e mostra POR QUE divergem,
// listando os pedidos que cada lado inclui/exclui. Também lista todos os pedidos
// de Consumidor Final. Uso: ?data=AAAA-MM-DD (padrão: hoje, horário de Brasília)
// DIAGNÓSTICO: descobre como o SEU Bling expõe depósitos e saldos por depósito.
// Nada aqui grava nada — é só leitura, pra montar o painel de estoque com segurança.
// DIAGNÓSTICO: descobre como listar as NFC-e emitidas (a Central usava /nfe?tipo=1,
// que é NF-e — as NFC-e do PDV/varejo ficam em outro lugar). Só leitura.
app.get("/api/diag/nfce-listar",async(req,res)=>{
  const dia=_hojeISO(req.query.data);
  const out={dia};
  const tentativas=[
    ["/nfce (com data)", `/nfce?dataEmissaoInicial=${dia} 00:00:00&dataEmissaoFinal=${dia} 23:59:59&limite=10`],
    ["/nfce (sem filtro)", `/nfce?limite=5`],
    ["/nfe tipo=1 (NF-e saída)", `/nfe?tipo=1&dataEmissaoInicial=${dia} 00:00:00&dataEmissaoFinal=${dia} 23:59:59&limite=10`],
    ["/notas-fiscais-consumidor", `/notas-fiscais-consumidor?limite=5`],
  ];
  for(const [nome,path] of tentativas){
    try{
      const r=await bling(path);
      const arr=r?.data||[];
      out[nome]={ok:true, qtd:arr.length, amostra:arr.slice(0,3).map(n=>({id:n.id,numero:n.numero,serie:n.serie,dataEmissao:n.dataEmissao,situacao:n.situacao,valor:n.valorNota??n.valor,contato:n.contato?.nome,tipo:n.tipo})),
        camposCrus:arr[0]?Object.keys(arr[0]):[], primeiraNotaCrua:arr[0]||null};
    }catch(e){ out[nome]={ok:false,status:e.status,erro:e.message}; }
    await sleep(200);
  }
  res.json(out);
});

app.get("/api/diag/depositos",async(req,res)=>{
  const out={};
  // 1) endpoint de depósitos
  try{ const r=await bling(`/depositos`); out.get_depositos={ok:true,qtd:(r?.data||[]).length,data:r?.data||[]}; }
  catch(e){ out.get_depositos={ok:false,status:e.status,erro:e.message,body:e.body}; }
  // 2) saldos de um produto de exemplo — mostra se vem quebrado por depósito
  try{
    const pid=req.query.produtoId;
    if(pid){
      const r=await bling(`/estoques/saldos?idsProdutos[]=${pid}`);
      out.saldos_do_produto={ok:true,data:r?.data||[]};
      try{ const r2=await bling(`/produtos/${pid}`); out.produto_estoque_bruto=r2?.data?.estoque||null; }catch(e){}
    } else out.saldos_do_produto={dica:"passe ?produtoId=ID pra ver o saldo por depósito de um produto"};
  }catch(e){ out.saldos_do_produto={ok:false,erro:e.message,body:e.body}; }
  // 3) saldos filtrando por depósito (se houver depósito informado)
  try{
    const dep=req.query.depositoId, pid=req.query.produtoId;
    if(dep&&pid){
      const r=await bling(`/estoques/saldos?idsProdutos[]=${pid}&idDeposito=${dep}`);
      out.saldos_filtrando_deposito={ok:true,data:r?.data||[]};
    }
  }catch(e){ out.saldos_filtrando_deposito={ok:false,erro:e.message,body:e.body}; }
  res.json(out);
});

app.get("/api/diag/central-vs-fechamento",async(req,res)=>{
  try{
    const dia=_hojeISO(req.query.data);
    // 1) busca a lista de pedidos do dia (mesma origem das duas telas)
    let lista=[], pag=1;
    for(let i=0;i<10;i++){
      const r=await bling(`/pedidos/vendas?dataInicial=${dia}&dataFinal=${dia}&pagina=${pag}&limite=100`);
      const arr=r?.data||[]; lista=lista.concat(arr);
      if(arr.length<100) break; pag++;
    }
    // dedupe (a listagem do Bling pode repetir entre páginas)
    const vistos=new Set(); const repetidosNaListagem=[];
    lista=lista.filter(p=>{ const k=String(p.id); if(vistos.has(k)){ repetidosNaListagem.push(p.numero); return false; } vistos.add(k); return true; });

    const detalhes=[];
    for(const p of lista){
      let d=null; try{ d=await bling(`/pedidos/vendas/${p.id}`).then(r=>r?.data); }catch(e){}
      const contatoId=d?.contato?.id||p.contato?.id||null;
      const nome=d?.contato?.nome||p.contato?.nome||"—";
      const sit=Number(p.situacao?.id||0);
      detalhes.push({ id:p.id, numero:p.numero, cliente:nome, contatoId,
        consumidorFinal: contatoId===CONSUMIDOR_FINAL_ID || /consumidor\s*final/i.test(nome),
        situacaoId:sit, situacao:nomeSituacao(sit), cancelado:sit===SIT.CANCELADO,
        totalListagem:+Number(p.total||0).toFixed(2),
        totalDetalhe: d? +Number(d.total||0).toFixed(2) : null,
        divergeTotal: d ? Math.abs(Number(d.total||0)-Number(p.total||0))>0.01 : null });
      await sleep(80);
    }
    // 2) como cada tela conta
    const naoCancelados=detalhes.filter(p=>!p.cancelado);
    const somaDetalhe=+naoCancelados.reduce((a,p)=>a+(p.totalDetalhe??p.totalListagem),0).toFixed(2);
    const somaListagem=+naoCancelados.reduce((a,p)=>a+p.totalListagem,0).toFixed(2);
    // Central limita a 250 pedidos; fechamento não limita
    const limiteCentral=250;
    const forasDoLimiteCentral=detalhes.slice(limiteCentral).map(p=>({numero:p.numero,cliente:p.cliente,total:p.totalDetalhe??p.totalListagem}));
    // 3) caixa local do dia (o que a Central mostra em "fechamento do dia")
    const ini=_inicioDia(dia), fim=_fimDia(dia);
    const dCx=lerCaixaSessoes(); let totalCaixa=0, qtdCaixa=0; const pedidosNoCaixa=new Set();
    (dCx.sessoes||[]).forEach(s=>(s.movimentos||[]).forEach(m=>{
      if(m.tipo!=="venda"||m.cancelado||m.em<ini||m.em>=fim) return;
      totalCaixa+=Number(m.total)||0; qtdCaixa++; if(m.pedidoId) pedidosNoCaixa.add(String(m.pedidoId));
    }));
    const cf=detalhes.filter(p=>p.consumidorFinal&&!p.cancelado);
    res.json({
      dia,
      pedidosNoBling:detalhes.length,
      cancelados:detalhes.filter(p=>p.cancelado).length,
      repetidosNaListagem,
      explicacao:"Se 'somaPorDetalhe' e 'somaPorListagem' divergem, é porque a listagem do Bling fica desatualizada após edições — o Fechamento e a Central usam o DETALHE. 'fechamentoDoCaixaLocal' é o total dos caixas do nosso sistema (só o que passou por um caixa), por isso é naturalmente menor que o total do Bling (que inclui pedidos de outros canais/não finalizados no caixa).",
      totais:{
        somaPorDetalhe:somaDetalhe,
        somaPorListagem:somaListagem,
        diferencaEntreOsDois:+(somaDetalhe-somaListagem).toFixed(2),
        fechamentoDoCaixaLocal:+totalCaixa.toFixed(2), qtdVendasNoCaixa:qtdCaixa,
        pedidosDoBlingQueNaoPassaramNoCaixa:naoCancelados.filter(p=>!pedidosNoCaixa.has(String(p.id))).length,
      },
      limiteCentral:{ aplica:detalhes.length>limiteCentral, quantosFicamDeFora:forasDoLimiteCentral.length, pedidos:forasDoLimiteCentral },
      totaisQueDivergemEntreListagemEDetalhe: detalhes.filter(p=>p.divergeTotal).map(p=>({numero:p.numero,cliente:p.cliente,listagem:p.totalListagem,detalhe:p.totalDetalhe})),
      consumidorFinal:{ qtd:cf.length, total:+cf.reduce((a,p)=>a+(p.totalDetalhe??p.totalListagem),0).toFixed(2),
        pedidos:cf.map(p=>({numero:p.numero,cliente:p.cliente,total:p.totalDetalhe??p.totalListagem,situacao:p.situacao,passouNoCaixa:pedidosNoCaixa.has(String(p.id))})) },
      pedidosDoBlingForaDoCaixa: naoCancelados.filter(p=>!pedidosNoCaixa.has(String(p.id)))
        .map(p=>({numero:p.numero,cliente:p.cliente,total:p.totalDetalhe??p.totalListagem,situacao:p.situacao,consumidorFinal:p.consumidorFinal})),
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// CONFERÊNCIA COMPLETA de um pedido: compara sistema x Bling (total, itens, pagamento),
// mostra o que foi RETIRADO/ACRESCENTADO/ALTERADO com quem fez e quando, aponta os
// produtos que provavelmente saíram por falta de estoque (conferindo o saldo atual) e
// traz todo o histórico de pagamento. Uso: /api/diag/conferir-pedido/54894
app.get("/api/diag/conferir-pedido/:numero",async(req,res)=>{
  try{
    const n=String(req.params.numero).trim();
    // acha no Bling (por id ou número)
    let ped=await bling(`/pedidos/vendas/${n}`).then(r=>r?.data).catch(()=>null);
    if(!ped){ try{ const r=await bling(`/pedidos/vendas?numero=${encodeURIComponent(n)}`); const a=(r?.data||[])[0]; if(a?.id) ped=await bling(`/pedidos/vendas/${a.id}`).then(x=>x?.data); }catch(e){} }
    if(!ped) return res.status(404).json({erro:"pedido não encontrado no Bling"});
    const pid=String(ped.id);
    const itensBling=(ped.itens||[]).map(i=>({produtoId:i.produto?.id,nome:i.descricao||"",quantidade:Number(i.quantidade),valor:Number(i.valor)}));
    const totalBling=Number(ped.total)||0;
    const parcelasBling=[];
    for(const pc of (ped.parcelas||[])) parcelasBling.push({forma:await nomeFormaPagamentoId(pc.formaPagamento?.id), valor:Number(pc.valor)||0});

    // lado do SISTEMA (movimento no caixa)
    const dCx=lerCaixaSessoes(); let mov=null, sessao=null;
    (dCx.sessoes||[]).forEach(s=>(s.movimentos||[]).forEach(m=>{
      if(m.tipo==="venda"&&!m.cancelado&&String(m.pedidoId)===pid){ mov=m; sessao=s; }
    }));
    const itensSistema=(mov?.itens||[]).map(i=>({produtoId:i.produtoId,nome:i.nome||"",quantidade:Number(i.quantidade),valor:Number(i.valor)}));
    const totalSistema=Number(mov?.total||0);

    // DIVERGÊNCIA
    const difTotal=+(totalSistema-totalBling).toFixed(2);
    const diff=mov?diffItens(itensSistema,itensBling):null; // sistema -> bling

    // HISTÓRICO de alterações (do movimento e do log)
    const log=lerLog()[pid]||[];
    const historicoItens=log.filter(e=>["itens_alterados_caixa","itens_retirados","itens_acrescentados","itens_alterados_gestao"].includes(e.evento))
      .map(e=>({evento:e.evento, em:e.em, quando:new Date(e.em).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"}),
        por:e.funcionarioNome||"—", autorizadoPor:e.detalhes?.autorizadoPor||"", detalhes:e.detalhes||{}}));
    const historicoPagamento=log.filter(e=>["pagamento_editado_caixa","fechado_valor_menor","pedido_reaberto"].includes(e.evento))
      .map(e=>({evento:e.evento, em:e.em, quando:new Date(e.em).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"}),
        por:e.funcionarioNome||"—", autorizadoPor:e.detalhes?.autorizadoPor||"", de:e.detalhes?.de||"", para:e.detalhes?.para||""}));
    const alteracoesMov=(mov?.alteracoes||[]).map(a=>({...a, quando:new Date(a.em).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"})}));

    // PRODUTOS QUE SAÍRAM: junta os retirados registrados no histórico e o diff atual,
    // e confere o SALDO de cada um (pra confirmar se saiu por falta de estoque)
    const nomesRetirados=new Set();
    historicoItens.forEach(h=>{ (h.detalhes?.retirados||h.detalhes?.itens||[]).forEach(x=>nomesRetirados.add(String(x).replace(/^\d+x\s*/,"").trim())); });
    (diff?.retirados||[]).forEach(i=>nomesRetirados.add(i.nome));
    alteracoesMov.forEach(a=>{ (a.retirados||[]).forEach(x=>nomesRetirados.add(String(x).replace(/^\d+x\s*/,"").trim())); });
    const idsParaSaldo=[...new Set([...(diff?.retirados||[]).map(i=>i.produtoId), ...itensSistema.map(i=>i.produtoId)])].filter(Boolean);
    const saldos={};
    for(let i=0;i<idsParaSaldo.length;i+=40){
      const bloco=idsParaSaldo.slice(i,i+40);
      try{
        const r=await bling(`/estoques/saldos?${bloco.map(id=>`idsProdutos[]=${id}`).join("&")}`);
        (r?.data||[]).forEach(x=>{ saldos[x.produto?.id]={fisico:Number(x.saldoFisicoTotal??0), disponivel:Number(x.saldoVirtualTotal??0)}; });
      }catch(e){}
      await sleep(150);
    }
    const provavelFaltaEstoque=(diff?.retirados||[]).map(i=>({...i, saldoAtual:saldos[i.produtoId]||null,
      semEstoque: saldos[i.produtoId] ? saldos[i.produtoId].disponivel<=0 : null }));

    res.json({
      pedido:{ id:ped.id, numero:ped.numero, situacao:nomeSituacao(ped.situacao?.id), cliente:ped.contato?.nome||"—" },
      divergencia:{ totalSistema, totalBling, diferenca:difTotal, bate:Math.abs(difTotal)<0.01,
        explicacao: Math.abs(difTotal)<0.01 ? "Sistema e Bling estão iguais."
          : `O caixa registrou ${totalSistema.toFixed(2)} e o Bling tem ${totalBling.toFixed(2)} (diferença de ${difTotal.toFixed(2)}). Veja 'itensQueDiferem' pra saber quais produtos explicam isso.` },
      itensQueDiferem: diff?{ retirados:diff.retirados, acrescentados:diff.acrescentados, alterados:diff.alterados,
        obs:"'retirados' = está no caixa mas NÃO no Bling. 'acrescentados' = está no Bling mas não no caixa." }:"pedido não encontrado em nenhum caixa",
      provavelFaltaEstoque,
      produtosRetiradosNoHistorico:[...nomesRetirados],
      itensSistema, itensBling,
      pagamento:{ noSistema:(mov?.pagamentos||[]), noBling:parcelasBling,
        somaSistema:+(mov?.pagamentos||[]).reduce((s,p)=>s+Number(p.valor||0),0).toFixed(2),
        somaBling:+parcelasBling.reduce((s,p)=>s+p.valor,0).toFixed(2) },
      historicoItens, historicoPagamento, alteracoesMovimento:alteracoesMov,
      caixa: mov?{ operador:mov.operador||sessao?.operador, sessaoFechada:!!sessao?.fechadaEm, quando:new Date(mov.em).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"}), alterado:!!mov.alterado }:null,
      observacoesBling: ped.observacoes||"",
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.get("/api/diag/investigar-duplicado/:pedidoId",async(req,res)=>{
  try{
    const idBusca=String(req.params.pedidoId);
    const dCx=lerCaixaSessoes();
    const ocorrencias=[];
    for(const s of (dCx.sessoes||[])){
      for(const m of (s.movimentos||[])){
        if(m.tipo==="venda" && (String(m.pedidoId)===idBusca || String(m.numero)===idBusca)){
          ocorrencias.push({ sessaoId:s.id, operador:s.operador, tipoCaixa:s.tipoCaixa||"frente",
            sessaoFechada:!!s.fechadaEm, pedidoId:m.pedidoId, numero:m.numero, total:m.total,
            em:m.em, quando:new Date(m.em).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"}),
            cancelado:!!m.cancelado, alterado:!!m.alterado, pagamentos:m.pagamentos||[], alteracoes:m.alteracoes||[] });
        }
      }
    }
    // pedido real no Bling
    let pedidoBling=null;
    const pid=ocorrencias[0]?.pedidoId||idBusca;
    try{
      const ped=await bling(`/pedidos/vendas/${pid}`).then(r=>r?.data);
      if(ped) pedidoBling={ id:ped.id, numero:ped.numero, total:ped.total, situacao:nomeSituacao(ped.situacao?.id),
        parcelas:(ped.parcelas||[]).map(p=>({forma:p.formaPagamento?.nome||p.formaPagamento?.id,valor:p.valor})),
        observacoes:ped.observacoes||"" };
    }catch(e){ pedidoBling={erro:e.message}; }
    // pra cada sessão envolvida, recalcula o fechamento AGORA (mostra se está contando 2x)
    const sessoesEnvolvidas=[...new Set(ocorrencias.map(o=>o.sessaoId))];
    const fechamentos=sessoesEnvolvidas.map(sid=>{
      const s=(dCx.sessoes||[]).find(x=>x.id===sid);
      const r=resumoSessaoCaixa(s);
      const vendasDessePedido=(s.movimentos||[]).filter(m=>m.tipo==="venda"&&!m.cancelado&&(String(m.pedidoId)===idBusca||String(m.numero)===idBusca));
      return { sessaoId:sid, operador:s.operador, fechadaEm:s.fechadaEm||null,
        totalVendasDoCaixaAgora:r.totalVendas, resumoFinalGuardado:s.resumoFinal?.totalVendas??null,
        quantasVezesEssePedidoConta:vendasDessePedido.length,
        somaSoDessePedidoNoFechamento:+vendasDessePedido.reduce((a,m)=>a+(Number(m.total)||0),0).toFixed(2) };
    });
    res.json({ pedidoId:pid, ocorrenciasNoCaixa:ocorrencias.length, ocorrencias, bling:pedidoBling, fechamentosAfetados:fechamentos,
      diagnostico: ocorrencias.filter(o=>!o.cancelado).length>1
        ? `Esse pedido está lançado ${ocorrencias.filter(o=>!o.cancelado).length}x ATIVO no caixa. O Bling tem 1 pagamento real de ${pedidoBling?.total}. O fechamento está contando a diferença a mais.`
        : "Só 1 lançamento ativo — não está duplicado no caixa agora." });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.get("/api/diag/venda-vs-bling/:numero",async(req,res)=>{
  try{
    const numero=String(req.params.numero);
    // 1) o que o NOSSO caixa registrou pra esse pedido
    const dCx=lerCaixaSessoes();
    const movs=[];
    (dCx.sessoes||[]).forEach(s=>{
      (s.movimentos||[]).forEach(m=>{
        if(m.tipo!=="venda") return;
        if(String(m.numero)===numero || String(m.pedidoId)===numero){
          movs.push({ sessaoId:s.id, operadorCaixa:s.operador, tipoCaixa:s.tipoCaixa||"frente",
            pedidoId:m.pedidoId, numero:m.numero, total:m.total, em:new Date(m.em).toLocaleString("pt-BR"),
            itens:(m.itens||[]).map(i=>({nome:i.nome,quantidade:i.quantidade,valor:i.valor})),
            pagamentos:(m.pagamentos||[]).map(p=>({forma:p.formaNome,valor:p.valor})),
            clienteNome:m.clienteNome||"", operador:m.operador||"", alterado:!!m.alterado, cancelado:!!m.cancelado,
            valorMenor:m.valorMenor||null });
        }
      });
    });
    // 2) o que está no BLING (busca o pedido pelo numero)
    let bling1=null;
    try{
      const r=await bling(`/pedidos/vendas?numero=${encodeURIComponent(numero)}`);
      const achado=(r?.data||[])[0];
      if(achado){
        const d=await bling(`/pedidos/vendas/${achado.id}`).then(x=>x?.data);
        bling1={ id:d.id, numero:d.numero, total:d.total, observacoes:d.observacoes||"",
          itens:(d.itens||[]).map(it=>({nome:it.descricao||it.produto?.nome||"", quantidade:it.quantidade, valor:it.valor})),
          parcelas:(d.parcelas||[]).map(pc=>({valor:pc.valor, formaId:pc.formaPagamento?.id})),
          situacaoId:d.situacao?.id };
      }
    }catch(e){ bling1={erro:e.message}; }
    res.json({ numero, caixaRegistrou:movs, bling:bling1 });
  }catch(e){ res.status(500).json({erro:e.message,body:e.body}); }
});

app.post("/api/diag/corrigir-itens-movimento/:pedidoId",async(req,res)=>{
  // acerta os itens do movimento do caixa usando os itens do Bling (fonte da verdade).
  // Só mexe nos ITENS — não toca em total nem pagamento.
  try{
    const pid=String(req.params.pedidoId);
    const d=await bling(`/pedidos/vendas/${pid}`).then(r=>r?.data);
    if(!d) return res.status(404).json({erro:"pedido não encontrado no Bling"});
    const itensBling=(d.itens||[]).map(it=>({
      produtoId:it.produto?.id||null,
      nome:it.descricao||it.produto?.nome||"produto",
      quantidade:it.quantidade, valor:it.valor,
    }));
    const dCx=lerCaixaSessoes();
    let corrigidos=0; const antes=[];
    (dCx.sessoes||[]).forEach(s=>(s.movimentos||[]).forEach(m=>{
      if(m.tipo==="venda" && String(m.pedidoId)===pid){
        antes.push({itens:m.itens, total:m.total, pagamentos:m.pagamentos});
        m.itens=itensBling;
        corrigidos++;
      }
    }));
    if(corrigidos) salvarCaixaSessoes(dCx);
    res.json({ok:true, pedidoId:pid, corrigidos, itensAplicados:itensBling, totalBling:d.total, antes});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

app.get("/api/diag/movimentos-inconsistentes",(req,res)=>{
  // acha vendas do caixa onde a soma dos itens não bate com o total (descontando outras, frete E desconto)
  try{
    const dCx=lerCaixaSessoes();
    const achados=[];
    (dCx.sessoes||[]).forEach(s=>{
      (s.movimentos||[]).forEach(m=>{
        if(m.tipo!=="venda"||m.cancelado) return;
        if(!(m.itens||[]).length) return; // itens vazios é outro caso (detalhe faltando), não cruzamento
        const somaItens=+(m.itens||[]).reduce((a,i)=>a+(Number(i.valor)||0)*(Number(i.quantidade)||0),0).toFixed(2);
        const esperado=+((Number(m.total)||0)-(Number(m.outrasDespesas)||0)-(Number(m.frete)||0)+(Number(m.desconto)||0)).toFixed(2);
        const dif=+(somaItens-esperado).toFixed(2);
        if(Math.abs(dif)>0.10){
          achados.push({ sessaoId:s.id, operador:s.operador, pedidoId:m.pedidoId, numero:m.numero,
            em:new Date(m.em).toLocaleString("pt-BR"), total:m.total, outras:m.outrasDespesas||0, frete:m.frete||0, desconto:m.desconto||0,
            somaItens, esperadoDosItens:esperado, diferenca:dif, alterado:!!m.alterado,
            itens:(m.itens||[]).map(i=>({nome:i.nome,quantidade:i.quantidade,valor:i.valor})),
            pagamentos:(m.pagamentos||[]).map(p=>({forma:p.formaNome,valor:p.valor})) });
        }
      });
    });
    achados.sort((a,b)=>Math.abs(b.diferenca)-Math.abs(a.diferenca));
    res.json({ qtd:achados.length, achados:achados.slice(0,60) });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.get("/api/diag/vendas-por-produto/:termo",(req,res)=>{
  // acha vendas do caixa que tenham um produto cujo nome contém o termo (ex: BRAHMA)
  try{
    const termo=String(req.params.termo||"").toLowerCase();
    const dCx=lerCaixaSessoes();
    const achados=[];
    (dCx.sessoes||[]).forEach(s=>{
      (s.movimentos||[]).forEach(m=>{
        if(m.tipo!=="venda") return;
        const casa=(m.itens||[]).some(i=>String(i.nome||"").toLowerCase().includes(termo));
        if(casa){
          achados.push({ sessaoId:s.id, operador:s.operador, pedidoId:m.pedidoId, numero:m.numero, total:m.total,
            em:new Date(m.em).toLocaleString("pt-BR"), alterado:!!m.alterado, cancelado:!!m.cancelado,
            itens:(m.itens||[]).map(i=>({nome:i.nome,quantidade:i.quantidade,valor:i.valor})),
            pagamentos:(m.pagamentos||[]).map(p=>({forma:p.formaNome,valor:p.valor})) });
        }
      });
    });
    achados.sort((a,b)=>String(a.em)<String(b.em)?1:-1);
    res.json({termo, qtd:achados.length, achados:achados.slice(0,40)});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.get("/api/diag/vendas-por-valor/:valor",(req,res)=>{
  // acha vendas do caixa cujo total bate com um valor (pra localizar de onde veio a nota)
  try{
    const alvo=Number(String(req.params.valor).replace(",","."));
    const dCx=lerCaixaSessoes();
    const achados=[];
    (dCx.sessoes||[]).forEach(s=>{
      (s.movimentos||[]).forEach(m=>{
        if(m.tipo!=="venda") return;
        if(Math.abs((Number(m.total)||0)-alvo)<0.02){
          achados.push({ sessaoId:s.id, operador:s.operador, pedidoId:m.pedidoId, numero:m.numero, total:m.total,
            em:new Date(m.em).toLocaleString("pt-BR"),
            pagamentos:(m.pagamentos||[]).map(p=>({forma:p.formaNome,valor:p.valor})) });
        }
      });
    });
    res.json({valor:alvo, achados});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.get("/api/diag/probe-entradas",async(req,res)=>{
  const tries=[
    "/nfe?tipo=0&dataEmissaoInicial=2026-06-01&dataEmissaoFinal=2026-09-03&limite=100",
    "/nfe?dataEmissaoInicial=2026-09-01&dataEmissaoFinal=2026-09-03&limite=100",
    "/notas-fiscais-entrada?limite=100",
    "/notasfiscais?tipo=0&limite=100",
    "/estoques/entradas?limite=100",
  ];
  const out=[];
  for(const u of tries){
    try{
      const r=await bling(u); const arr=(r&&r.data)||[];
      out.push({url:u, ok:true, count:Array.isArray(arr)?arr.length:0,
        amostra:(Array.isArray(arr)?arr:[]).slice(0,5).map(n=>({numero:n.numero, tipo:n.tipo, contato:(n.contato&&n.contato.nome)||(n.fornecedor&&n.fornecedor.nome)||null, data:n.dataEmissao||n.data, valor:n.valorNota??n.valor??null})) });
    }catch(e){ out.push({url:u, ok:false, status:e.status||null, erro:e.message}); }
    await sleep(250);
  }
  res.json({out});
});

app.get("/api/diag/situacoes-compras",async(req,res)=>{
  try{
    const mods=await bling(`/situacoes/modulos`).then(r=>r?.data||[]).catch(()=>[]);
    const mod=(mods||[]).find(m=>/compra/i.test(m.nome||"")) || null;
    let situacoes=[];
    if(mod){ try{ situacoes=await bling(`/situacoes/modulos/${mod.id}`).then(r=>r?.data||[]); }catch(e){} }
    res.json({ modulos:(mods||[]).map(m=>({id:m.id,nome:m.nome})), moduloCompra:mod, situacoes });
  }catch(e){ res.status(500).json({erro:e.message,body:e.body}); }
});

app.get("/api/diag/compra-detalhe/:id",async(req,res)=>{
  try{
    const d=await bling(`/pedidos/compras/${req.params.id}`).then(r=>r?.data);
    if(!d) return res.json({erro:"pedido de compra não encontrado"});
    // devolve o objeto quase cru pra eu ver onde fica fornecedor e nota fiscal vinculada
    res.json({
      id:d.id, numero:d.numero, data:d.data, total:d.total, situacao:d.situacao,
      fornecedor:d.fornecedor||d.contato||null,
      notaFiscal:d.notaFiscal||null, chaveAcesso:d.chaveAcesso||d.notaFiscal?.chaveAcesso||null,
      temNotaVinculada: !!(d.notaFiscal&&(d.notaFiscal.id||d.notaFiscal.numero)),
      qtdItens:(d.itens||[]).length,
      chaves: Object.keys(d),   // pra eu ver todos os campos disponíveis
      _raw: d,
    });
  }catch(e){ res.status(e.status||500).json({erro:e.message, body:e.body}); }
});

app.get("/api/diag/compras-inspecionar",async(req,res)=>{
  try{
    const dias=Number(req.query.dias||90);
    const hoje=new Date();
    const de=new Date(hoje.getTime()-dias*86400000);
    const fmt=(d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const ini=fmt(de), fim=fmt(hoje);
    let compras=[], pagina=1, erroBling=null;
    for(let i=0;i<3;i++){
      const p=new URLSearchParams({dataInicial:ini, dataFinal:fim, pagina:String(pagina), limite:"100"});
      let r; try{ r=await bling(`/pedidos/compras?${p.toString()}`); }catch(e){ erroBling=e.message; break; }
      const arr=r?.data||[]; compras=compras.concat(arr);
      if(arr.length<100) break; pagina++; await sleep(150);
    }
    res.json({
      periodo:{ini,fim,dias}, total:compras.length, erroBling,
      amostra:compras.slice(0,40).map(c=>({ id:c.id, numero:c.numero, data:c.data, fornecedor:c.fornecedor?.nome||c.contato?.nome||null, total:c.total??null, situacao:c.situacao })),
    });
  }catch(e){ res.status(e.status||500).json({erro:e.message, body:e.body}); }
});

app.get("/api/diag/nfe-inspecionar",async(req,res)=>{
  try{
    const dias=Number(req.query.dias||90);
    const hoje=new Date();
    const de=new Date(hoje.getTime()-dias*86400000);
    const fmt=(d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const ini=fmt(de), fim=fmt(hoje);
    let notas=[], pagina=1, erroBling=null;
    for(let i=0;i<3;i++){
      const p=new URLSearchParams({dataEmissaoInicial:ini, dataEmissaoFinal:fim, pagina:String(pagina), limite:"100"});
      let r; try{ r=await bling(`/nfe?${p.toString()}`); }catch(e){ erroBling=e.message; break; }
      const arr=r?.data||[]; notas=notas.concat(arr);
      if(arr.length<100) break; pagina++; await sleep(150);
    }
    const porTipo={};
    notas.forEach(n=>{ const t=String(n.tipo); porTipo[t]=(porTipo[t]||0)+1; });
    res.json({
      periodo:{ini,fim,dias}, total:notas.length, erroBling, porTipo,
      amostra:notas.slice(0,40).map(n=>({ id:n.id, numero:n.numero, tipo:n.tipo, dataEmissao:n.dataEmissao,
        contato:n.contato?.nome||null, valor:n.valorNota??n.valor??null, situacao:n.situacao })),
    });
  }catch(e){ res.status(e.status||500).json({erro:e.message, body:e.body}); }
});

app.get("/api/diag/notas-entrada-mes",async(req,res)=>{
  try{
    const now=new Date();
    const ini=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`;
    const fimD=new Date(now.getFullYear(), now.getMonth()+1, 0);
    const fim=`${fimD.getFullYear()}-${String(fimD.getMonth()+1).padStart(2,"0")}-${String(fimD.getDate()).padStart(2,"0")}`;
    let notas=[], pagina=1, erroBling=null;
    for(let i=0;i<5;i++){
      const p=new URLSearchParams({tipo:"0", dataEmissaoInicial:ini, dataEmissaoFinal:fim, pagina:String(pagina), limite:"100"});
      let r;
      try{ r=await bling(`/nfe?${p.toString()}`); }catch(e){ erroBling=e.message; break; }
      const arr=r?.data||[];
      notas=notas.concat(arr);
      if(arr.length<100) break;
      pagina++; await sleep(150);
    }
    res.json({
      periodo:{ini,fim}, total:notas.length, erroBling,
      notas:notas.slice(0,60).map(n=>({ id:n.id, numero:n.numero, serie:n.serie, dataEmissao:n.dataEmissao,
        contato:n.contato?.nome||null, valor:n.valorNota??n.valor??null, situacao:n.situacao, tipo:n.tipo, chaveAcesso:n.chaveAcesso||null })),
    });
  }catch(e){ res.status(e.status||500).json({erro:e.message, body:e.body}); }
});

app.get("/api/diag/vendedor-pedido/:numero",async(req,res)=>{
  try{
    const n=String(req.params.numero).trim();
    // 1) como vem na LISTAGEM (é o que a Central usa)
    const hoje=_hojeISO();
    const rl=await bling(`/pedidos/vendas?dataInicial=${hoje}&dataFinal=${hoje}&limite=100`).catch(e=>({erro:e.message}));
    const naLista=(rl?.data||[]).find(p=>String(p.numero)===n);
    // 2) como vem no DETALHE do pedido
    let detalhe=null; try{ const r=await bling(`/pedidos/vendas?numero=${encodeURIComponent(n)}`); const a=(r?.data||[])[0]; if(a?.id) detalhe=await bling(`/pedidos/vendas/${a.id}`).then(x=>x?.data); }catch(e){}
    res.json({
      numero:n,
      naListagem:{ encontrado:!!naLista, vendedorCru:naLista?.vendedor||null, contatoNome:naLista?.contato?.nome||null },
      noDetalhe:{ encontrado:!!detalhe, vendedorCru:detalhe?.vendedor||null, contatoNome:detalhe?.contato?.nome||null },
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.get("/api/diag/frete/:id",async(req,res)=>{
  try{
    const d=await bling(`/pedidos/vendas/${req.params.id}`).then(r=>r?.data);
    if(!d) return res.json({erro:"pedido não encontrado"});
    res.json({
      id:d.id, numero:d.numero,
      total:d.total, totalProdutos:d.totalProdutos,
      outrasDespesas:d.outrasDespesas, desconto:d.desconto,
      transporteFrete:d.transporte?.frete,
      transporte:d.transporte||null,
      diffTotalProdutos:(Number(d.total||0)-Number(d.totalProdutos||0)),
    });
  }catch(e){ res.status(500).json({erro:e.message,body:e.body}); }
});

// DIAGNÓSTICO: mostra as contas a receber ligadas a um pedido (pra editar a forma sem tocar no estoque)
// VERIFICA em lote: vendas recentes do caixa atacado x o que está no Bling (pagamento,
// total, situação). Aponta as que NÃO bateram, pra achar pedidos editados/concluídos
// que não foram salvos no Bling.
app.get("/api/diag/sync-caixa-bling",async(req,res)=>{
  try{
    const dias=Number(req.query.dias||3);
    const soAlterados=req.query.soAlterados==="1";
    const desde=Date.now()-dias*86400000;
    const dCx=lerCaixaSessoes();
    const vendas=[];
    (dCx.sessoes||[]).forEach(s=>{
      if((s.tipoCaixa||"frente")!=="atacado") return;
      (s.movimentos||[]).forEach(m=>{
        if(m.tipo!=="venda"||m.cancelado) return;
        if(m.em<desde) return;
        if(soAlterados&&!m.alterado) return;
        vendas.push({ sessao:s.operador, pedidoId:m.pedidoId, numero:m.numero, total:Number(m.total)||0,
          pagamentos:(m.pagamentos||[]).map(p=>({forma:p.formaNome||"—", valor:Number(p.valor)||0})),
          alterado:!!m.alterado, em:m.em });
      });
    });
    const norm=(s)=>String(s||"").toLowerCase().replace(/pix.*/,"pix").replace(/[^a-z0-9]/g,"");
    const out=[]; let ok=0;
    for(const v of vendas.slice(0,80)){
      let b=null, erro=null;
      try{ b=await bling(`/pedidos/vendas/${v.pedidoId}`).then(r=>r?.data); }catch(e){ erro=e.message; }
      if(!b){ out.push({...v, status:"NAO_ENCONTRADO_NO_BLING", erro}); continue; }
      const parcelas=[];
      for(const pc of (b.parcelas||[])){ parcelas.push({forma:await nomeFormaPagamentoId(pc.formaPagamento?.id), valor:Number(pc.valor)||0}); }
      const totalBling=Number(b.total)||0;
      const somaCaixa=+v.pagamentos.reduce((s,p)=>s+p.valor,0).toFixed(2);
      const somaBling=+parcelas.reduce((s,p)=>s+p.valor,0).toFixed(2);
      const formasCaixa=v.pagamentos.map(p=>norm(p.forma)).sort().join("|");
      const formasBling=parcelas.map(p=>norm(p.forma)).sort().join("|");
      const difTotal=Math.abs(v.total-totalBling)>0.009;
      const difSoma=Math.abs(somaCaixa-somaBling)>0.009;
      const difFormas=formasCaixa!==formasBling;
      const sit=Number(b.situacao?.id||0);
      const sitNome=nomeSituacao(sit);
      if(difTotal||difSoma||difFormas){
        out.push({ ...v, status:"DIVERGENTE", bling:{ total:totalBling, parcelas, situacao:sitNome },
          motivo:[difTotal?"total":"",difSoma?"soma do pagamento":"",difFormas?"formas de pagamento":""].filter(Boolean).join(", ") });
      } else { ok++; if(sit!==SIT.ATENDIDO) out.push({ ...v, status:"OK_MAS_SITUACAO", bling:{situacao:sitNome} }); }
      await sleep(120);
    }
    res.json({ dias, soAlterados, verificadas:Math.min(vendas.length,80), totalVendas:vendas.length, batendo:ok, problemas:out.length, lista:out });
  }catch(e){ res.status(500).json({erro:e.message,body:e.body}); }
});

app.get("/api/diag/estoque-pedido/:pedidoId",async(req,res)=>{
  try{
    let ped=await bling(`/pedidos/vendas/${req.params.pedidoId}`).then(r=>r?.data).catch(()=>null);
    if(!ped){ try{ const r=await bling(`/pedidos/vendas?numero=${encodeURIComponent(req.params.pedidoId)}`); const a=(r?.data||[])[0]; if(a?.id) ped=await bling(`/pedidos/vendas/${a.id}`).then(x=>x?.data); }catch(e){} }
    if(!ped) return res.json({erro:"pedido não encontrado"});
    const itens=[];
    for(const it of (ped.itens||[])){
      const pid=it.produto?.id; let saldo=null, nome=it.descricao||"";
      if(pid){ try{ const p=await bling(`/produtos/${pid}`).then(r=>r?.data); saldo=p?.estoque?.saldoVirtualTotal ?? p?.estoque?.saldoFisicoTotal ?? null; nome=p?.nome||nome; }catch(e){} }
      itens.push({ produtoId:pid, nome, codigo:it.produto?.codigo||"", quantidadeNaVenda:it.quantidade, saldoAtual:saldo, negativo: saldo!=null && saldo<0 });
      await sleep(120);
    }
    res.json({ pedido:{id:ped.id, numero:ped.numero, total:ped.total}, itens, negativos:itens.filter(i=>i.negativo) });
  }catch(e){ res.status(500).json({erro:e.message,body:e.body}); }
});

app.get("/api/diag/conta-receber/:pedidoId",async(req,res)=>{
  try{
    // resolve: tenta como id interno; se não achar, busca pelo número
    let ped=await bling(`/pedidos/vendas/${req.params.pedidoId}`).then(r=>r?.data).catch(()=>null);
    if(!ped){
      try{ const r=await bling(`/pedidos/vendas?numero=${encodeURIComponent(req.params.pedidoId)}`); const a=(r?.data||[])[0]; if(a?.id) ped=await bling(`/pedidos/vendas/${a.id}`).then(x=>x?.data); }catch(e){}
    }
    if(!ped) return res.json({erro:"pedido não encontrado (nem por id nem por número)"});
    const contatoId=ped.contato?.id;
    let contas=[];
    try{
      const pr=new URLSearchParams({pagina:1,limite:100}); if(contatoId) pr.set("idContato",contatoId);
      const rc=await bling(`/contas/receber?${pr.toString()}`);
      contas=(rc.data||[]);
    }catch(e){ return res.json({erroContas:e.message,body:e.body, pedidoNumero:ped.numero, contatoId}); }
    let detalhe=null;
    if(contas[0]?.id){ try{ detalhe=await bling(`/contas/receber/${contas[0].id}`).then(r=>r?.data); }catch(e){} }
    res.json({
      pedido:{ id:ped.id, numero:ped.numero, total:ped.total, contatoId, contatoNome:ped.contato?.nome,
        parcelas:(ped.parcelas||[]).map(p=>({id:p.id, valor:p.valor, formaPagamento:p.formaPagamento})) },
      qtdContasDoContato: contas.length,
      contasDoContato: contas.slice(0,20).map(c=>({id:c.id, valor:c.valor, situacao:c.situacao, vencimento:c.vencimento, dataEmissao:c.dataEmissao, formaPagamento:c.formaPagamento, numeroDocumento:c.numeroDocumento})),
      detalhePrimeiraConta: detalhe,
    });
  }catch(e){ res.status(500).json({erro:e.message,body:e.body}); }
});






app.get("/api/caixa-sessao/atual",(req,res)=>{
  const s=sessaoCaixaAberta(req.query.funcionarioId,req.query.tipoCaixa);
  if(!s) return res.json({aberta:false});
  res.json({
    aberta:true,
    sessao:{id:s.id,abertaEm:s.abertaEm,operador:s.operador,funcionarioId:s.funcionarioId,trocoInicial:s.trocoInicial,tipoCaixa:s.tipoCaixa||"frente"},
    resumo:resumoSessaoCaixa(s),
    movimentos:(s.movimentos||[]).slice().sort((a,b)=>b.em-a.em),
  });
});

// lista todos os caixas abertos agora (de todo mundo) — pra ver quem está com caixa aberto
app.get("/api/caixa-sessao/abertos",(req,res)=>{
  const d=lerCaixaSessoes();
  let abertos=(d.sessoes||[]).filter(s=>!s.fechadaEm);
  // filtro opcional por tipo (frente/atacado)
  if(req.query.tipoCaixa) abertos=abertos.filter(s=>(s.tipoCaixa||"frente")===req.query.tipoCaixa);
  res.json({data:abertos.map(s=>({id:s.id,operador:s.operador,funcionarioId:s.funcionarioId,abertaEm:s.abertaEm,tipoCaixa:s.tipoCaixa||"frente",resumo:resumoSessaoCaixa(s)}))});
});

// abre o caixa informando o troco inicial (fundo de caixa) — vinculado ao funcionário logado
app.post("/api/caixa-sessao/abrir",(req,res)=>{
  const {trocoInicial,operador,funcionarioId,tipoCaixa}=req.body||{};
  const tipo=tipoCaixa||"frente";
  if(!funcionarioId) return res.status(400).json({erro:"Sessão não identificada — faça login de novo."});
  if(sessaoCaixaAberta(funcionarioId,tipo)) return res.status(400).json({erro:"Você já tem um caixa "+(tipo==="atacado"?"atacado ":"")+"aberto. Feche o atual antes de abrir outro."});
  const d=lerCaixaSessoes();
  const sessao={
    id:"cx"+Date.now()+crypto.randomBytes(3).toString("hex"),
    abertaEm:Date.now(),
    operador:operador||"—",
    funcionarioId,
    tipoCaixa:tipo,
    trocoInicial:+Number(trocoInicial||0).toFixed(2),
    movimentos:[],
    fechadaEm:null,
  };
  d.sessoes=d.sessoes||[]; d.sessoes.push(sessao); salvarCaixaSessoes(d);
  res.json({ok:true,sessao,resumo:resumoSessaoCaixa(sessao)});
});

// registra sangria (retirada) ou suprimento (entrada de dinheiro)
app.post("/api/caixa-sessao/movimento",(req,res)=>{
  const {tipo,valor,motivo,operador,funcionarioId,tipoCaixa,responsavelId}=req.body||{};
  if(!["sangria","suprimento"].includes(tipo)) return res.status(400).json({erro:"tipo deve ser sangria ou suprimento"});
  const v=+Number(valor||0).toFixed(2);
  if(!(v>0)) return res.status(400).json({erro:"informe um valor maior que zero"});
  // quem RECEBEU a sangria / ENTREGOU o suprimento (outra pessoa, não o operador do caixa)
  if(!responsavelId) return res.status(400).json({erro:tipo==="sangria"?"informe quem está retirando o dinheiro":"informe quem está entregando o dinheiro"});
  const funcs=lerJSON(FUNC_FILE,{});
  const resp=funcs[responsavelId];
  if(!resp) return res.status(400).json({erro:"funcionário responsável não encontrado"});
  if(String(responsavelId)===String(funcionarioId)) return res.status(400).json({erro:"o responsável tem que ser outra pessoa, não o próprio operador do caixa"});
  const d=lerCaixaSessoes();
  const tc=tipoCaixa||"frente";
  const sessao=(d.sessoes||[]).find(s=>!s.fechadaEm&&s.funcionarioId===funcionarioId&&(s.tipoCaixa||"frente")===tc);
  if(!sessao) return res.status(400).json({erro:"Nenhum caixa aberto pra esse usuário"});
  sessao.movimentos.push({tipo,valor:v,motivo:motivo||"",operador:operador||"—",em:Date.now(),
    responsavelId:String(responsavelId), responsavelNome:resp.nome||""});
  salvarCaixaSessoes(d);
  addLog("caixa-"+sessao.id, tipo==="sangria"?"sangria":"suprimento", funcionarioId, operador||"—", {valor:v,motivo:motivo||"",responsavel:resp.nome||""});
  res.json({ok:true,resumo:resumoSessaoCaixa(sessao),responsavelNome:resp.nome||""});
});

// fecha o caixa, comparando o contado com o esperado (conferência)
// fecha um caixa ESPECÍFICO pelo id (usado na Gestão de Caixas pra fechar qualquer caixa,
// não só o do próprio usuário logado)
app.post("/api/caixa-sessao/:id/fechar",(req,res)=>{
  const {valorContado,observacao,operador}=req.body||{};
  const d=lerCaixaSessoes();
  const sessao=(d.sessoes||[]).find(s=>String(s.id)===String(req.params.id));
  if(!sessao) return res.status(404).json({erro:"Caixa não encontrado"});
  if(sessao.fechadaEm) return res.status(400).json({erro:"Esse caixa já está fechado"});
  const resumo=resumoSessaoCaixa(sessao);
  const contado=+Number(valorContado||0).toFixed(2);
  const diferenca=+(contado-resumo.esperadoGaveta).toFixed(2);
  sessao.fechadaEm=Date.now();
  sessao.fechamento={valorContado:contado,esperado:resumo.esperadoGaveta,diferenca,observacao:observacao||"",operador:operador||"—",fechadoPorGestao:true};
  sessao.resumoFinal=resumo;
  salvarCaixaSessoes(d);
  res.json({ok:true,resumo,fechamento:sessao.fechamento});
});

app.post("/api/caixa-sessao/fechar",(req,res)=>{
  const {valorContado,observacao,operador,funcionarioId,tipoCaixa}=req.body||{};
  const d=lerCaixaSessoes();
  const tc=tipoCaixa||"frente";
  const sessao=(d.sessoes||[]).find(s=>!s.fechadaEm&&s.funcionarioId===funcionarioId&&(s.tipoCaixa||"frente")===tc);
  if(!sessao) return res.status(400).json({erro:"Nenhum caixa aberto pra esse usuário"});
  const resumo=resumoSessaoCaixa(sessao);
  const contado=+Number(valorContado||0).toFixed(2);
  const diferenca=+(contado-resumo.esperadoGaveta).toFixed(2);
  sessao.fechadaEm=Date.now();
  sessao.fechamento={valorContado:contado,esperado:resumo.esperadoGaveta,diferenca,observacao:observacao||"",operador:operador||"—"};
  sessao.resumoFinal=resumo;
  salvarCaixaSessoes(d);
  res.json({
    ok:true,resumo,fechamento:sessao.fechamento,
    sessao:{id:sessao.id,abertaEm:sessao.abertaEm,operador:sessao.operador,trocoInicial:sessao.trocoInicial},
    movimentos:(sessao.movimentos||[]).slice().sort((a,b)=>b.em-a.em),
  });
});

// histórico de sessões já fechadas (traz também os movimentos, pra ver o que foi feito naquele dia)
app.get("/api/caixa-sessao/historico",(req,res)=>{
  const d=lerCaixaSessoes();
  const fechadas=(d.sessoes||[]).filter(s=>s.fechadaEm).sort((a,b)=>b.fechadaEm-a.fechadaEm).slice(0,50);
  res.json({data:fechadas.map(s=>({
    id:s.id,abertaEm:s.abertaEm,fechadaEm:s.fechadaEm,operador:s.operador,funcionarioId:s.funcionarioId,tipoCaixa:s.tipoCaixa||"frente",
    trocoInicial:s.trocoInicial,fechamento:s.fechamento,resumo:s.resumoFinal||resumoSessaoCaixa(s),movimentos:s.movimentos||[],
  }))});
});

// detalhe (histórico de movimentos) de UMA sessão específica, aberta ou fechada
app.get("/api/caixa-sessao/:id/movimentos",(req,res)=>{
  const d=lerCaixaSessoes();
  const s=(d.sessoes||[]).find(x=>x.id===req.params.id);
  if(!s) return res.status(404).json({erro:"sessão não encontrada"});
  res.json({
    sessao:{id:s.id,abertaEm:s.abertaEm,fechadaEm:s.fechadaEm,operador:s.operador,trocoInicial:s.trocoInicial,tipoCaixa:s.tipoCaixa||"frente"},
    resumo:s.resumoFinal||resumoSessaoCaixa(s),
    fechamento:s.fechamento||null,
    conferencias:(s.conferencias||[]).slice().sort((a,b)=>b.em-a.em),
    movimentos:(s.movimentos||[]).sort((a,b)=>b.em-a.em),
  });
});

// AJUSTAR (editar) o esperado na gaveta de uma sessão — ajuste manual do gestor.
// Mantém o calculado no resumo (esperadoGavetaCalc) pra referência. limpar=true volta ao calculado.
app.post("/api/caixa-sessao/:id/esperado",(req,res)=>{
  const {esperado,limpar,operador,funcionarioId,motivo}=req.body||{};
  const d=lerCaixaSessoes();
  const s=(d.sessoes||[]).find(x=>x.id===req.params.id);
  if(!s) return res.status(404).json({erro:"sessão não encontrada"});
  if(limpar){ delete s.esperadoGavetaManual; }
  else{
    const v=Number(esperado);
    if(!(v>=0)) return res.status(400).json({erro:"informe um valor válido (>= 0)"});
    s.esperadoGavetaManual=+v.toFixed(2);
  }
  s.ajustesEsperado=[...(s.ajustesEsperado||[]),{em:Date.now(),esperado:(limpar?null:s.esperadoGavetaManual),por:operador||"—",funcionarioId:funcionarioId||null,motivo:motivo||"",limpou:!!limpar}];
  salvarCaixaSessoes(d);
  res.json({ok:true,resumo:resumoSessaoCaixa(s)});
});

// SALVAR uma conferência de caixa (contagem por forma + dinheiro na gaveta), com as
// diferenças calculadas. Não fecha o caixa — é só uma verificação registrada (auditoria).
app.post("/api/caixa-sessao/:id/conferencia",(req,res)=>{
  const {contagem,contadoGaveta,observacao,operador,funcionarioId}=req.body||{};
  const d=lerCaixaSessoes();
  const s=(d.sessoes||[]).find(x=>x.id===req.params.id);
  if(!s) return res.status(404).json({erro:"sessão não encontrada"});
  const resumo=resumoSessaoCaixa(s);
  const espPorForma={}; (resumo.porForma||[]).forEach(f=>espPorForma[f.nome]=f.valor);
  const linhas=(Array.isArray(contagem)?contagem:[]).map(c=>{
    const esperado=+Number(espPorForma[c.nome]||0).toFixed(2);
    const contado=+Number(c.contado||0).toFixed(2);
    return {nome:c.nome,esperado,contado,diferenca:+(contado-esperado).toFixed(2)};
  });
  const espGav=Number(resumo.esperadoGaveta||0);
  const contGav=+Number(contadoGaveta||0).toFixed(2);
  const difGav=+(contGav-espGav).toFixed(2);
  const conferencia={
    em:Date.now(), por:operador||"—", funcionarioId:funcionarioId||null,
    linhas, gaveta:{esperado:+espGav.toFixed(2),contado:contGav,diferenca:difGav},
    diferencaTotal:+(linhas.reduce((a,l)=>a+l.diferenca,0)+difGav).toFixed(2),
    observacao:observacao||"",
  };
  s.conferencias=[...(s.conferencias||[]),conferencia];
  salvarCaixaSessoes(d);
  res.json({ok:true,conferencia});
});

// ---------------- LISTA DE FARDO (varejo promocional por fardo) ----------------
// Reaproveita os vínculos (código Bling) já feitos na Tabela Atacado, mas guarda um
// preço PRÓPRIO (o "preço de fardo") num arquivo separado — nunca mexe no tabela.json.
function lerListaFardo(){ return lerJSON(LISTA_FARDO_FILE,{}); } // { itemId: precoFardo }
function salvarListaFardo(d){ salvarJSON(LISTA_FARDO_FILE,d); }

// Varre o modelo da tabela atacado e monta um índice: código Bling -> {itemId, categoriaNome, itemNome, precoAtacado, produtoId}
function indexarVinculosTabela(){
  const tab=lerTabela();
  const idx={};
  (tab?.model||[]).forEach(cat=>{
    (cat.itens||[]).forEach(it=>{
      (it.bling||[]).forEach(b=>{
        idx[String(b.codigo)]={itemId:it.id,categoriaNome:cat.t||"",itemNome:it.nome||"",precoAtacado:it.preco,produtoId:b.id,caixaQtd:it.caixa||null};
      });
    });
  });
  return idx;
}

// lista completa (pra tela de gestão) — junta nome/categoria/preço atacado + preço fardo salvo
// info de fardo (preço + quantidade mínima) pra um código específico — usado no Frente de
// Caixa pra aplicar automaticamente o preço de fardo quando a quantidade bater
// ---------------- PESQUISA DE PREÇO (pra responder cliente no WhatsApp) ----------------
// Índice auxiliar: por CÓDIGO e por NOME do vínculo, o preço de atacado + fardo + caixa.
// Usado pra enriquecer os produtos vindos do Bling com atacado/fardo quando existir.
function _indicePrecosTabela(){
  const tab=lerTabela();
  const fardo=lerListaFardo();
  const porCodigo={}, porNome={};
  // o lista_fardo guarda o fardo como objeto {preco: X} (não número direto).
  // lê de forma robusta: pega .preco se for objeto, ou o número se vier direto.
  const precoFardoDe=(itemId)=>{
    const e=fardo[itemId];
    if(e==null) return null;
    const v=(typeof e==="object")?e.preco:e;
    return (v!=null && Number(v)>0)?Number(v):null;
  };
  (tab?.model||[]).forEach(cat=>(cat.itens||[]).forEach(it=>{
    const info={itemId:it.id, categoria:cat.t||"", itemNome:it.nome||"", precoAtacado:it.preco??null,
      precoFardo: precoFardoDe(it.id), caixaQtd:it.caixa||null};
    (it.bling||[]).forEach(b=>{
      if(b.codigo) porCodigo[String(b.codigo)]=info;
      if(b.nome) porNome[String(b.nome).toLowerCase().trim()]=info;
    });
    if(it.nome) porNome[String(it.nome).toLowerCase().trim()]=info;
  }));
  return {porCodigo, porNome};
}

// lista as categorias da tabela de atacado (pro seletor de categoria)
app.get("/api/precos/categorias",(req,res)=>{
  try{
    const tab=lerTabela();
    const cats=(tab?.model||[]).map(c=>c.t).filter(Boolean);
    res.json({categorias:[...new Set(cats)]});
  }catch(e){ res.json({categorias:[]}); }
});

// BUSCA de produto pra pesquisa de preço. Busca DIRETO no Bling por nome (todos
// os produtos, não só os da tabela), pega o preço REAL do Bling do detalhe de
// cada um (a listagem vem com preço zerado), e cruza com atacado + fardo da
// tabela. Traz os 3 preços quando existirem. Se vier ?categoria=, filtra os
// produtos da tabela de atacado daquela categoria em vez de buscar no Bling.
app.get("/api/precos/buscar",async(req,res)=>{
  try{
    const q=(req.query.q||"").toString().slice(0,80).trim();
    const categoria=(req.query.categoria||"").toString().trim();
    const idx=_indicePrecosTabela();

    // Modo 1: filtro por categoria → usa os produtos da tabela de atacado dessa categoria
    if(categoria && !q){
      const tab=lerTabela();
      const cat=(tab?.model||[]).find(c=>c.t===categoria);
      if(!cat) return res.json({data:[]});
      // pega o preço do Bling do detalhe de cada produto da categoria (poucos por vez)
      const out=[];
      for(const it of (cat.itens||[])){
        const primeiroBling=(it.bling||[])[0];
        let precoBling=null;
        if(primeiroBling?.id){
          try{ const d=await bling(`/produtos/${primeiroBling.id}`).then(r=>r?.data); precoBling=+(d?.preco||0)||null; }catch(e){}
          await new Promise(r=>setTimeout(r,120));
        }
        out.push({ nome:it.nome||"", categoria, precoAtacado:it.preco??null,
          precoBling, precoFardo: idx.porCodigo[String(primeiroBling?.codigo)]?.precoFardo ?? null,
          caixaQtd: it.caixa||null });
      }
      return res.json({data:out});
    }

    if(q.length<2) return res.json({data:[]});
    // Modo 2: busca por nome DIRETO no Bling
    let achados=[];
    try{ const d=await bling(`/produtos?nome=${encodeURIComponent(q)}&limite=40`); achados=d?.data||[]; }catch(e){}
    // pega o preço real do detalhe de cada um (a listagem vem com preço 0)
    const out=[];
    for(const prod of achados.slice(0,25)){
      let precoBling=+(prod.preco||0)||null;
      // se veio zerado na listagem, busca no detalhe
      if(!precoBling && prod.id){
        try{ const d=await bling(`/produtos/${prod.id}`).then(r=>r?.data); precoBling=+(d?.preco||0)||null; }catch(e){}
        await new Promise(r=>setTimeout(r,120));
      }
      // cruza com atacado/fardo da tabela (por código, depois por nome)
      const info = idx.porCodigo[String(prod.codigo)] || idx.porNome[String(prod.nome||"").toLowerCase().trim()] || null;
      out.push({
        nome: prod.nome||"",
        categoria: info?.categoria || "",
        precoAtacado: info?.precoAtacado ?? null,
        precoBling,
        precoFardo: info?.precoFardo ?? null,
        caixaQtd: info?.caixaQtd ?? null,
      });
    }
    res.json({data:out});
  }catch(e){ res.status(500).json({erro:e.message,data:[]}); }
});


// Diferente da Lista de Fardo (fixa, ligada à quantidade), essas são listas criadas livremente,
// cada uma com nome, tipo e data final opcional (pra saber até quando o preço vale).
function lerListasExtras(){ return lerJSON(LISTAS_EXTRAS_FILE,{listas:[]}); }
function salvarListasExtras(d){ salvarJSON(LISTAS_EXTRAS_FILE,d); }

app.get("/api/listas-extras",(req,res)=>{
  const d=lerListasExtras();
  res.json({data:(d.listas||[]).map(l=>({id:l.id,nome:l.nome,tipo:l.tipo,dataFinal:l.dataFinal||null,qtdItens:Object.keys(l.precos||{}).length,
    expirada:l.dataFinal?new Date(l.dataFinal+"T23:59:59")<new Date():false}))});
});

app.post("/api/listas-extras",(req,res)=>{
  const {nome,tipo,dataFinal}=req.body||{};
  if(!nome) return res.status(400).json({erro:"informe o nome da lista"});
  const d=lerListasExtras();
  const lista={id:"le"+Date.now()+crypto.randomBytes(3).toString("hex"),nome,tipo:tipo||"promocao",dataFinal:dataFinal||null,precos:{},criadaEm:Date.now()};
  d.listas=d.listas||[]; d.listas.push(lista);
  salvarListasExtras(d);
  res.json({ok:true,id:lista.id});
});

app.delete("/api/listas-extras/:listaId",(req,res)=>{
  const d=lerListasExtras();
  d.listas=(d.listas||[]).filter(l=>l.id!==req.params.listaId);
  salvarListasExtras(d);
  res.json({ok:true});
});

// detalhe de uma lista, já cruzado com nome/atacado da tabela (mesmo padrão da lista de fardo)
app.get("/api/listas-extras/:listaId",(req,res)=>{
  const d=lerListasExtras();
  const lista=(d.listas||[]).find(l=>l.id===req.params.listaId);
  if(!lista) return res.status(404).json({erro:"lista não encontrada"});
  const idx=indexarVinculosTabela();
  const porItem={};
  Object.values(idx).forEach(v=>{ if(!porItem[v.itemId]) porItem[v.itemId]={itemId:v.itemId,categoriaNome:v.categoriaNome,itemNome:v.itemNome,precoAtacado:v.precoAtacado,precoLista:lista.precos[v.itemId]??null}; });
  Object.entries(lista.precos||{}).forEach(([itemId,v])=>{
    if(v&&v.origem==="avulso") porItem[itemId]={itemId,categoriaNome:"(avulso)",itemNome:v.nome,precoAtacado:null,precoLista:v.preco};
  });
  res.json({lista:{id:lista.id,nome:lista.nome,tipo:lista.tipo,dataFinal:lista.dataFinal},
    data:Object.values(porItem).filter(i=>i.precoLista!=null).sort((a,b)=>a.itemNome.localeCompare(b.itemNome))});
});

// ==================== ÁREA DE AJUSTE DE ESTOQUE ====================
// Monta a lista "achatada" de produtos na ORDEM da tabela de atacado (categoria
// por categoria, item por item, um por vínculo Bling) — usada pra listar/ajustar estoque.
function listaProdutosOrdemTabela(){
  const tab=lerTabela();
  const linhas=[];
  const vistos=new Set();
  (tab?.model||[]).forEach(cat=>{
    (cat.itens||[]).forEach(it=>{
      (it.bling||[]).forEach(b=>{
        if(!b.id||vistos.has(String(b.id))) return;
        vistos.add(String(b.id));
        linhas.push({
          produtoId:Number(b.id),
          codigo:b.codigo||"",
          nome:b.nome||it.nome||"",
          itemNome:it.nome||"",
          categoria:cat.t||"",
          precoAtacado:it.preco??null,
        });
      });
    });
  });
  return linhas;
}

// Lista os produtos na ordem da tabela, paginado de 20 em 20, com o saldo atual do Bling.
app.get("/api/estoque/lista",async(req,res)=>{
  try{
    const pagina=Math.max(1,Number(req.query.pagina||1));
    const porPagina=20;
    const todas=listaProdutosOrdemTabela();
    const totalProdutos=todas.length;
    const totalPaginas=Math.max(1,Math.ceil(totalProdutos/porPagina));
    const ini=(pagina-1)*porPagina;
    const bloco=todas.slice(ini,ini+porPagina);
    const estoques={};
    if(bloco.length){
      const qs=bloco.map(p=>`idsProdutos[]=${p.produtoId}`).join("&");
      try{
        const r=await bling(`/estoques/saldos?${qs}`);
        (r?.data||[]).forEach(s=>{ estoques[s.produto?.id]=s.saldoVirtualTotal ?? s.saldoFisicoTotal ?? 0; });
      }catch(e){}
    }
    const itens=bloco.map(p=>({...p, estoqueAtual: estoques[p.produtoId] ?? null}));
    res.json({itens, pagina, porPagina, totalProdutos, totalPaginas});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// ============ ENTRADA DE ESTOQUE (notas fiscais e não fiscais) ============
// Dá entrada no estoque do Bling (operação "E" = soma ao saldo) e guarda um
// registro local (nosso, paralelo) com o histórico das entradas. Assim o estoque
// do Bling e o nosso ficam em sincronia, e cada nota sobe a quantidade.
const ENTRADAS_ESTOQUE_FILE = `${DATA_DIR}/entradas_estoque.json`;
function lerEntradasEstoque(){ return lerJSON(ENTRADAS_ESTOQUE_FILE,{entradas:[]}); }
function salvarEntradasEstoque(d){ salvarJSON(ENTRADAS_ESTOQUE_FILE,d); }

// lê o XML de uma NF-e e extrai fornecedor, número, chave e itens (código, GTIN, nome, qtd, custo)
function parseNfeXml(xml){
  const s=String(xml||"");
  const chave=(s.match(/Id="NFe(\d{44})"/)||[])[1]||"";
  const nNF=(s.match(/<nNF>(\d+)<\/nNF>/)||[])[1]||"";
  const emit=(s.match(/<emit>[\s\S]*?<xNome>([^<]+)<\/xNome>/)||[])[1]||"";
  const itens=[];
  const detRe=/<det[^>]*>([\s\S]*?)<\/det>/g; let m;
  while((m=detRe.exec(s))){
    const blk=m[1];
    const g=(re)=>{ const x=blk.match(re); return x?x[1].trim():""; };
    const cEAN=g(/<cEAN>([^<]*)<\/cEAN>/);
    itens.push({
      cProd:g(/<cProd>([^<]*)<\/cProd>/),
      gtin:(/^\d{8,14}$/.test(cEAN))?cEAN:"",
      xProd:g(/<xProd>([^<]*)<\/xProd>/),
      ncm:g(/<NCM>([^<]*)<\/NCM>/),
      quantidade:parseFloat(g(/<qCom>([^<]*)<\/qCom>/))||0,
      custo:parseFloat(g(/<vUnCom>([^<]*)<\/vUnCom>/))||0,
    });
  }
  return { chave, numeroNota:nNF, fornecedor:emit, itens };
}

// lê o XML e tenta casar cada item com um produto do Bling (por GTIN, senão por código)
app.post("/api/estoque/entrada/parse-xml",async(req,res)=>{
  try{
    const xml=req.body?.xml||"";
    if(!xml||String(xml).length<50) return res.status(400).json({erro:"envie o conteúdo do XML da NF-e"});
    const nf=parseNfeXml(xml);
    if(!nf.itens.length) return res.status(400).json({erro:"não encontrei itens nesse XML. Confira se é o XML da NF-e (não o DANFE em PDF)."});
    const db=lerEntradasEstoque();
    const jaLancada = nf.chave && (db.entradas||[]).some(e=>e.chaveNfe===nf.chave);
    const itens=[];
    for(const it of nf.itens){
      let prod=null;
      if(it.gtin){ try{ const r=await bling(`/produtos?gtin=${encodeURIComponent(it.gtin)}&limite=1`); prod=(r?.data||[])[0]||null; }catch(e){} }
      if(!prod && it.cProd){ try{ const r=await bling(`/produtos?codigo=${encodeURIComponent(it.cProd)}&limite=1`); prod=(r?.data||[])[0]||null; }catch(e){} }
      itens.push({ ...it, produtoId:prod?.id||null, produtoNome:prod?.nome||"", casado:!!prod });
      await sleep(120);
    }
    res.json({ ...nf, jaLancada, itens, casados:itens.filter(i=>i.casado).length, total:itens.length });
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// PUXA a nota de entrada que o Bling já importou, pela chave (44 dígitos do código da DANFE).
// Serve pro fluxo "bipar a chave -> traz os itens". NÃO mexe no estoque aqui.
app.get("/api/estoque/nota-por-chave/:chave",async(req,res)=>{
  try{
    const ch=String(req.params.chave).replace(/\D/g,"");
    if(ch.length!==44) return res.status(400).json({erro:"a chave precisa ter 44 dígitos"});
    let lista=[];
    try{ const r=await bling(`/notasfiscaisentrada?chaveAcesso=${ch}`); lista=r?.data||[]; }catch(e){}
    if(!lista.length) return res.json({encontrada:false, chave:ch});
    const nid=lista[0].id;
    let d=null; try{ d=await bling(`/notasfiscaisentrada/${nid}`).then(r=>r?.data); }catch(e){}
    const itens=((d&&d.itens)||[]).map(it=>({
      produtoId:it.produto?.id||null, nome:it.descricao||it.produto?.nome||"",
      quantidade:it.quantidade, custo:it.valor, casado:!!(it.produto?.id),
    }));
    res.json({ encontrada:true, chave:ch, notaId:nid, numero:d?.numero||lista[0].numero||"",
      fornecedor:d?.contato?.nome||lista[0].contato?.nome||"", itens, casados:itens.filter(i=>i.casado).length, total:itens.length });
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// dá a ENTRADA de fato: sobe o estoque no Bling e grava o registro local
app.post("/api/estoque/entrada",async(req,res)=>{
  try{
    const { tipo, fornecedor, numeroNota, chaveNfe, observacao, itens, funcionarioNome, semEstoque } = req.body||{};
    if(!Array.isArray(itens)||!itens.length) return res.status(400).json({erro:"envie os itens da entrada"});
    const db=lerEntradasEstoque();
    if(chaveNfe && (db.entradas||[]).some(e=>e.chaveNfe===chaveNfe)){
      return res.status(400).json({erro:"Essa NF-e já teve entrada lançada.", jaLancada:true});
    }
    const resultados=[];
    for(const it of itens){
      const pid=Number(it.produtoId); const qtd=Number(it.quantidade);
      if(!pid || !(qtd>0)){ resultados.push({produtoId:it.produtoId||null, nome:it.nome||it.produtoNome||"", ok:false, erro:"produto não casado ou quantidade inválida"}); continue; }
      // semEstoque = a nota já subiu o estoque no Bling (importação); aqui é só registro
      if(semEstoque){ resultados.push({produtoId:pid, nome:it.nome||it.produtoNome||"", quantidade:qtd, custo:it.custo||null, ok:true, soRegistro:true}); continue; }
      try{
        const corpo={ produto:{id:pid}, operacao:"E", quantidade:qtd,
          observacoes:`Entrada ${tipo==="fiscal"?("NF "+(numeroNota||"")):"manual"}${fornecedor?(" — "+fornecedor):""}${funcionarioNome?(" ("+funcionarioNome+")"):""}`.slice(0,190) };
        if(it.custo!=null && !isNaN(Number(it.custo)) && Number(it.custo)>0){ corpo.preco=Number(it.custo); corpo.custo=Number(it.custo); }
        await bling(`/estoques`,{method:"POST",body:JSON.stringify(corpo)});
        resultados.push({produtoId:pid, nome:it.nome||it.produtoNome||"", quantidade:qtd, custo:it.custo||null, ok:true});
        await sleep(150);
      }catch(e){ resultados.push({produtoId:pid, nome:it.nome||it.produtoNome||"", quantidade:qtd, ok:false, erro:e.message}); }
    }
    const okCount=resultados.filter(r=>r.ok).length;
    const registro={ id:"ent-"+Date.now(), em:Date.now(), tipo:tipo||"manual", semEstoque:!!semEstoque,
      fornecedor:fornecedor||"", numeroNota:numeroNota||"", chaveNfe:chaveNfe||"",
      observacao:observacao||"", por:funcionarioNome||"", itens:resultados,
      sucesso:okCount, falhas:resultados.length-okCount };
    db.entradas=[registro, ...(db.entradas||[])].slice(0,2000);
    salvarEntradasEstoque(db);
    res.json({ok:true, entradaId:registro.id, total:resultados.length, sucesso:okCount, falhas:resultados.length-okCount, resultados});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// histórico das entradas
app.get("/api/estoque/entradas",(req,res)=>{
  const db=lerEntradasEstoque();
  res.json({entradas:(db.entradas||[]).slice(0,100)});
});

// Ajusta (define o saldo absoluto) o estoque de um produto no Bling.
app.post("/api/estoque/ajustar",async(req,res)=>{
  try{
    const {produtoId,novoTotal,funcionarioNome}=req.body||{};
    if(!produtoId || novoTotal===undefined || novoTotal===null || isNaN(Number(novoTotal))){
      return res.status(400).json({erro:"informe produtoId e o novo total"});
    }
    if(Number(novoTotal)<0) return res.status(400).json({erro:"o estoque não pode ser negativo"});
    await bling(`/estoques`,{method:"POST",body:JSON.stringify({
      produto:{id:Number(produtoId)},
      operacao:"B",
      quantidade:Number(novoTotal),
      observacoes:`Ajuste de estoque via sistema${funcionarioNome?` — ${funcionarioNome}`:""}`,
    })});
    res.json({ok:true, produtoId:Number(produtoId), novoTotal:Number(novoTotal)});
  }catch(e){ res.status(e.status||500).json({erro:e.message,detalhe:e.body}); }
});

// Busca produto pra EDIÇÃO de pedido no caixa: retorna nome, preço de ATACADO
// (da tabela, quando houver) e o estoque atual — pra adicionar produto no pedido
// já com o preço e sabendo se tem estoque.
app.get("/api/estoque/buscar-produto",async(req,res)=>{
  try{
    const q=(req.query.q||"").toLowerCase().trim();
    if(!q) return res.json({data:[]});
    const est=await getEstoqueMap();
    // índice de preço de atacado por código E por nome do vínculo (nem todo
    // produto tem o mesmo código na tabela; buscar por nome pega mais casos)
    const tab=lerTabela(); const precoAtacPorCodigo={}, precoAtacPorNome={};
    (tab?.model||[]).forEach(c=>(c.itens||[]).forEach(it=>{
      if(!(it.preco>0)) return;
      (it.bling||[]).forEach(b=>{
        if(b.codigo) precoAtacPorCodigo[String(b.codigo)]=it.preco;
        if(b.nome) precoAtacPorNome[String(b.nome).toLowerCase().trim()]=it.preco;
      });
      if(it.nome) precoAtacPorNome[String(it.nome).toLowerCase().trim()]=it.preco;
    }));
    const achados=Object.values(est).filter(p=>p.nome&&p.nome.toLowerCase().includes(q)).slice(0,12);
    const idsBloco=achados.map(p=>p.id).filter(Boolean);
    const saldos={};
    if(idsBloco.length){
      for(let i=0;i<idsBloco.length;i+=40){
        const qs=idsBloco.slice(i,i+40).map(id=>`idsProdutos[]=${id}`).join("&");
        try{ const r=await bling(`/estoques/saldos?${qs}`); (r?.data||[]).forEach(s=>{ saldos[s.produto?.id]=s.saldoVirtualTotal ?? s.saldoFisicoTotal ?? 0; }); }catch(e){}
      }
    }
    const data=achados.map(p=>{
      // preço: 1º tabela de atacado (por código, depois por nome), senão o preço do próprio Bling
      const precoAtac = precoAtacPorCodigo[String(p.codigo)] ?? precoAtacPorNome[String(p.nome||"").toLowerCase().trim()];
      const preco = precoAtac!=null ? precoAtac : +(p.preco||0);
      return {
        id:p.id, codigo:p.codigo, nome:p.nome,
        preco,
        precoAtacado: precoAtac!=null,
        estoque: saldos[p.id] ?? null,
      };
    });
    res.json({data});
  }catch(e){ res.status(500).json({erro:e.message,data:[]}); }
});

// ==================== MOVIMENTAÇÃO DE PRODUTOS (retirados / faltaram na separação) ====================
// Consolida numa lista só os produtos que "saíram" de pedidos, de duas origens:
// 1) RETIRADOS: itens tirados de um pedido em aguardando separação (via edição no caixa);
// 2) FALTA NA SEPARAÇÃO: itens que faltaram na hora de separar e o pedido foi pra pendência.
// Serve pra ter visão do que está saindo dos pedidos e por quê.
app.get("/api/movimentacoes",(req,res)=>{
  try{
    const diasAtras=Number(req.query.dias||30);
    const desde=Date.now()-diasAtras*24*60*60*1000;
    const linhas=[];

    // 1) retirados na edição do caixa
    const movs=lerJSON(`${DATA_DIR}/movimentacoes_pedido.json`,{});
    Object.values(movs).forEach(m=>{
      if((m.em||0)<desde) return;
      (m.removidos||[]).forEach(r=>{
        linhas.push({
          tipo:"retirado",
          produtoId:r.produtoId, descricao:r.descricao, quantidade:r.quantidade,
          pedidoNumero:m.numero, pedidoId:m.pedidoId, cliente:m.cliente||"",
          por:m.por||"", em:m.em,
        });
      });
    });

    // 2) faltas na separação (foram pra pendência)
    const pend=lerJSON(PEND_FILE,{});
    Object.values(pend).forEach(p=>{
      if((p.em||0)<desde) return;
      (p.faltas||[]).forEach(f=>{
        linhas.push({
          tipo:"falta_separacao",
          produtoId:f.produtoId||f.id||null, descricao:f.descricao||f.nome||"", quantidade:f.quantidade||f.qtd||null,
          pedidoNumero:p.numero, pedidoId:p.pedidoId, cliente:p.cliente||"",
          statusPendencia:p.status||"pendente", em:p.em,
        });
      });
    });

    linhas.sort((a,b)=>(b.em||0)-(a.em||0));
    res.json({data:linhas, dias:diasAtras});
  }catch(e){ res.status(500).json({erro:e.message}); }
});


// Ajusta os itens de um pedido que ainda está em AGUARDANDO SEPARAÇÃO — pra
// corrigir algo identificado quando o pedido chega no caixa. A alteração é feita
// NO BLING (PUT do pedido); só confirma se o Bling aceitar (nunca fica diferente
// entre os dois). Recebe { itens: [...] } = a lista FINAL de itens do pedido.
app.post("/api/pedidos/:id/editar-itens",async(req,res)=>{
  try{
    const id=String(req.params.id);
    const {itens,funcionarioNome}=req.body||{};
    if(!Array.isArray(itens)||!itens.length) return res.status(400).json({erro:"O pedido precisa ter ao menos 1 item."});
    for(const it of itens){
      if(!it.produtoId) return res.status(400).json({erro:"Todos os itens precisam ter produto vinculado no Bling."});
      if(!(Number(it.quantidade)>0)) return res.status(400).json({erro:"Quantidade inválida em algum item."});
    }
    let ped;
    try{ ped=await bling(`/pedidos/vendas/${id}`).then(r=>r?.data); }
    catch(e){ return res.status(502).json({erro:"Não foi possível ler o pedido no Bling: "+(e.message||"erro")+". Nada foi alterado."}); }
    if(!ped) return res.status(404).json({erro:"pedido não encontrado no Bling"});
    if(Number(ped.situacao?.id)!==SIT.AGUARDANDO){
      return res.status(400).json({erro:"Este pedido já saiu de 'Aguardando separação'. Não é mais possível editar os itens por aqui."});
    }
    const itensAntes=(ped.itens||[]).map(i=>({produtoId:i.produto?.id,descricao:i.descricao||i.produto?.nome||"",quantidade:i.quantidade}));
    const idsDepois=new Set(itens.map(i=>Number(i.produtoId)));
    const removidos=itensAntes.filter(a=>!idsDepois.has(Number(a.produtoId)));

    const payload={
      data:ped.data,
      contato:{id:ped.contato?.id},
      itens:itens.map(i=>({produto:{id:Number(i.produtoId)},quantidade:Number(i.quantidade),valor:Number(i.valor)})),
    };
    if(ped.observacoes) payload.observacoes=ped.observacoes;
    if(ped.transporte) payload.transporte=ped.transporte;
    if(ped.vendedor?.id) payload.vendedor={id:ped.vendedor.id};
    if(ped.loja?.id) payload.loja={id:ped.loja.id};

    // aplica no Bling PRIMEIRO — se falhar, aborta sem mexer em nada aqui
    try{
      await bling(`/pedidos/vendas/${id}`,{method:"PUT",body:JSON.stringify(payload)});
    }catch(e){
      return res.status(502).json({erro:"O Bling recusou a alteração: "+(e.message||"erro")+". Nada foi alterado — verifique e tente de novo.",detalhe:e.body});
    }

    let pedNovo;
    try{ pedNovo=await bling(`/pedidos/vendas/${id}`).then(r=>r?.data); }catch(e){}
    const novoTotal=+(pedNovo?.total||0);

    // avisa se algum produto REMOVIDO está sem estoque no Bling
    const avisosEstoque=[];
    if(removidos.length){
      const ids=removidos.map(r=>Number(r.produtoId)).filter(Boolean);
      const saldos={};
      if(ids.length){
        const qs=ids.map(x=>`idsProdutos[]=${x}`).join("&");
        try{ const r=await bling(`/estoques/saldos?${qs}`); (r?.data||[]).forEach(s=>{ saldos[s.produto?.id]=s.saldoVirtualTotal ?? s.saldoFisicoTotal ?? 0; }); }catch(e){}
      }
      removidos.forEach(rm=>{
        const saldo=saldos[Number(rm.produtoId)];
        if(saldo!==undefined && saldo<=0) avisosEstoque.push(`${rm.descricao} está SEM estoque no Bling.`);
      });
    }

    // registra na lista de movimentações (usada na Parte 3 - itens retirados)
    try{
      const movs=lerJSON(`${DATA_DIR}/movimentacoes_pedido.json`,{});
      movs[`${id}_${Date.now()}`]={pedidoId:id,numero:ped.numero,cliente:ped.contato?.nome||"",em:Date.now(),
        por:funcionarioNome||"",origem:"edicao_caixa",
        removidos:removidos.map(r=>({produtoId:r.produtoId,descricao:r.descricao,quantidade:r.quantidade}))};
      salvarJSON(`${DATA_DIR}/movimentacoes_pedido.json`,movs);
    }catch(e){}

    res.json({ok:true, novoTotal, avisosEstoque, removidos:removidos.map(r=>r.descricao)});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// CANCELA um pedido a partir do caixa/operacional (pelo ID do Bling). Ação
// atômica: cancela no Bling PRIMEIRO; só considera cancelado se o Bling confirmar.
// Trava de status: só permite cancelar se o pedido ainda estiver em AGUARDANDO
// (não deixa cancelar algo que já entrou no fluxo). Também tira o pedido de
// qualquer rota onde estava agendado (não deixa fantasma). Retorna os dados do
// cliente (nome/telefone/itens) pra montar a mensagem de cancelamento no WhatsApp.
app.post("/api/pedidos/:id/cancelar",async(req,res)=>{
  try{
    const id=String(req.params.id);
    // lê o pedido pra checar a situação atual e pegar os dados do cliente
    let ped;
    try{ ped=await bling(`/pedidos/vendas/${id}`).then(r=>r?.data); }
    catch(e){ return res.status(502).json({erro:"Não foi possível ler o pedido no Bling: "+(e.message||"erro")+". Nada foi alterado."}); }
    if(!ped) return res.status(404).json({erro:"pedido não encontrado no Bling"});
    const sitAtual=Number(ped.situacao?.id||0);
    const SIT_CANCELADO=Number(process.env.SIT_CANCELADO||12);
    if(sitAtual===SIT_CANCELADO) return res.json({ok:true, jaEstava:true});
    // trava: só cancela enquanto está em AGUARDANDO
    if(sitAtual!==SIT.AGUARDANDO){
      return res.status(400).json({erro:"Este pedido já saiu de 'Aguardando separação' e entrou no fluxo. Não é possível cancelar por aqui — ajuste direto no Bling se precisar."});
    }
    // cancela no Bling PRIMEIRO — se falhar, aborta sem mexer em nada
    try{
      await bling(`/pedidos/vendas/${id}/situacoes/${SIT_CANCELADO}`,{method:"PATCH"});
    }catch(e){
      return res.status(502).json({erro:"Não foi possível cancelar o pedido no Bling: "+(e.message||"erro de conexão")+". Nada foi alterado — tente de novo."});
    }
    // confirmou no Bling: tira das rotas (não deixa fantasma) e registra
    let tiradoDaRota=false;
    try{ const r=removerPedidoDeTodasRotas(Number(id)); tiradoDaRota=r.removido; }catch(e){}
    // devolve os dados do cliente pra montar a mensagem de WhatsApp no frontend
    const itens=(ped.itens||[]).map(i=>({descricao:i.descricao||i.produto?.nome||"Produto",quantidade:i.quantidade}));
    res.json({ok:true, tiradoDaRota, cliente:{
      nome:ped.contato?.nome||"", id:ped.contato?.id||null,
      documento:ped.contato?.numeroDocumento||ped.contato?.cpfCnpj||"",
      observacoes:ped.observacoes||"",
    }, numero:ped.numero||id, itens, total:+(ped.total||0)});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});


// EDITA os itens de um pedido a partir do caixa (adicionar/remover/mudar qtd).
// Ação atômica: aplica no Bling; só se o Bling confirmar considera OK. Só
// permite enquanto o pedido está em AGUARDANDO SEPARAÇÃO (antes de seguir pro
// fluxo). Ao final, avisa quais itens da lista final estão sem estoque.
app.post("/api/caixa/pedido/:id/editar-itens",async(req,res)=>{
  try{
    const id=req.params.id;
    const itens=req.body?.itens;
    if(!Array.isArray(itens)||!itens.length) return res.status(400).json({erro:"o pedido precisa ter ao menos 1 item"});
    // confere a situação atual: só edita se ainda está em Aguardando separação
    const atualJson=await bling(`/pedidos/vendas/${id}`).catch(()=>null);
    if(!atualJson?.data) return res.status(404).json({erro:"pedido não encontrado no Bling"});
    const sit=Number(atualJson.data.situacao?.id||0);
    if(sit!==SIT.AGUARDANDO){
      return res.status(400).json({erro:"Este pedido já saiu de 'Aguardando separação' e entrou no fluxo — não pode mais ser editado por aqui."});
    }
    // aplica no Bling (função já existente, trata parcelas/unlock). Se falhar, sobe o erro e nada muda.
    const r=await atualizarItensBling(id, itens.map(i=>({produtoId:i.produtoId,quantidade:i.quantidade,valor:i.valor})));
    if(!r?.ok) return res.status(502).json({erro:"Não foi possível salvar as alterações no Bling: "+(r?.erro||"erro desconhecido")+". Nada foi alterado."});
    // confere estoque dos itens FINAIS (avisa os que ficaram sem saldo suficiente)
    const idsFinais=itens.map(i=>Number(i.produtoId)).filter(Boolean);
    const saldos={};
    if(idsFinais.length){
      for(let i=0;i<idsFinais.length;i+=40){
        const qs=idsFinais.slice(i,i+40).map(x=>`idsProdutos[]=${x}`).join("&");
        try{ const rr=await bling(`/estoques/saldos?${qs}`); (rr?.data||[]).forEach(s=>{ saldos[s.produto?.id]=s.saldoVirtualTotal ?? s.saldoFisicoTotal ?? 0; }); }catch(e){}
      }
    }
    const semEstoque=itens
      .map(i=>({...i, saldo: saldos[Number(i.produtoId)] ?? null}))
      .filter(i=>i.saldo!=null && i.saldo < Number(i.quantidade))
      .map(i=>({nome:i.nome||("produto "+i.produtoId), pedido:Number(i.quantidade), emEstoque:i.saldo}));
    res.json({ok:true, semEstoque});
  }catch(e){ res.status(e.status||500).json({erro:e.message,detalhe:e.body}); }
});



app.post("/api/listas-extras/:listaId/importar",(req,res)=>{
  const {linhas}=req.body||{};
  if(!Array.isArray(linhas)) return res.status(400).json({erro:"informe { linhas: [{codigo,preco,nome}] }"});
  const d=lerListasExtras();
  const lista=(d.listas||[]).find(l=>l.id===req.params.listaId);
  if(!lista) return res.status(404).json({erro:"lista não encontrada"});
  const idx=indexarVinculosTabela();
  const casados=[], naoEncontrados=[];
  linhas.forEach(l=>{
    const codigo=String(l.codigo||"").trim();
    const preco=+Number(l.preco||0);
    const nome=String(l.nome||"").trim();
    if(!codigo||!(preco>0)) return;
    const match=idx[codigo];
    if(match){ lista.precos[match.itemId]=preco; casados.push({codigo,preco,itemNome:match.itemNome}); }
    else naoEncontrados.push({codigo,preco,nome});
  });
  salvarListasExtras(d);
  res.json({ok:true,qtdCasados:casados.length,qtdNaoEncontrados:naoEncontrados.length,casados,naoEncontrados});
});

app.post("/api/listas-extras/:listaId/associar-avulso",(req,res)=>{
  const {produtoId,nome,preco,codigo}=req.body||{};
  if(!produtoId||!nome||!(preco>0)) return res.status(400).json({erro:"informe produtoId, nome e preco"});
  const d=lerListasExtras();
  const lista=(d.listas||[]).find(l=>l.id===req.params.listaId);
  if(!lista) return res.status(404).json({erro:"lista não encontrada"});
  const chave="avulso_"+produtoId;
  lista.precos[chave]={preco:+Number(preco),nome,origem:"avulso",produtoId,codigoImportado:codigo||""};
  salvarListasExtras(d);
  res.json({ok:true,itemId:chave});
});

app.put("/api/listas-extras/:listaId/:itemId",(req,res)=>{
  const {preco}=req.body||{};
  const d=lerListasExtras();
  const lista=(d.listas||[]).find(l=>l.id===req.params.listaId);
  if(!lista) return res.status(404).json({erro:"lista não encontrada"});
  if(preco==null||preco==="") delete lista.precos[req.params.itemId];
  else if(lista.precos[req.params.itemId]&&typeof lista.precos[req.params.itemId]==="object") lista.precos[req.params.itemId].preco=+Number(preco);
  else lista.precos[req.params.itemId]=+Number(preco);
  salvarListasExtras(d);
  res.json({ok:true});
});

// estoque ao vivo de um produto específico (usado ao adicionar item na venda atacado)
// diagnóstico: mostra os campos de imagem de um produto (pra descobrir onde a foto fica)
app.get("/api/debug-imagem/:id",async(req,res)=>{
  try{
    const r=await bling(`/produtos/${req.params.id}`);
    const d=r?.data||{};
    res.json({
      imagemURL:d.imagemURL||null,
      imagens:d.imagens||null,
      midia:d.midia||null,
      chaves:Object.keys(d),
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// diagnóstico por nome: busca o produto pelo nome e mostra os campos de imagem
app.get("/api/debug-imagem-nome",async(req,res)=>{
  try{
    const nome=(req.query.nome||"").trim();
    if(!nome) return res.json({erro:"informe ?nome=..."});
    // acha o produto no índice local
    const indice=lerJSON(GTIN_INDEX_FILE,{});
    const achado=Object.values(indice).find(p=>(p.nome||"").toLowerCase().includes(nome.toLowerCase()));
    if(!achado) return res.json({erro:"produto não encontrado no índice com esse nome"});
    const r=await bling(`/produtos/${achado.produtoId}`);
    const d=r?.data||{};
    res.json({
      produtoId:achado.produtoId, nome:d.nome,
      imagemURL:d.imagemURL||null,
      imagens:d.imagens||null,
      midia:d.midia||null,
      chaves:Object.keys(d),
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// extrai a URL da imagem de um produto do Bling v3 (detalhe) — o caminho é
// midia.imagens.externas[].link (ou internas). Reutilizável.
function extrairImagemProduto(d){
  if(!d) return "";
  const m=d.midia?.imagens;
  if(m){
    const ext=(m.externas||[]).find(i=>i.link&&i.link.trim());
    if(ext) return ext.link;
    const intn=(m.internas||[]).find(i=>i.link&&i.link.trim());
    if(intn) return intn.link;
    const url=(m.imagensURL||[]).find(u=>u&&String(u).trim());
    if(url) return url;
  }
  // formatos alternativos
  if(Array.isArray(d.imagens)){ const img=d.imagens.find(i=>(i.link||i.url||"").trim()); if(img) return img.link||img.url; }
  return d.imagemURL||"";
}

app.get("/api/produto-estoque/:id",async(req,res)=>{
  try{
    const r=await bling(`/produtos/${req.params.id}`);
    const d=r?.data||{};
    const est=d?.estoque?.saldoVirtualTotal ?? d?.estoque?.saldoFisicoTotal ?? null;
    res.json({estoque:est,imagem:extrairImagemProduto(d)});
  }catch(e){ res.json({estoque:null,imagem:"",erro:e.message}); }
});

// estoque ao vivo do produto (o indice de preco pode estar desatualizado quanto a quantidade)
// busca do "Consumidor Final" pelo codigo 2 no Bling, com cache curto (pra nao bater na API toda hora)
let _consumidorFinalCache=null, _consumidorFinalEm=0;
const CONSUMIDOR_FINAL_ID=17313605063; // ID confirmado direto do link do contato no Bling
// vendedores do VAREJO (frente de caixa) — pedidos deles não entram na análise de atacado
const VENDEDORES_VAREJO=[15596682312,15596893031]; // Claudinéia e Andreia
app.get("/api/pdv/consumidor-final",async(req,res)=>{
  try{
    if(_consumidorFinalCache&&Date.now()-_consumidorFinalEm<10*60*1000) return res.json({data:_consumidorFinalCache});
    const r=await bling(`/contatos/${CONSUMIDOR_FINAL_ID}`);
    const c=r?.data||null;
    if(c){ _consumidorFinalCache={id:c.id,nome:c.nome}; _consumidorFinalEm=Date.now(); }
    res.json({data:_consumidorFinalCache});
  }catch(e){ res.json({data:{id:CONSUMIDOR_FINAL_ID,nome:"Consumidor Final"},erro:e.message}); }
});

// busca de vendedores do Bling (pra vincular um vendedor a um funcionário do sistema)
app.get("/api/vendedores/busca",requireAdmin,async(req,res)=>{
  const termo=String(req.query.termo||"").trim();
  try{
    const r=await bling(`/vendedores${termo?`?pesquisa=${encodeURIComponent(termo)}`:""}`);
    const lista=(r?.data||[]).map(v=>({id:v.id,nome:v.nome||v.contato?.nome||`Vendedor ${v.id}`,situacao:v.situacao}));
    res.json({data:lista});
  }catch(e){ res.status(e.status||500).json({erro:e.message,detalhe:e.body}); }
});

// DIAGNÓSTICO: mostra os vendedores do Bling (com situação Ativo/Inativo) e como
// cada funcionário do sistema está vinculado. Uso: /api/diag/vendedores
app.get("/api/diag/vendedores",async(req,res)=>{
  const out={vendedorPadraoEnv:process.env.BLING_VENDEDOR_ID||null, vendedoresBling:[], funcionarios:[]};
  try{
    // lista os vendedores (pode ter mais de uma página)
    for(let pag=1;pag<=5;pag++){
      const r=await bling(`/vendedores?pagina=${pag}&limite=100`).catch(()=>null);
      const arr=r?.data||[];
      arr.forEach(v=>out.vendedoresBling.push({
        id:v.id,
        nome:v.contato?.nome||v.nome||`Vendedor ${v.id}`,
        situacao:v.situacao, // "A" ativo, "I" inativo (no Bling)
        ativo: v.situacao==="A" || v.situacao===1 || v.situacao===true,
      }));
      if(arr.length<100) break;
      await sleep(250);
    }
  }catch(e){ out.erroVendedores=e.message; }
  try{
    const funcs=lerJSON(FUNC_FILE,{});
    out.funcionarios=Object.values(funcs).map(f=>({
      id:f.id, nome:f.nome, login:f.login||"",
      vendedorBlingId:f.vendedorBlingId||null, vendedorBlingNome:f.vendedorBlingNome||"",
    }));
    // marca, pra cada funcionário, se o vendedor vinculado está ativo
    const porId={}; out.vendedoresBling.forEach(v=>porId[String(v.id)]=v);
    out.funcionarios.forEach(f=>{
      if(f.vendedorBlingId){ const v=porId[String(f.vendedorBlingId)]; f.vendedorAtivo = v?v.ativo:null; f.vendedorSituacao=v?v.situacao:"não encontrado"; }
    });
  }catch(e){ out.erroFuncionarios=e.message; }
  res.json(out);
});

// busca de clientes (nome, cpf/cnpj, telefone) - igual a busca de cliente do Frente de Caixa do Bling
app.get("/api/pdv/clientes",async(req,res)=>{
  const termo=String(req.query.termo||"").trim();
  if(termo.length<2) return res.json({data:[]});
  try{
    const r=await bling(`/contatos?pesquisa=${encodeURIComponent(termo)}&limite=20`);
    const lista=(r?.data||[]).map(c=>({id:c.id,nome:c.nome,numeroDocumento:c.numeroDocumento||"",telefone:c.telefone||c.celular||""}));
    res.json({data:lista});
  }catch(e){ res.status(e.status||500).json({erro:e.message}); }
});

// busca um contato pelo CPF/CNPJ; se não existir, cria um novo minimo (so pra colocar o
// documento na nota, sem precisar de cadastro completo)
app.post("/api/pdv/cliente-por-cpf",async(req,res)=>{
  const doc=soDigitos(req.body?.documento);
  const nome=String(req.body?.nome||"").trim();
  if(!doc) return res.status(400).json({erro:"informe o CPF/CNPJ"});
  try{
    const busca=await bling(`/contatos?pesquisa=${encodeURIComponent(doc)}`);
    const achado=(busca?.data||[]).find(c=>soDigitos(c.numeroDocumento)===doc);
    if(achado) return res.json({id:achado.id,nome:achado.nome,criado:false});

    const tipo=doc.length===14?"J":"F";
    const criado=await bling(`/contatos`,{method:"POST",body:JSON.stringify({
      nome:nome||"Consumidor",
      tipo,
      numeroDocumento:doc,
      situacao:"A",
    })});
    res.json({id:criado?.data?.id,nome:nome||"Consumidor",criado:true});
  }catch(e){ res.status(e.status||500).json({erro:e.message,detalhe:e.body}); }
});

app.get("/api/pdv/estoque/:produtoId",async(req,res)=>{
  try{
    const r=await bling(`/produtos/${req.params.produtoId}`);
    const p=r?.data||{};
    const estoque=p?.estoque?.saldoVirtualTotal??p?.estoque?.saldoFisicoTotal??p?.estoqueAtual??0;
    res.json({estoque:Number(estoque)||0});
  }catch(e){ res.status(e.status||500).json({erro:e.message}); }
});

app.get("/api/pdv/info-fardo/:codigo",(req,res)=>{
  const idx=indexarVinculosTabela();
  const match=idx[String(req.params.codigo).trim()];
  if(!match) return res.json({temFardo:false});
  const fardo=lerListaFardo();
  const entradaFardo=fardo[match.itemId];
  if(!entradaFardo||!(entradaFardo.preco>0)||!(match.caixaQtd>0)) return res.json({temFardo:false});
  res.json({temFardo:true,precoFardo:entradaFardo.preco,caixaQtd:match.caixaQtd});
});

app.get("/api/lista-fardo",(req,res)=>{
  const fardo=lerListaFardo();
  const idx=indexarVinculosTabela();
  // agrupa por item (um item pode ter vários códigos/sabores vinculados)
  const porItem={};
  Object.values(idx).forEach(v=>{
    if(!porItem[v.itemId]) porItem[v.itemId]={itemId:v.itemId,categoriaNome:v.categoriaNome,itemNome:v.itemNome,precoAtacado:v.precoAtacado,precoFardo:fardo[v.itemId]?.preco??null};
  });
  // inclui também os itens "avulsos" (associados manualmente, sem vínculo na tabela atacado)
  Object.entries(fardo).forEach(([itemId,v])=>{
    if(v.origem==="avulso"){
      porItem[itemId]={itemId,categoriaNome:v.categoriaNome||"(avulso)",itemNome:v.nome,precoAtacado:null,precoFardo:v.preco};
    }
  });
  res.json({data:Object.values(porItem).sort((a,b)=>a.itemNome.localeCompare(b.itemNome))});
});

// importa a lista vinda do Bling (código + preço) — casa pelo código já vinculado na tabela atacado
app.post("/api/lista-fardo/importar",(req,res)=>{
  const {linhas}=req.body||{};
  if(!Array.isArray(linhas)) return res.status(400).json({erro:"informe { linhas: [{codigo,preco,nome}] }"});
  const idx=indexarVinculosTabela();
  const fardo=lerListaFardo();
  const casados=[], naoEncontrados=[];
  linhas.forEach(l=>{
    const codigo=String(l.codigo||"").trim();
    const preco=+Number(l.preco||0);
    const nome=String(l.nome||"").trim();
    if(!codigo||!(preco>0)) return;
    const match=idx[codigo];
    if(match){
      fardo[match.itemId]={preco,nome:match.itemNome,categoriaNome:match.categoriaNome,origem:"tabela"};
      casados.push({codigo,preco,itemNome:match.itemNome,categoriaNome:match.categoriaNome});
    } else {
      naoEncontrados.push({codigo,preco,nome});
    }
  });
  salvarListaFardo(fardo);
  res.json({ok:true,qtdCasados:casados.length,qtdNaoEncontrados:naoEncontrados.length,casados,naoEncontrados});
});

// associa manualmente um código que não tinha vínculo na tabela atacado, a um produto do Bling escolhido na busca
app.post("/api/lista-fardo/associar-avulso",async(req,res)=>{
  const {produtoId,nome,preco,codigo}=req.body||{};
  if(!produtoId||!nome) return res.status(400).json({erro:"informe produtoId e nome"});
  const fardo=lerListaFardo();
  const chave="avulso_"+produtoId;
  fardo[chave]={preco:(preco>0?+Number(preco):null),nome,categoriaNome:"(avulso)",origem:"avulso",produtoId,codigoImportado:codigo||""};
  salvarListaFardo(fardo);
  res.json({ok:true,itemId:chave});
});

// edita/remove manualmente o preço de fardo de um item específico
app.put("/api/lista-fardo/:itemId",(req,res)=>{
  const {preco}=req.body||{};
  const fardo=lerListaFardo();
  const itemId=req.params.itemId;
  if(preco==null||preco===""){ delete fardo[itemId]; }
  else if(fardo[itemId]){ fardo[itemId].preco=+Number(preco); }
  else {
    // item ainda não tinha preço de fardo salvo — busca nome/categoria pra criar o registro completo
    const idx=indexarVinculosTabela();
    const match=Object.values(idx).find(v=>v.itemId===itemId);
    fardo[itemId]={preco:+Number(preco),nome:match?.itemNome||"",categoriaNome:match?.categoriaNome||"",origem:"tabela"};
  }
  salvarListaFardo(fardo);
  res.json({ok:true});
});

// etiqueta de preço: pra cada item pedido, traz Atacado + Fardo + Varejo (preço ao vivo do Bling)
app.get("/api/etiquetas",async(req,res)=>{
  const ids=String(req.query.itens||"").split(",").map(s=>s.trim()).filter(Boolean);
  if(!ids.length) return res.status(400).json({erro:"informe ?itens=id1,id2,..."});
  const tab=lerTabela();
  const fardo=lerListaFardo();
  const itensPorId={};
  (tab?.model||[]).forEach(cat=>(cat.itens||[]).forEach(it=>{ itensPorId[it.id]={...it,categoriaNome:cat.t||""}; }));

  const resultado=[];
  for(const id of ids){
    const avulso=fardo[id]?.origem==="avulso"?fardo[id]:null;
    let it=itensPorId[id];

    // se é avulso (buscado direto no Bling), verifica se esse mesmo produto do Bling
    // já está cadastrado na Tabela Atacado — se estiver, usa os preços de lá
    // (atacado/fardo), em vez de mostrar só o varejo
    let itVinculado=null;
    if(avulso && avulso.produtoId){
      itVinculado=(tab?.model||[]).flatMap(cat=>(cat.itens||[]).map(x=>({...x,categoriaNome:cat.t||""})))
        .find(x=>(x.bling||[]).some(b=>String(b.id)===String(avulso.produtoId)));
    }

    if(!it&&!avulso){ resultado.push({itemId:id,erro:"item não encontrado"}); continue; }

    let precoVarejo=null;
    const produtoIdParaBusca=avulso?avulso.produtoId:(it.bling||[])[0]?.id;
    if(produtoIdParaBusca){
      try{ const r=await bling(`/produtos/${produtoIdParaBusca}`); precoVarejo=+(r?.data?.preco||0); }catch(e){}
    }

    // fonte dos preços de atacado/fardo: o próprio item da tabela, ou o item vinculado
    // encontrado pelo produtoId (quando o avulso já existe na tabela)
    const fonteAtacado = it || itVinculado;
    // preço de fardo: procura pela chave normal (id) e também pela chave do item vinculado
    const precoFardo = (fardo[id]?.preco ?? (itVinculado ? fardo[itVinculado.id]?.preco : null)) ?? null;

    resultado.push({
      itemId:id,
      nome: (fonteAtacado?fonteAtacado.nome:null) || (avulso?avulso.nome:null) || (it?it.nome:""),
      categoriaNome: fonteAtacado?fonteAtacado.categoriaNome:(avulso?"(avulso)":it.categoriaNome),
      precoAtacado: fonteAtacado?(fonteAtacado.preco??null):null,
      precoFardo,
      caixaQtd: fonteAtacado?(fonteAtacado.caixa||null):null,
      precoVarejo,
    });
  }
  res.json({data:resultado});
});

// Autorização especial pra remover produto/aplicar desconto/ajustar estoque na Frente de
// Caixa — exige ID (dia do mês + código do funcionário) e senha (PIN do funcionário + dia
// do mês). Só libera pra quem é admin, gerente ou lider_caixa.
const GRUPOS_AUTORIZAM_PDV=["admin","gerente","lider_caixa"];

// ---- Autorização por QR code (muda por dia) ----
// O QR de cada funcionário autorizado codifica um token que muda diariamente.
// Formato: B13A-<funcId>-<AAAA-MM-DD>-<assinatura>. A assinatura é um hash do
// funcId+dia+segredo, então o backend valida sem guardar nada e o código de
// ontem não vale hoje. Só funcionários de grupo autorizado (admin/gerente/
// líder de caixa) geram um QR válido.
const QR_AUTH_SECRET=process.env.QR_AUTH_SECRET||process.env.SALT||"b13-qr-secret";
function _diaBR(d=new Date()){ return new Date(d.getTime()-3*60*60*1000).toISOString().slice(0,10); }
function assinaturaQr(funcId,dia){
  return crypto.createHash("sha256").update(`${funcId}|${dia}|${QR_AUTH_SECRET}`).digest("hex").slice(0,16).toUpperCase();
}
function gerarTokenQr(funcId,dia=_diaBR()){
  return `B13A-${funcId}-${dia}-${assinaturaQr(funcId,dia)}`;
}
// valida um token de QR lido no caixa. Retorna {funcionario} se ok, {erro} se não.
function validarTokenQr(token){
  if(!token||typeof token!=="string") return {erro:"QR inválido"};
  const m=token.trim().match(/^B13A-(.+?)-(\d{4}-\d{2}-\d{2})-([A-F0-9]{16})$/i);
  if(!m) return {erro:"QR não reconhecido"};
  const [,funcId,dia,assin]=m;
  const hoje=_diaBR();
  if(dia!==hoje) return {erro:"QR expirado — gere o de hoje no perfil"};
  if(assinaturaQr(funcId,dia)!==assin.toUpperCase()) return {erro:"QR inválido"};
  const funcs=lerJSON(FUNC_FILE,{});
  const f=funcs[funcId];
  if(!f||!f.ativo) return {erro:"funcionário não encontrado ou inativo"};
  const autoriza=GRUPOS_AUTORIZAM_PDV.includes(f.nivel)||(f.permissoes||[]).some(p=>GRUPOS_AUTORIZAM_PDV.includes(p));
  if(!autoriza) return {erro:"esse funcionário não pode autorizar"};
  return {funcionario:f};
}
// grupos que autorizam ações no CAIXA ATACADO (mudar preço): gerente, financeiro e admin
const GRUPOS_AUTORIZAM_ATACADO=["admin","gerente","financeiro","financeiro_atacado"];
// valida um QR pro caixa atacado — mesmo token do dia, mas exige grupo do atacado
function validarTokenQrAtacado(token){
  if(!token||typeof token!=="string") return {erro:"QR inválido"};
  const m=token.trim().match(/^B13A-(.+?)-(\d{4}-\d{2}-\d{2})-([A-F0-9]{16})$/i);
  if(!m) return {erro:"QR não reconhecido"};
  const [,funcId,dia,assin]=m;
  if(dia!==_diaBR()) return {erro:"QR expirado — gere o de hoje no perfil"};
  if(assinaturaQr(funcId,dia)!==assin.toUpperCase()) return {erro:"QR inválido"};
  const funcs=lerJSON(FUNC_FILE,{});
  const f=funcs[funcId];
  if(!f||!f.ativo) return {erro:"funcionário não encontrado ou inativo"};
  const autoriza=GRUPOS_AUTORIZAM_ATACADO.includes(f.nivel)||(f.permissoes||[]).some(p=>GRUPOS_AUTORIZAM_ATACADO.includes(p));
  if(!autoriza) return {erro:"Só gerente, financeiro ou admin autorizam no caixa atacado"};
  return {funcionario:f};
}

function validarAutorizacaoPdv(idDigitado,senhaDigitada){
  if(!idDigitado||!senhaDigitada) return {erro:"Informe o ID e a senha"};
  const dia=String(new Date().getDate()).padStart(2,"0");
  if(!String(idDigitado).startsWith(dia)) return {erro:"ID ou senha incorretos"};
  const codigo=String(idDigitado).slice(dia.length).toUpperCase();
  const funcs=lerJSON(FUNC_FILE,{});
  const f=Object.values(funcs).find(x=>x.ativo&&x.codigoConfirmacao===codigo&&
    (GRUPOS_AUTORIZAM_PDV.includes(x.nivel)||(x.permissoes||[]).some(p=>GRUPOS_AUTORIZAM_PDV.includes(p))));
  if(!f) return {erro:"ID ou senha incorretos"};
  const senhaEsperada=(f.pinConfirmacao||"")+dia;
  if(senhaDigitada!==senhaEsperada) return {erro:"ID ou senha incorretos"};
  return {funcionario:f};
}

app.post("/api/pdv/autorizar",(req,res)=>{
  const {tokenQr,idDigitado,senhaDigitada}=req.body||{};
  // novo fluxo: autorização por QR code (muda por dia)
  if(tokenQr){
    const r=validarTokenQr(tokenQr);
    if(r.erro) return res.status(401).json({erro:r.erro});
    return res.json({ok:true,autorizadoPor:r.funcionario.nome,via:"qr"});
  }
  // fluxo antigo (ID+senha) — mantido como fallback interno, mas o caixa usa QR
  const r=validarAutorizacaoPdv(idDigitado,senhaDigitada);
  if(r.erro) return res.status(401).json({erro:r.erro});
  res.json({ok:true,autorizadoPor:r.funcionario.nome});
});

// autorização por QR pro CAIXA ATACADO (mudar preço) — aceita gerente/financeiro/admin
app.post("/api/caixa-atacado/autorizar",(req,res)=>{
  const {tokenQr}=req.body||{};
  const r=validarTokenQrAtacado(tokenQr);
  if(r.erro) return res.status(401).json({erro:r.erro});
  res.json({ok:true,autorizadoPor:r.funcionario.nome,via:"qr"});
});

// EDITAR PAGAMENTO de um pedido JÁ FINALIZADO (pago no caixa) — só com autorização
// de gerente/financeiro/admin (QR). Substitui as formas de pagamento no Bling,
// atualiza o registro local (statusPagamento) e marca o movimento como ALTERADO no
// histórico do caixa (vira vermelho, com o que mudou e quem autorizou).
app.post("/api/caixa-atacado/editar-pagamento",async(req,res)=>{
  try{
    const {pedidoId,tokenQr,pagamentos,funcionarioId,numero}=req.body||{};
    if(!pedidoId) return res.status(400).json({erro:"pedidoId obrigatório"});
    const auth=validarTokenQrAtacado(tokenQr);
    if(auth.erro) return res.status(401).json({erro:auth.erro});
    const linhas=(Array.isArray(pagamentos)?pagamentos:[]).filter(p=>p&&p.formaId&&Number(p.valor)>0);
    if(!linhas.length) return res.status(400).json({erro:"informe ao menos uma forma de pagamento"});
    const fmt=(v)=>Number(v||0).toFixed(2);

    // pedido atual no Bling (pra total e pra base do "antes")
    const ped=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data).catch(()=>null);
    if(!ped) return res.status(404).json({erro:"pedido não encontrado no Bling"});
    if(Number(ped.situacao?.id||0)===SIT.CANCELADO) return res.status(400).json({erro:"Este pedido está CANCELADO no Bling."});
    const totalPedido=Number(ped.total||0);
    // itens que a tela mandou (reabertura pode RETIRAR/alterar produto) — compara com o Bling
    const itensBling=(ped.itens||[]).map(i=>({produtoId:i.produto?.id,nome:i.descricao||"",quantidade:Number(i.quantidade),valor:Number(i.valor)}));
    const itensNovos=(Array.isArray(req.body.itens)&&req.body.itens.length)?req.body.itens.map(i=>({produtoId:i.produtoId,nome:i.nome||"",quantidade:Number(i.quantidade),valor:Number(i.valor),modoPreco:i.modoPreco||null})):null;
    const diffItensEd=itensNovos?diffItens(itensBling,itensNovos):{mudou:false,retirados:[],acrescentados:[],alterados:[],de:"",para:""};
    const itensMudaramEd=diffItensEd.mudou;

    // descrição do pagamento ANTES: usa o histórico local (tem nome+valor); senão, as parcelas do Bling
    const pags=lerPag(); const idStr=String(pedidoId); const antigo=pags[idStr]||null;
    let antesList=[];
    if(antigo&&Array.isArray(antigo.historico)&&antigo.historico.length){
      antesList=antigo.historico.map(h=>({formaNome:h.formaNome||"?", valor:Number(h.valor)||0}));
    }else{
      antesList=(ped.parcelas||[]).map(p=>({formaNome:p.formaPagamento?.nome||"?", valor:Number(p.valor)||0}));
    }
    let descAntes=antesList.map(p=>`${p.formaNome}: ${fmt(p.valor)}`).join(" · ")||"—";

    const funcsNome=(lerJSON(FUNC_FILE,{})[funcionarioId]?.nome)||"—";
    const quando=new Date().toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"});
    const depoisList=linhas.map(p=>({formaNome:p.formaNome||"?", valor:Number(p.valor)||0}));
    const descDepoisPre=depoisList.map(p=>`${p.formaNome}: ${fmt(p.valor)}`).join(" · ")||"—";
    // diff: o que saiu e o que entrou, por forma
    const agg={};
    antesList.forEach(p=>{ agg[p.formaNome]=(agg[p.formaNome]||0)-p.valor; });
    depoisList.forEach(p=>{ agg[p.formaNome]=(agg[p.formaNome]||0)+p.valor; });
    const tirou=[], acrescentou=[];
    Object.entries(agg).forEach(([k,v])=>{ if(v<-0.009) tirou.push(`${k}: ${fmt(-v)}`); else if(v>0.009) acrescentou.push(`${k}: ${fmt(v)}`); });
    const notaObs=[
      `[Alteração de pagamento ${quando} — por ${funcsNome}, autoriz. ${auth.funcionario.nome}]`,
      `Antes: ${descAntes}`,
      `Depois: ${descDepoisPre}`,
      `Tirou: ${tirou.length?tirou.join(" · "):"—"}`,
      `Acrescentou: ${acrescentou.length?acrescentou.join(" · "):"—"}`,
    ].join("\n");
    const parcelasEd=linhas.map(p=>({valor:Number(p.valor),formaId:p.formaId}));
    let rBling, estoqueRepostoEd=[];
    if(itensMudaramEd){
      // itens mudaram: grava itens + parcelas + histórico num único PUT (destrava Atendido se preciso)
      const blocoItens=blocoHistoricoItens(diffItensEd, funcsNome, auth.funcionario.nome);
      rBling=await atualizarItensBling(pedidoId, itensNovos.map(i=>({produtoId:i.produtoId,quantidade:i.quantidade,valor:i.valor})), notaObs+"\n"+blocoItens, {ped, parcelas:parcelasEd, outrasDespesas:ped.outrasDespesas!=null?Number(ped.outrasDespesas):null, itensParaEstoque:itensNovos});
      if(rBling?.reposto?.length) estoqueRepostoEd=rBling.reposto;
    } else {
      rBling=await atualizarParcelasBling(pedidoId, parcelasEd, {obsExtra:notaObs, ped});
      if(rBling?.restauracao?.reposto?.length) estoqueRepostoEd=rBling.restauracao.reposto;
    }
    if(!rBling.ok){
      let m=rBling.erro||"desconhecido";
      if(/estoque|saldo/i.test(m)) m="o Bling barrou por estoque insuficiente, mesmo após tentar repor. Nada foi alterado. Confira o estoque no Bling e tente de novo.";
      registrarAviso({tipo:"edicao_caixa_bling_falhou",titulo:`Pedido #${numero||ped.numero}: alteração no caixa não salva no Bling`,pedidoId:idStr,numero:numero||ped.numero,operador:funcsNome,origem:"Caixa Atacado (reabertura)",erroBling:rBling.erro||"",fingerprint:`edcx-${idStr}-${Date.now()}`,
        oQueFazer:`Tentou alterar o pedido #${numero||ped.numero} (${itensMudaramEd?"itens e ":""}pagamento) e o Bling recusou. ${itensMudaramEd?"Itens pretendidos: "+diffItensEd.para+". ":""}Pagamento pretendido: ${descDepoisPre}.`});
      return res.status(502).json({erro:"Falha ao atualizar no Bling: "+m});
    }
    if(estoqueRepostoEd.length){
      registrarAviso({tipo:"estoque_reposto_auto",titulo:`Pedido #${numero||ped.numero}: estoque reposto automaticamente (reabertura)`,pedidoId:idStr,numero:numero||ped.numero,operador:funcsNome,origem:"Caixa Atacado (reabertura)",fingerprint:`repo-ed-${idStr}-${Date.now()}`,estoqueAjustado:estoqueRepostoEd.map(r=>`${r.nome||("produto "+r.produtoId)} +${r.faltava}`).join(", "),oQueFazer:"Confira no Bling se o saldo desses produtos está certo."});
    }

    // atualiza registro local de pagamento — o total passa a ser o que foi efetivamente recebido
    const somaNova=+linhas.reduce((s,p)=>s+Number(p.valor),0).toFixed(2);
    const historico=linhas.map(p=>({em:Date.now(),valor:+Number(p.valor).toFixed(2),formaNome:p.formaNome||"",tipo:"caixa_atacado_edit"}));
    const valorPedido=somaNova;
    pags[idStr]={
      ...(antigo||{}), pedidoId:idStr, valorPago:somaNova, valorPedido, frete:Number(req.body.frete||antigo?.frete||0), historico,
      statusPagamento: somaNova>=valorPedido-0.05?"pago":(somaNova>0?"parcial":"pendente"),
    };
    salvarJSON(PAG_FILE,pags);

    // marca o movimento no histórico do caixa (vermelho, com o que mudou) e atualiza total/frete
    const funcs=lerJSON(FUNC_FILE,{});
    const descDepois=linhas.map(p=>`${p.formaNome||"?"}: ${fmt(p.valor)}`).join(" · ");
    const alteracao={
      em:Date.now(), tipo:"pagamento",
      autorizadoPor:auth.funcionario.nome,
      por:(funcs[funcionarioId]?.nome)||"—",
      de:descAntes, para:descDepois,
    };
    const altItens=itensMudaramEd?[{em:Date.now(),tipo:"itens",por:alteracao.por,autorizadoPor:auth.funcionario.nome,de:diffItensEd.de,para:diffItensEd.para,
      retirados:diffItensEd.retirados.map(_fmtItem),acrescentados:diffItensEd.acrescentados.map(_fmtItem),
      alterados:diffItensEd.alterados.map(a=>`${a.nome}: ${a.de.quantidade}x ${fmt(a.de.valor)} → ${a.para.quantidade}x ${fmt(a.para.valor)}`)}]:[];
    const achouMov=marcarMovimentoAlterado(idStr, linhas.map(p=>({formaNome:p.formaNome||"",valor:+Number(p.valor).toFixed(2)})), alteracao, {novoTotal:somaNova, frete:Number(req.body.frete||0), itens:itensMudaramEd?itensNovos:null, alteracoesExtra:altItens});
    addLog(idStr,"pagamento_editado_caixa",funcionarioId,alteracao.por,{autorizadoPor:auth.funcionario.nome,de:descAntes,para:descDepois});
    if(itensMudaramEd) registrarHistoricoItens(idStr, diffItensEd, funcionarioId, alteracao.por, auth.funcionario.nome);

    // se o pedido NÃO estava em nenhum caixa do sistema, entra no caixa (aberto) de quem
    // está finalizando agora — e avisa isso ao salvar.
    let incluidoNoCaixa=null;
    if(!achouMov){
      const dCx=lerCaixaSessoes();
      const sAberta=(dCx.sessoes||[]).find(s=>!s.fechadaEm && String(s.funcionarioId)===String(funcionarioId) && (s.tipoCaixa||"")==="atacado")
        || (dCx.sessoes||[]).find(s=>!s.fechadaEm && String(s.funcionarioId)===String(funcionarioId));
      if(sAberta){
        sAberta.movimentos=sAberta.movimentos||[];
        sAberta.movimentos.push({
          tipo:"venda", em:Date.now(), pedidoId:idStr, numero:numero||ped.numero,
          total:+Number(totalPedido).toFixed(2), clienteNome:ped.contato?.nome||"", origem:"caixa_atacado_reaberto",
          operador:sAberta.operador||"", outrasDespesas:Number(ped.outrasDespesas||0),
          pagamentos:linhas.map(p=>({formaNome:p.formaNome||"",valor:+Number(p.valor).toFixed(2)})),
          itens:(itensNovos||itensBling).map(i=>({produtoId:i.produtoId,nome:i.nome||"",quantidade:i.quantidade,valor:i.valor,modoPreco:i.modoPreco||null})),
          alterado:true, alteracoes:[...altItens,alteracao],
        });
        salvarCaixaSessoes(dCx);
        incluidoNoCaixa={operador:sAberta.operador||"", sessaoId:sAberta.id};
        addLog(idStr,"pedido_incluido_no_caixa",funcionarioId,alteracao.por,{caixaDe:sAberta.operador||"",motivo:"pedido não pertencia a nenhum caixa"});
      }
    }

    res.json({ok:true, autorizadoPor:auth.funcionario.nome, de:descAntes, para:descDepois, numero:numero||ped.numero, movimentoAtualizado:achouMov, incluidoNoCaixa,
      itensAlterados:itensMudaramEd?{retirados:diffItensEd.retirados.map(_fmtItem),acrescentados:diffItensEd.acrescentados.map(_fmtItem),alterados:diffItensEd.alterados.map(a=>`${a.nome}: ${a.de.quantidade}x→${a.para.quantidade}x`)}:null,
      estoqueReposto:estoqueRepostoEd});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// GESTÃO: mudar a forma de pagamento de QUALQUER venda (caixa aberto ou fechado).
// Autorizado pelo login de admin da Gestão de Caixas (sem QR). Registra quem alterou.
app.post("/api/gestao/editar-pagamento-venda",async(req,res)=>{
  try{
    const {pedidoId,pagamentos,operador,funcionarioId,numero}=req.body||{};
    if(!pedidoId) return res.status(400).json({erro:"pedidoId obrigatório"});
    const linhas=(Array.isArray(pagamentos)?pagamentos:[]).filter(p=>p&&p.formaId&&Number(p.valor)>0);
    if(!linhas.length) return res.status(400).json({erro:"informe ao menos uma forma de pagamento"});
    const fmt=(v)=>Number(v||0).toFixed(2);
    const quemAlterou=operador||"Gestão";

    const ped=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data).catch(()=>null);
    if(!ped) return res.status(404).json({erro:"pedido não encontrado no Bling"});

    const pags=lerPag(); const idStr=String(pedidoId); const antigo=pags[idStr]||null;
    let descAntes="";
    if(antigo&&Array.isArray(antigo.historico)&&antigo.historico.length){
      descAntes=antigo.historico.map(h=>`${h.formaNome||"?"}: ${fmt(h.valor)}`).join(" · ");
    }else{
      descAntes=(ped.parcelas||[]).map(p=>`${p.formaPagamento?.nome||"?"}: ${fmt(p.valor)}`).join(" · ");
    }
    descAntes=descAntes||"—";
    const descDepois=linhas.map(p=>`${p.formaNome||"?"}: ${fmt(p.valor)}`).join(" · ");

    const quando=new Date().toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"});
    const notaObs=`[Alteração ${quando} — ${quemAlterou} (Gestão de Caixas)] Pagamento: ${descAntes} -> ${descDepois}`;
    const rBling=await atualizarParcelasBling(pedidoId, linhas.map(p=>({valor:Number(p.valor),formaId:p.formaId})), {obsExtra:notaObs});
    const blingOk=!!rBling.ok;
    const blingErro=blingOk?"":(rBling.erro||"desconhecido");
    // segue registrando no histórico do caixa MESMO se o Bling recusar (ex.: estoque insuficiente).
    // Nesse caso o gestor ajusta o Bling na mão, mas o caixa já reflete a forma correta.

    const somaNova=+linhas.reduce((s,p)=>s+Number(p.valor),0).toFixed(2);
    const historico=linhas.map(p=>({em:Date.now(),valor:+Number(p.valor).toFixed(2),formaNome:p.formaNome||"",tipo:"gestao_edit"}));
    pags[idStr]={
      ...(antigo||{}), pedidoId:idStr, valorPago:somaNova, valorPedido:somaNova, historico,
      statusPagamento: somaNova>0?"pago":"pendente",
    };
    salvarJSON(PAG_FILE,pags);

    const alteracao={ em:Date.now(), tipo:"pagamento", autorizadoPor:quemAlterou+" (Gestão)", por:quemAlterou, de:descAntes, para:descDepois, ...(blingOk?{}:{blingPendente:true, blingErro}) };
    const achouMov=marcarMovimentoAlterado(idStr, linhas.map(p=>({formaNome:p.formaNome||"",valor:+Number(p.valor).toFixed(2)})), alteracao, {novoTotal:somaNova});
    addLog(idStr,"pagamento_editado_gestao",funcionarioId||null,quemAlterou,{de:descAntes,para:descDepois,blingOk,blingErro});

    res.json({ok:true, blingOk, blingErro, de:descAntes, para:descDepois, numero:numero||ped.numero, movimentoAtualizado:achouMov});
  }catch(e){ res.status(500).json({erro:e.message}); }
});


// CANCELAR uma venda JÁ FINALIZADA — só com autorização de gerente/financeiro/admin (QR).
// Move o pedido pra CANCELADO no Bling, zera o pagamento local e marca o movimento
// como CANCELADO no histórico do caixa (some do total, aparece em vermelho).
// cancela uma venda pela Gestão de Caixas (tela de admin) — move pro Cancelado no Bling,
// zera o pagamento local e marca o movimento como cancelado. Com trava Bling ok/falhou.
// edita os ITENS de uma venda pela Gestão de Caixas. Destrava do Atendido, atualiza no
// Bling (reaproveitando atualizarItensBling, que recalcula as parcelas), restaura o status,
// e sempre grava a alteração no HISTÓRICO do caixa. Trava Bling ok/falhou (estoque).
app.post("/api/gestao/editar-itens-venda",async(req,res)=>{
  try{
    const {pedidoId, itens, operador}=req.body||{};
    if(!pedidoId) return res.status(400).json({erro:"pedidoId obrigatório"});
    const itensLimpos=(itens||[]).map(i=>({produtoId:Number(i.produtoId),nome:i.nome||"",quantidade:Number(i.quantidade)||0,valor:Number(i.valor)||0})).filter(i=>i.produtoId&&i.quantidade>0);
    if(!itensLimpos.length) return res.status(400).json({erro:"informe ao menos um item válido (produto e quantidade)"});

    const ped=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data).catch(()=>null);
    if(!ped) return res.status(404).json({erro:"pedido não encontrado no Bling"});
    const sitOrig=ped.situacao?.id;
    const obsExtra=`[Itens alterados ${new Date().toISOString().slice(0,16).replace('T',' ')} — ${operador||"Gestão"} (Gestão de Caixas)]`;

    let blingOk=true, blingErro=null, destravou=false;
    try{
      if(sitOrig===SIT.ATENDIDO){
        const d=await _destravarSituacao(pedidoId);
        if(d){ destravou=true; await sleep(400); }
        else { blingOk=false; blingErro="não foi possível destravar o pedido Atendido no Bling"; }
      }
      if(blingOk){
        const r=await atualizarItensBling(pedidoId, itensLimpos, obsExtra);
        if(!r||r.ok===false){ blingOk=false; blingErro=(r&&r.erro)||"falha ao atualizar itens no Bling"; }
      }
    }catch(e){ blingOk=false; blingErro=e.message||String(e); }
    finally{
      if(destravou){ try{ await _restaurarSituacao(pedidoId, sitOrig); }catch(e){} }
    }

    const freteAtual=+(ped.transporte?.frete||0);
    const novoTotal=+((itensLimpos.reduce((s,i)=>s+i.quantidade*i.valor,0))+freteAtual).toFixed(2);

    // grava no movimento do caixa (itens + total) + histórico
    const dCx=lerCaixaSessoes(); let achou=false; const idStr=String(pedidoId);
    (dCx.sessoes||[]).forEach(s=>(s.movimentos||[]).forEach(m=>{
      if(m.tipo==="venda" && String(m.pedidoId)===idStr){
        const antes=(m.itens||[]).map(i=>`${i.quantidade}x ${i.nome}`).join(", ")||"—";
        const depois=itensLimpos.map(i=>`${i.quantidade}x ${i.nome}`).join(", ");
        m.itens=itensLimpos.map(i=>({produtoId:i.produtoId,nome:i.nome,quantidade:i.quantidade,valor:i.valor}));
        m.total=novoTotal; m.alterado=true;
        m.alteracoes=m.alteracoes||[];
        m.alteracoes.push({em:Date.now(), tipo:"itens", por:(operador||"Gestão"), autorizadoPor:(operador||"Gestão"), de:antes, para:depois, viaGestao:true, blingPendente:!blingOk});
        achou=true;
      }
    }));
    if(achou) salvarCaixaSessoes(dCx);
    addLog(idStr,"itens_alterados_gestao",null,(operador||"Gestão"),{blingOk,novoTotal});
    if(!blingOk){
      registrarAviso({
        tipo:"edicao_itens_bling_falhou",
        titulo:`Edição de itens não salva no Bling — pedido #${ped.numero||pedidoId}`,
        pedidoId, numero:ped.numero||null, operador:(operador||"Gestão"), origem:"Gestão de Caixas",
        erroBling:blingErro,
        novoTotal,
        itensNovos: itensLimpos.map(i=>({nome:i.nome, quantidade:i.quantidade, valor:i.valor})),
        oQueFazer:`No Bling, abra o pedido #${ped.numero||pedidoId} e deixe os itens assim: `+itensLimpos.map(i=>`${i.quantidade}x ${i.nome}`).join(", ")+`. Novo total ${novoTotal}. O caixa já está com esses itens; falta só replicar no Bling.`,
      });
    }
    res.json({ok:true, pedidoId, novoTotal, movimentoAtualizado:achou, blingOk, blingErro});
  }catch(e){ res.status(500).json({erro:e.message,body:e.body}); }
});

// CANCELA SÓ O REGISTRO LOCAL de um lançamento — NÃO mexe no Bling. Uso: corrigir
// duplicidade histórica no caixa quando o Bling já está correto (1 pedido só) e um dos
// lançamentos locais é sobra de um bug antigo (ex: reabertura que criava lançamento novo
// em vez de atualizar). Identifica o lançamento exato por sessaoId+em+pedidoId, pra não
// arriscar cancelar o errado. Recalcula o fechamento se a sessão já estava fechada.
app.post("/api/gestao/cancelar-lancamento-local",(req,res)=>{
  try{
    const {sessaoId, em, pedidoId, operador, motivo}=req.body||{};
    if(!sessaoId||!em||!pedidoId) return res.status(400).json({erro:"informe sessaoId, em e pedidoId"});
    const dCx=lerCaixaSessoes();
    const s=(dCx.sessoes||[]).find(x=>x.id===sessaoId);
    if(!s) return res.status(404).json({erro:"sessão não encontrada"});
    const mov=(s.movimentos||[]).find(m=>m.tipo==="venda"&&String(m.pedidoId)===String(pedidoId)&&Number(m.em)===Number(em));
    if(!mov) return res.status(404).json({erro:"lançamento não encontrado (confira sessaoId/em/pedidoId)"});
    if(mov.cancelado) return res.status(400).json({erro:"esse lançamento já está cancelado"});
    const totalAntes=+(resumoSessaoCaixa(s).totalVendas||0).toFixed(2);
    mov.cancelado=true;
    mov.alteracoes=[...(mov.alteracoes||[]),{ em:Date.now(), tipo:"cancelamento_local_duplicado", por:operador||"Gestão", motivo:motivo||"", blingTocado:false }];
    if(s.fechadaEm&&s.resumoFinal){ try{ s.resumoFinal=resumoSessaoCaixa(s); }catch(e){} }
    salvarCaixaSessoes(dCx);
    const totalDepois=+(resumoSessaoCaixa(s).totalVendas||0).toFixed(2);
    addLog(String(pedidoId),"venda_cancelada_local_duplicado",null,operador||"Gestão",{motivo:motivo||"",sessaoId,em,valorRemovido:+(totalAntes-totalDepois).toFixed(2)});
    res.json({ok:true, totalVendasAntes:totalAntes, totalVendasDepois:totalDepois, diferenca:+(totalAntes-totalDepois).toFixed(2)});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.post("/api/gestao/cancelar-venda",async(req,res)=>{
  try{
    const {pedidoId, operador, motivo}=req.body||{};
    if(!pedidoId) return res.status(400).json({erro:"pedidoId obrigatório"});
    const CANCELADO=Number(process.env.SIT_CANCELADO||12);
    const ped=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data).catch(()=>null);
    if(!ped) return res.status(404).json({erro:"pedido não encontrado no Bling"});
    let blingOk=true, blingErro=null;
    try{ await bling(`/pedidos/vendas/${pedidoId}/situacoes/${CANCELADO}`,{method:"PATCH"}); }
    catch(e){ blingOk=false; blingErro=e.message; }
    const pags=lerPag(); const idStr=String(pedidoId); const antigo=pags[idStr]||null;
    if(antigo){ pags[idStr]={...antigo, statusPagamento:"cancelado", valorPago:0, canceladoEm:Date.now()}; salvarJSON(PAG_FILE,pags); }
    const alteracao={ em:Date.now(), tipo:"cancelamento", por:(operador||"Gestão"), autorizadoPor:(operador||"Gestão"), motivo:motivo||"", viaGestao:true, blingPendente:!blingOk };
    const achouMov=marcarMovimentoAlterado(idStr, null, alteracao, {cancelado:true});
    addLog(idStr,"venda_cancelada_gestao",null,(operador||"Gestão"),{motivo:motivo||"",blingOk});
    res.json({ok:true, numero:ped.numero, movimentoAtualizado:achouMov, blingOk, blingErro});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// CONFERE o registro do caixa contra o Bling (ao reabrir um pedido). Aponta o que está
// diferente: total, itens (faltando/sobrando/quantidade ou preço) e formas de pagamento.
app.get("/api/caixa-atacado/conferir-bling/:pedidoId",async(req,res)=>{
  try{
    const pid=String(req.params.pedidoId);
    const d=await bling(`/pedidos/vendas/${pid}`).then(r=>r?.data).catch(()=>null);
    if(!d) return res.json({ok:false, erro:"pedido não encontrado no Bling"});
    // Bling
    const itensBling=(d.itens||[]).map(it=>({nome:(it.descricao||it.produto?.nome||"produto").trim(), quantidade:Number(it.quantidade)||0, valor:Number(it.valor)||0}));
    const totalBling=Number(d.total)||0;
    const formasBling=[];
    for(const pc of (d.parcelas||[])){ formasBling.push({forma:await nomeFormaPagamentoId(pc.formaPagamento?.id), valor:Number(pc.valor)||0}); }
    // Caixa (movimento mais recente desse pedido)
    const dCx=lerCaixaSessoes(); let mov=null;
    (dCx.sessoes||[]).forEach(s=>(s.movimentos||[]).forEach(m=>{
      if(m.tipo==="venda" && String(m.pedidoId)===pid && (!mov||m.em>mov.em)) mov=m;
    }));
    const itensCaixa=(mov?.itens||[]).map(i=>({nome:(i.nome||"produto").trim(), quantidade:Number(i.quantidade)||0, valor:Number(i.valor)||0}));
    const totalCaixa=mov?Number(mov.total)||0:null;
    const formasCaixa=(mov?.pagamentos||[]).map(p=>({forma:p.formaNome||"—", valor:Number(p.valor)||0}));
    // diffs de itens: compara por nome
    const key=(i)=>i.nome.toLowerCase();
    const mapB={}; itensBling.forEach(i=>mapB[key(i)]=i);
    const mapC={}; itensCaixa.forEach(i=>mapC[key(i)]=i);
    const soNoBling=[], soNoCaixa=[], divergentes=[];
    Object.values(mapB).forEach(b=>{ const c=mapC[key(b)]; if(!c) soNoBling.push(b); else if(c.quantidade!==b.quantidade||Math.abs(c.valor-b.valor)>0.009) divergentes.push({nome:b.nome, bling:b, caixa:c}); });
    Object.values(mapC).forEach(c=>{ if(!mapB[key(c)]) soNoCaixa.push(c); });
    const totalDifere = (totalCaixa!=null) && Math.abs(totalCaixa-totalBling)>0.009;
    const difere = !!(soNoBling.length||soNoCaixa.length||divergentes.length||totalDifere);
    res.json({ ok:true, difere, temRegistroCaixa:!!mov,
      total:{ bling:totalBling, caixa:totalCaixa, difere:totalDifere },
      itens:{ soNoBling, soNoCaixa, divergentes },
      formas:{ bling:formasBling, caixa:formasCaixa },
    });
  }catch(e){ res.status(e.status||500).json({ok:false, erro:e.message}); }
});

app.post("/api/caixa-atacado/cancelar-venda",async(req,res)=>{
  try{
    const {pedidoId,tokenQr,funcionarioId,numero,motivo}=req.body||{};
    if(!pedidoId) return res.status(400).json({erro:"pedidoId obrigatório"});
    const auth=validarTokenQrAtacado(tokenQr);
    if(auth.erro) return res.status(401).json({erro:auth.erro});
    const CANCELADO=Number(process.env.SIT_CANCELADO||12);

    const ped=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data).catch(()=>null);
    if(!ped) return res.status(404).json({erro:"pedido não encontrado no Bling"});

    // move a situação pro Cancelado no Bling
    try{
      await bling(`/pedidos/vendas/${pedidoId}/situacoes/${CANCELADO}`,{method:"PATCH"});
    }catch(e){ return res.status(502).json({erro:"Falha ao cancelar no Bling: "+e.message}); }

    // zera/estorna o pagamento local
    const pags=lerPag(); const idStr=String(pedidoId); const antigo=pags[idStr]||null;
    if(antigo){
      pags[idStr]={...antigo, statusPagamento:"cancelado", valorPago:0, canceladoEm:Date.now()};
      salvarJSON(PAG_FILE,pags);
    }

    // marca o movimento como cancelado no histórico do caixa
    const funcs=lerJSON(FUNC_FILE,{});
    const alteracao={
      em:Date.now(), tipo:"cancelamento",
      autorizadoPor:auth.funcionario.nome,
      por:(funcs[funcionarioId]?.nome)||"—",
      motivo:motivo||"",
    };
    const achouMov=marcarMovimentoAlterado(idStr, null, alteracao, {cancelado:true});
    addLog(idStr,"venda_cancelada_caixa",funcionarioId,alteracao.por,{autorizadoPor:auth.funcionario.nome,motivo:motivo||""});

    res.json({ok:true, autorizadoPor:auth.funcionario.nome, numero:numero||ped.numero, movimentoAtualizado:achouMov});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// gera o token/QR do dia pra um funcionário (só se ele for de grupo autorizado).
// usado no perfil do funcionário (tela de funcionários) pra mostrar o QR do dia.
app.get("/api/pdv/meu-qr/:funcId",(req,res)=>{
  try{
    const funcs=lerJSON(FUNC_FILE,{});
    const f=funcs[req.params.funcId];
    if(!f||!f.ativo) return res.status(404).json({erro:"funcionário não encontrado"});
    // quem pode gerar QR: quem autoriza o Frente de Caixa (admin/gerente/líder) OU
    // quem autoriza o Caixa Atacado (admin/gerente/financeiro) — assim o financeiro
    // também tem seu QR do dia pra autorizar mudança de preço no atacado.
    const autoriza=GRUPOS_AUTORIZAM_PDV.includes(f.nivel)||(f.permissoes||[]).some(p=>GRUPOS_AUTORIZAM_PDV.includes(p))
      ||GRUPOS_AUTORIZAM_ATACADO.includes(f.nivel)||(f.permissoes||[]).some(p=>GRUPOS_AUTORIZAM_ATACADO.includes(p));
    if(!autoriza) return res.status(403).json({erro:"esse funcionário não pode autorizar caixa"});
    const dia=_diaBR();
    res.json({ok:true, nome:f.nome, dia, token:gerarTokenQr(f.id,dia)});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// Ajusta o estoque do produto no Bling (define o saldo pro valor informado) — usado quando
// o funcionário tenta vender um produto sem estoque suficiente no sistema, mas o produto
// está fisicamente disponível (ex: contagem desatualizada). Exige a mesma autorização.
app.post("/api/pdv/ajustar-estoque",async(req,res)=>{
  const {tokenQr,idDigitado,senhaDigitada,produtoId,quantidade}=req.body||{};
  const auth = tokenQr ? validarTokenQr(tokenQr) : validarAutorizacaoPdv(idDigitado,senhaDigitada);
  if(auth.erro) return res.status(401).json({erro:auth.erro});
  if(!produtoId||!(quantidade>0)) return res.status(400).json({erro:"informe produtoId e quantidade"});
  try{
    await bling(`/estoques`,{method:"POST",body:JSON.stringify({
      produto:{id:Number(produtoId)},
      operacao:"B", // balanço — define o saldo absoluto do estoque
      quantidade:Number(quantidade),
      observacoes:`Ajuste via Frente de Caixa — autorizado por ${auth.funcionario.nome}`,
    })});
    res.json({ok:true,autorizadoPor:auth.funcionario.nome,novoEstoque:Number(quantidade)});
  }catch(e){ res.status(e.status||500).json({erro:e.message,detalhe:e.body}); }
});

const _opsVendaNovaEmAndamento=new Set();
app.post("/api/pdv/venda", async(req,res)=>{
  const opId=req.body?.opId?String(req.body.opId):null;
  // idempotência: a mesma tentativa (retry/clique duplo/F5) NÃO cria um segundo pedido no Bling
  if(opId){
    const op=opFinalizarGet(opId);
    if(op?.status==="ok") return res.json({...op.resposta, repetido:true});
    if(op?.status==="em_andamento" && _opsVendaNovaEmAndamento.has(opId)) return res.status(202).json({emAndamento:true,opId});
    _opsVendaNovaEmAndamento.add(opId);
    opFinalizarSet(opId,{status:"em_andamento"});
  }
  try{
    const {itens,contatoId,clienteNome,desconto,pagamentos,emitirNfce,funcionarioId}=req.body||{};
    if(!Array.isArray(itens)||!itens.length) return res.status(400).json({erro:"Carrinho vazio"});
    if(!Array.isArray(pagamentos)||!pagamentos.length) return res.status(400).json({erro:"Informe ao menos uma forma de pagamento"});

    // se a venda vem do caixa atacado, garante estoque (repõe só o que faltar) pra o
    // Bling não barrar a baixa de estoque na criação/atendimento do pedido.
    let estoqueReposto=[];
    if(req.body.tipoCaixa==="atacado"){
      try{ estoqueReposto=await garantirEstoqueParaItens(itens); }
      catch(e){ console.error("Falha ao garantir estoque na venda nova (segue):",e.message); }
    }

    // vendedor: usa o vendedor Bling vinculado ao funcionário logado no caixa;
    // se o funcionário não tiver um vendedor configurado, cai pro ID fixo do .env (compatibilidade)
    let vendedorId=null;
    if(funcionarioId){
      const funcs=lerJSON(FUNC_FILE,{});
      const func=funcs[funcionarioId];
      if(func?.vendedorBlingId) vendedorId=Number(func.vendedorBlingId);
    }
    if(!vendedorId) vendedorId=Number(process.env.BLING_VENDEDOR_ID)||null;
    // garante que o vendedor enviado esteja ATIVO no Bling (senão a venda é recusada
    // com "Vendedor inativo"). Se o do operador estiver inativo, troca por um ativo.
    try{ vendedorId = await vendedorAtivoId(vendedorId); }catch(e){}

    const itensPayload=itens.map(i=>({
      produto:{id:Number(i.produtoId)},
      quantidade:Number(i.quantidade),
      valor:Number(i.valor),
      ...(i.desconto?{desconto:Number(i.desconto)}:{}),
    }));

    const totalItens=itens.reduce((s,i)=>s+Number(i.valor)*Number(i.quantidade),0);
    const totalDesconto=Number(desconto||0);
    const totalPedido=+(totalItens-totalDesconto).toFixed(2);

    const dataHojeBR=new Date(Date.now()-3*60*60*1000).toISOString().slice(0,10);
    // o Bling exige um contato no pedido — se a venda não tem cliente (nova venda no
    // caixa), usa o CONSUMIDOR FINAL padrão. Sem isso o Bling recusa com erro 400.
    let contatoFinal=contatoId?Number(contatoId):null;
    if(!contatoFinal){ try{ contatoFinal=await getContatoPadrao(); }catch(e){} }
    const payload={
      data: dataHojeBR,
      itens:itensPayload,
      ...(contatoFinal?{contato:{id:Number(contatoFinal)}}:{}),
      ...(vendedorId?{vendedor:{id:vendedorId}}:{}),
      ...(totalDesconto?{desconto:{valor:totalDesconto,unidade:"REAL"}}:{}),
      ...(req.body.observacao&&String(req.body.observacao).trim()?{observacoes:String(req.body.observacao).trim()}:{}),
      ...(Number(req.body.taxaCredito)>0?{outrasDespesas:+Number(req.body.taxaCredito).toFixed(2)}:{}),
      ...(Number(req.body.freteBase)>0?{transporte:{frete:+Number(req.body.freteBase).toFixed(2),fretePorConta:0}}:{}),
      parcelas: pagamentos.map(p=>({valor:+Number(p.valor).toFixed(2),dataVencimento:dataHojeBR,formaPagamento:{id:Number(p.formaId)}})),
    };

    let criado;
    try{
      criado=await bling(`/pedidos/vendas`,{method:"POST",body:JSON.stringify(payload)});
    }catch(e){
      // se ainda assim vier "vendedor inativo", troca por um vendedor ATIVO e tenta de
      // novo; se não houver nenhum ativo, manda sem vendedor como último recurso.
      if(/vendedor\s*inativo|vendedor.*inativ/i.test(e.message||"")){
        let alt=null; try{ alt=await vendedorAtivoId(null); }catch(_){}
        if(alt && String(alt)!==String(payload.vendedor?.id)){
          console.warn("Vendedor inativo — trocando por vendedor ativo id:",alt,"(era",payload.vendedor?.id,")");
          payload.vendedor={id:alt};
        }else{
          console.warn("Vendedor inativo e sem ativo disponível — recriando venda sem vendedor.");
          delete payload.vendedor;
        }
        criado=await bling(`/pedidos/vendas`,{method:"POST",body:JSON.stringify(payload)});
      } else { throw e; }
    }
    const pedidoId=criado?.data?.id;
    if(!pedidoId) return res.status(500).json({erro:"Bling não retornou o ID do pedido criado",detalhe:criado});
    // move pro status final correto. Regra: venda nova no VAREJO -> Atendido;
    // venda nova no atacado (ou statusFinal 'separado') -> Separado. Default Atendido.
    const statusFinalVenda = req.body.statusFinal==="separado" ? "separado" : "atendido";
    try{ await moverPedidoParaStatusFinal(pedidoId, statusFinalVenda); }
    catch(e){ console.error("Falha ao mover pedido pra "+statusFinalVenda+" (venda ja foi criada, id="+pedidoId+"):",e.message); }
    // número do pedido: usa o que o Bling devolveu na criação (se não vier, é buscado
    // em segundo plano depois de responder — não trava a finalização)
    let numeroPedido=criado?.data?.numero||null;

    // registra localmente (mesmo padrão usado no restante do sistema)
    const pags=lerPag();
    const historico=pagamentos.map(p=>({em:Date.now(),valor:+Number(p.valor).toFixed(2),formaNome:p.formaNome||"",tipo:"pdv_varejo"}));
    const _outrasPagNova=+Number(req.body.taxaCredito||0).toFixed(2);
    const _totalPagarNova=+(totalPedido+_outrasPagNova+Number(req.body.freteBase||0)).toFixed(2);
    const _valorPagoNova=+pagamentos.reduce((s,p)=>s+Number(p.valor),0).toFixed(2);
    pags[String(pedidoId)]={
      pedidoId:String(pedidoId), valorPago:_valorPagoNova, valorPedido:_totalPagarNova, historico,
      statusPagamento:_valorPagoNova>=_totalPagarNova-0.05?"pago":(_valorPagoNova>0?"parcial":"pendente"),
    };
    salvarJSON(PAG_FILE,pags);

    // vincula a venda à sessão de caixa aberta DESSE funcionário (pra entrar no fechamento/conferência)
    try{
      const dCx=lerCaixaSessoes();
      const tc=req.body.tipoCaixa||"frente";
      const sessaoAtual=(dCx.sessoes||[]).find(s=>!s.fechadaEm&&s.funcionarioId===funcionarioId&&(s.tipoCaixa||"frente")===tc);
      if(sessaoAtual){
        const _outrasNova=+Number(req.body.taxaCredito||0).toFixed(2);
        const _freteNova=+Number(req.body.freteBase||0).toFixed(2);
        const _menorNova=(req.body.autorizouMenor&&Number(req.body.autorizouMenor.falta)>0)?{faltou:+Number(req.body.autorizouMenor.falta).toFixed(2),autorizadoPor:req.body.autorizouMenor.autorizadoPor||"—"}:null;
        sessaoAtual.movimentos.push({
          tipo:"venda", em:Date.now(), pedidoId, numero:numeroPedido,
          total:+(totalPedido+_outrasNova+_freteNova).toFixed(2), clienteNome:clienteNome||"", desconto:totalDesconto,
          outrasDespesas:_outrasNova, frete:_freteNova, operador:sessaoAtual.operador||"",
          ...(_menorNova?{valorMenor:_menorNova}:{}),
          itens:(itens||[]).map(i=>({produtoId:i.produtoId,nome:i.nome||"",quantidade:Number(i.quantidade),valor:Number(i.valor),modoPreco:i.modoPreco||null})),
          pagamentos:pagamentos.map(p=>({formaNome:p.formaNome||"",valor:+Number(p.valor).toFixed(2)})),
        });
        salvarCaixaSessoes(dCx);
        if(_menorNova) addLog(String(pedidoId),"fechado_valor_menor",funcionarioId,(lerJSON(FUNC_FILE,{})[funcionarioId]?.nome)||"—",{faltou:_menorNova.faltou,autorizadoPor:_menorNova.autorizadoPor});
      }
    }catch(e){ console.error("Falha ao vincular venda à sessão de caixa (ignorado):",e.message); }

    let nfce=null;
    if(emitirNfce && (req.body.tipoCaixa||"")==="atacado"){
      // caixa ATACADO: NFC-e em segundo plano (não segura a resposta; SEFAZ pode demorar)
      emitirNfceEmSegundoPlano(pedidoId, numeroPedido, (lerJSON(FUNC_FILE,{})[funcionarioId]?.nome)||"");
      nfce={pendente:true};
    } else if(emitirNfce){
      try{
        // gera a NFC-e puxando os dados direto do pedido (igual o botão "Gerar NFC-e" do Bling faz)
        const gerado=await bling(`/pedidos/vendas/${pedidoId}/gerar-nfce`,{method:"POST"});
        const idNotaFiscal=gerado?.data?.id||gerado?.data?.idNotaFiscal||null;
        if(!idNotaFiscal){
          nfce={erro:"Bling não retornou o ID da NFC-e gerada",detalhe:gerado};
        }else{
          // transmite/autoriza a nota gerada
          try{
            const enviado=await bling(`/nfce/${idNotaFiscal}/enviar`,{method:"POST"});
            let linkDanfe=null;
            try{ const det=await bling(`/nfce/${idNotaFiscal}`); linkDanfe=det?.data?.linkDanfe||det?.data?.linkPDF||null; }catch(e){}
            nfce={ok:true,idNotaFiscal,linkDanfe,detalheEnvio:enviado?.data||null};
          }catch(e){
            // a nota foi gerada mas não foi transmitida — fica "Pendente" no Bling, pode reenviar depois
            nfce={ok:true,idNotaFiscal,erroEnvio:e.message,detalheEnvio:e.body};
          }
        }
      }catch(e){ nfce={erro:e.message,detalhe:e.body}; }
    }

    // se o Bling não devolveu o número na criação, busca em SEGUNDO PLANO (sem travar a resposta)
    // e preenche o movimento da sessão depois — o comprovante já saiu, isso é só pra relatórios.
    if(!numeroPedido){
      (async()=>{
        try{
          const det=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data);
          const num=det?.numero; if(!num) return;
          const dCx=lerCaixaSessoes(); let mudou=false;
          (dCx.sessoes||[]).forEach(s=>(s.movimentos||[]).forEach(m=>{
            if(m.tipo==="venda"&&String(m.pedidoId)===String(pedidoId)&&!m.numero){ m.numero=num; mudou=true; }
          }));
          if(mudou) salvarCaixaSessoes(dCx);
        }catch(e){ console.error("Falha ao buscar numero em 2o plano (ignorado):",e.message); }
      })();
    }

    const respostaVenda={ok:true,pedidoId,numero:numeroPedido,total:totalPedido,nfce,estoqueReposto};
    if(opId) opFinalizarSet(opId,{status:"ok",resposta:respostaVenda,pedidoId:String(pedidoId)});
    res.json(respostaVenda);
  }catch(e){
    if(opId) opFinalizarSet(opId,{status:"erro",erro:e.message});
    res.status(e.status||500).json({erro:e.message,detalhe:e.body});
  }finally{ if(opId) _opsVendaNovaEmAndamento.delete(opId); }
});

// ==================== CAIXA ATACADO ====================
// Caixa pra receber o pagamento de pedidos que JÁ existem (criados pelas vendedoras)
// e ainda não foram atendidos, ou pra vender pra funcionário. Diferente do Frente de
// Caixa: por padrão NÃO emite NFC-e. Ao finalizar, o pedido vai pra ATENDIDO.

// lista os pedidos NÃO ATENDIDOS do sistema (a coluna que fica "escutando")
app.get("/api/caixa-atacado/pedidos-nao-atendidos",async(req,res)=>{
  try{
    // varre as páginas de pedidos de venda recentes e filtra os que ainda estão
    // pendentes de pagamento no caixa. Fora: ATENDIDO, CANCELADO e SEPARADO — este
    // último porque a venda finalizada no caixa atacado agora vai pra SEPARADO, então
    // não pode reaparecer na lista pra ser puxada de novo.
    const dias=Math.min(Number(req.query.dias||30),120);
    const deData=new Date(Date.now()-dias*24*60*60*1000 - 3*60*60*1000).toISOString().slice(0,10);
    const CANCELADO=Number(process.env.SIT_CANCELADO||12);
    const EXCLUIR=new Set([SIT.ATENDIDO, CANCELADO, SIT.SEPARADO].filter(Boolean).map(Number));
    const lista=[];
    for(let pg=1;pg<=20;pg++){
      const r=await bling(`/pedidos/vendas?pagina=${pg}&limite=100&dataInicial=${deData}`);
      const arr=r?.data||[];
      arr.forEach(p=>{
        const sit=Number(p.situacao?.id||0);
        if(!EXCLUIR.has(sit)){
          lista.push({
            id:p.id, numero:p.numero, total:Number(p.total||0),
            data:p.data, situacaoId:sit, situacaoNome:nomeSituacaoFechamento(sit),
            clienteNome:p.contato?.nome||"", contatoId:p.contato?.id||null,
            vendedorId:p.vendedor?.id||null,
          });
        }
      });
      if(arr.length<100) break;
      await sleep(300);
    }
    // mais recentes primeiro
    lista.sort((a,b)=>String(b.data||"").localeCompare(String(a.data||"")));
    res.json({data:lista, total:lista.length});
  }catch(e){ res.status(e.status||500).json({erro:e.message,detalhe:e.body}); }
});

// carrega um pedido pra "abrir na tela" (com itens, pra poder editar antes de finalizar)
// busca um pedido pelo NÚMERO direto no Bling (varre as páginas, já que a API v3
// não filtra por número). Retorna se está atendido (pra tela avisar e não abrir).
app.get("/api/caixa-atacado/buscar-pedido/:numero",async(req,res)=>{
  try{
    const num=String(req.params.numero||"").trim();
    if(!num) return res.status(400).json({erro:"informe o número"});
    const CANCELADO=Number(process.env.SIT_CANCELADO||12);
    const responder=(d)=>{
      const sit=Number(d.situacao?.id||0);
      if(sit===SIT.ATENDIDO) return res.json({achou:true, id:d.id, numero:d.numero, atendido:true, situacaoNome:"Atendido"});
      // SEPARADO = já pago no caixa (nova regra) — não pode ser aberto/puxado de novo
      if(sit===SIT.SEPARADO) return res.json({achou:true, id:d.id, numero:d.numero, atendido:true, situacaoNome:"Separado (já pago no caixa)"});
      if(sit===CANCELADO)    return res.json({achou:true, id:d.id, numero:d.numero, cancelado:true, situacaoNome:"Cancelado"});
      return res.json({achou:true, id:d.id, numero:d.numero, atendido:false, situacaoNome:nomeSituacaoFechamento(sit)});
    };
    // 1) tenta como ID direto do Bling (é o que o código de barras do totem carrega —
    //    o totem gera o barcode CODE128 com o pedidoId). É a via mais rápida.
    if(/^\d+$/.test(num)){
      try{
        const d=await bling(`/pedidos/vendas/${num}`).then(r=>r?.data);
        if(d&&d.id) return responder(d);
      }catch(e){ /* não é um id de pedido — cai pra busca por número */ }
    }
    // 2) tenta pelo NÚMERO do pedido (a API v3 não filtra por número, então varre
    //    páginas). Aumentei o alcance e comparo com numero E numeroLoja.
    let achado=null;
    for(let pag=1;pag<=50 && !achado;pag++){
      let arr=[];
      try{ arr=await bling(`/pedidos/vendas?pagina=${pag}&limite=100`).then(r=>r?.data||[]); }catch(e){ break; }
      achado=arr.find(x=>String(x.numero)===num || String(x.numeroLoja||"")===num)||null;
      if(arr.length<100) break;
      await sleep(300);
    }
    if(!achado) return res.json({achou:false});
    // pega o detalhe (a listagem não traz situação completa em alguns casos)
    try{ const d=await bling(`/pedidos/vendas/${achado.id}`).then(r=>r?.data); if(d) return responder(d); }catch(e){}
    return responder(achado);
  }catch(e){ res.status(e.status||500).json({erro:e.message,detalhe:e.body}); }
});

// DIAGNÓSTICO: lista as situações de pedido de venda cadastradas no Bling (id+nome),
// e mostra a situação atual de um pedido. Ajuda a conferir se os IDs (SIT.*) batem.
// Uso: /api/diag/situacoes  ou  /api/diag/situacoes/PEDIDO_ID
app.get("/api/diag/situacoes/:pedidoId?",async(req,res)=>{
  const out={sitConfigurado:SIT, situacoesBling:null, pedido:null};
  try{
    // o Bling lista as situações por módulo; vendas costuma ser idTipoSituacao=2
    const r=await bling(`/situacoes/modulos`).catch(()=>null);
    out.modulos = r?.data ? r.data.map(m=>({id:m.id, nome:m.nome})) : null;
  }catch(e){ out.erroModulos=e.message; }
  try{
    // tenta listar situações do módulo de vendas (id 2 é o padrão de "Vendas")
    const r=await bling(`/situacoes?idModulo=2`).catch(()=>null);
    out.situacoesBling = r?.data ? r.data.map(s=>({id:s.id, nome:s.nome})) : null;
  }catch(e){ out.erroSituacoes=e.message; }
  if(req.params.pedidoId){
    try{
      const d=await bling(`/pedidos/vendas/${req.params.pedidoId}`).then(r=>r?.data);
      out.pedido = d ? {id:d.id, numero:d.numero, situacaoId:d.situacao?.id, situacaoNome:d.situacao?.nome} : null;
    }catch(e){ out.erroPedido=e.message; }
  }
  res.json(out);
});
app.get("/api/diag/pedido-busca/:cod",async(req,res)=>{
  const cod=String(req.params.cod||"").trim();
  const out={cod, porId:null, porNumeroVarredura:null};
  // tenta por id
  try{
    const d=await bling(`/pedidos/vendas/${cod}`).then(r=>r?.data);
    out.porId = d&&d.id ? {achou:true, id:d.id, numero:d.numero, situacaoId:d.situacao?.id, situacaoNome:d.situacao?.nome} : {achou:false, retorno:d};
  }catch(e){ out.porId={achou:false, erro:e.message}; }
  // varre as primeiras 5 páginas pra ver se acha por numero
  try{
    let ach=null, paginasVarridas=0;
    for(let pag=1;pag<=5 && !ach;pag++){
      const arr=await bling(`/pedidos/vendas?pagina=${pag}&limite=100`).then(r=>r?.data||[]);
      paginasVarridas++;
      ach=arr.find(x=>String(x.numero)===cod || String(x.numeroLoja||"")===cod)||null;
      if(arr.length<100) break;
      await sleep(300);
    }
    out.porNumeroVarredura = ach ? {achou:true, id:ach.id, numero:ach.numero} : {achou:false, paginasVarridas};
    // também mostra alguns números recentes pra referência
    const amostra=await bling(`/pedidos/vendas?pagina=1&limite=5`).then(r=>r?.data||[]);
    out.amostraRecentes=amostra.map(p=>({id:p.id, numero:p.numero, numeroLoja:p.numeroLoja}));
  }catch(e){ out.porNumeroVarredura={erro:e.message}; }
  res.json(out);
});

app.get("/api/caixa-atacado/pedido/:id",async(req,res)=>{
  try{
    const r=await bling(`/pedidos/vendas/${req.params.id}`);
    const d=r?.data; if(!d) return res.status(404).json({erro:"pedido não encontrado"});
    // monta os itens com nome/preço (o detalhe do pedido já traz isso)
    const itens=(d.itens||[]).map(it=>({
      produtoId:it.produto?.id, nome:it.descricao||it.produto?.nome||"",
      quantidade:Number(it.quantidade||0), valor:Number(it.valor||0),
      codigo:it.codigo||"",
    }));
    const situacaoId=Number(d.situacao?.id||0);
    // nome do vendedor que criou o pedido e nome legível do status
    let vendedorNome="Sem vendedor";
    try{ if(d.vendedor?.id) vendedorNome=await nomeVendedor(d.vendedor.id); }catch(e){}
    // pagamentos pro comprovante: usa o histórico local (tem os nomes certos, ex.: "Pix Banco Inter");
    // se não houver, cai pras parcelas do Bling.
    const pagsLocais=lerPag(); const regLocal=pagsLocais[String(d.id)];
    let pagamentos=[];
    if(regLocal && Array.isArray(regLocal.historico) && regLocal.historico.length){
      pagamentos=regLocal.historico.map(h=>({formaNome:h.formaNome||"",valor:Number(h.valor||0)}));
    }else{
      pagamentos=(d.parcelas||[]).map(p=>({formaNome:p.formaPagamento?.nome||"",valor:Number(p.valor||0)}));
    }
    res.json({
      id:d.id, numero:d.numero, situacaoId,
      situacaoNome:nomeSituacaoFechamento(situacaoId),
      vendedorId:d.vendedor?.id||null, vendedorNome,
      clienteNome:d.contato?.nome||"", contatoId:d.contato?.id||null,
      total:Number(d.total||0), desconto:Number(d.desconto?.valor||0),
      outrasDespesas:Number(d.outrasDespesas||0), // taxa de cartão que a vendedora colocou
      frete:Number(d.transporte?.frete||0), // valor do frete do pedido (entrega)
      pagamentos, observacao:d.observacoes||"",
      recebidoPor:recebidoPorDoPedido(d.id).operador,
      itens,
    });
  }catch(e){ res.status(e.status||500).json({erro:e.message,detalhe:e.body}); }
});

// finaliza um pedido EXISTENTE: ajusta itens (se mudou), registra pagamento, move
// pra ATENDIDO, e emite NFC-e só se pedido explicitamente.
// Garante que há estoque suficiente pra cada item da venda. Pra cada produto cujo
// saldo atual seja MENOR que a quantidade vendida, lança uma ENTRADA de estoque só
// do que falta (operacao "E" = entrada, soma ao saldo). Assim a finalização não é
// barrada pelo Bling por saldo insuficiente. Retorna a lista do que foi reposto.
async function garantirEstoqueParaItens(itens){
  const reposto=[];
  if(!Array.isArray(itens)||!itens.length) return reposto;
  // 1) consulta o saldo atual de todos os produtos de uma vez
  const ids=[...new Set(itens.map(i=>Number(i.produtoId)).filter(Boolean))];
  const saldo={};
  for(let i=0;i<ids.length;i+=40){
    const bloco=ids.slice(i,i+40);
    const qs=bloco.map(id=>`idsProdutos[]=${id}`).join("&");
    try{
      const r=await bling(`/estoques/saldos?${qs}`);
      (r?.data||[]).forEach(s=>{ saldo[s.produto?.id]=Number(s.saldoVirtualTotal ?? s.saldoFisicoTotal ?? 0); });
    }catch(e){}
    await sleep(250);
  }
  // 2) pra cada item, se falta, lança a entrada do que falta
  for(const it of itens){
    const pid=Number(it.produtoId); if(!pid) continue;
    const qtd=Number(it.quantidade)||0;
    const atual=Number(saldo[pid] ?? 0);
    const falta=+(qtd-atual).toFixed(3);
    if(falta>0){
      try{
        await bling(`/estoques`,{method:"POST",body:JSON.stringify({
          produto:{id:pid},
          operacao:"E", // entrada — soma ao saldo atual
          quantidade:falta,
          observacoes:`Entrada automática p/ concluir venda no caixa atacado (faltavam ${falta})`,
        })});
        reposto.push({produtoId:pid, nome:it.nome||"", faltava:falta, saldoAntes:atual, qtdVenda:qtd});
        await sleep(300);
      }catch(e){ console.error("Falha ao repor estoque do produto "+pid+":",e.message); }
    }
  }
  return reposto;
}

// Move um pedido pra ATENDIDO de forma robusta. Alguns fluxos do Bling não deixam
// pular direto de "Aguardando separação" pra "Atendido" — exigem passar por SEPARADO
// antes. Esta função tenta direto, confere se mudou de verdade (relendo o pedido), e
// se não mudou, faz a transição em cascata SEPARADO -> ATENDIDO. Retorna {ok, situacaoFinal, caminho}.
// ===================== FINALIZAÇÃO SEGURA (caixa atacado) =====================
// Anti-duplicidade + anti-travamento:
//  - opId (idempotência): a tela manda um id único por tentativa; se a mesma tentativa
//    chegar 2x (retry, clique duplo, F5), o servidor devolve o resultado já pronto
//    em vez de finalizar de novo.
//  - trava por pedido: duas finalizações do MESMO pedido ao mesmo tempo -> a 2ª espera.
//  - registrarVendaNoCaixa: se o pedido já tem um lançamento ativo em QUALQUER caixa,
//    ATUALIZA esse lançamento (com histórico) em vez de criar outro.
const OPS_FINALIZAR_FILE=`${DATA_DIR}/ops_finalizar.json`;
function lerOpsFinalizar(){
  const d=lerJSON(OPS_FINALIZAR_FILE,{}); const lim=Date.now()-48*3600*1000; let mudou=false;
  for(const k of Object.keys(d)){ if((d[k].em||0)<lim){ delete d[k]; mudou=true; } }
  if(mudou) salvarJSON(OPS_FINALIZAR_FILE,d);
  return d;
}
function opFinalizarGet(opId){ if(!opId) return null; return lerOpsFinalizar()[String(opId)]||null; }
function opFinalizarSet(opId,val){ if(!opId) return; const d=lerOpsFinalizar(); const k=String(opId); d[k]={...(d[k]||{em:Date.now()}),...val,atualizadoEm:Date.now()}; salvarJSON(OPS_FINALIZAR_FILE,d); }
const _pedidosEmFinalizacao=new Map(); // pedidoId -> {opId, desde}

const _fmtItem=(i)=>`${Number(i.quantidade)}x ${i.nome||("produto "+i.produtoId)}`;
// compara itens (antes x depois) por produtoId -> {mudou, retirados, acrescentados, alterados, de, para}
function diffItens(antes, depois){
  const A={}, D={};
  (antes||[]).forEach(i=>{ if(i.produtoId) A[String(i.produtoId)]={...i,quantidade:Number(i.quantidade),valor:Number(i.valor)}; });
  (depois||[]).forEach(i=>{ if(i.produtoId) D[String(i.produtoId)]={...i,quantidade:Number(i.quantidade),valor:Number(i.valor)}; });
  const retirados=[], acrescentados=[], alterados=[];
  for(const k of Object.keys(A)){ if(!D[k]) retirados.push({produtoId:k,nome:A[k].nome||"",quantidade:A[k].quantidade,valor:A[k].valor}); }
  for(const k of Object.keys(D)){
    if(!A[k]){ acrescentados.push({produtoId:k,nome:D[k].nome||"",quantidade:D[k].quantidade,valor:D[k].valor}); continue; }
    const a=A[k], d=D[k];
    if(a.quantidade!==d.quantidade || Math.abs(a.valor-d.valor)>0.001){
      alterados.push({produtoId:k,nome:d.nome||a.nome||"",de:{quantidade:a.quantidade,valor:a.valor},para:{quantidade:d.quantidade,valor:d.valor}});
    }
  }
  const mudou=retirados.length>0||acrescentados.length>0||alterados.length>0;
  return { mudou, retirados, acrescentados, alterados,
    de:(antes||[]).map(_fmtItem).join(", "), para:(depois||[]).map(_fmtItem).join(", ") };
}
// texto legível (vai na observação do Bling) do que mudou nos itens
function blocoHistoricoItens(diff, quem, autorizadoPor){
  const quando=new Date().toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo",day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"});
  const fmt=(v)=>Number(v||0).toFixed(2);
  return [
    `[Alteração de itens ${quando} — por ${quem||"—"}${autorizadoPor?", autoriz. "+autorizadoPor:""}]`,
    `Retirou: ${diff.retirados.length?diff.retirados.map(_fmtItem).join(" · "):"—"}`,
    `Acrescentou: ${diff.acrescentados.length?diff.acrescentados.map(_fmtItem).join(" · "):"—"}`,
    `Alterou: ${diff.alterados.length?diff.alterados.map(a=>`${a.nome}: ${a.de.quantidade}x ${fmt(a.de.valor)} → ${a.para.quantidade}x ${fmt(a.para.valor)}`).join(" · "):"—"}`,
  ].join("\n");
}
// grava o histórico de itens no log do pedido (Central e Gestão de Caixas leem daqui)
function registrarHistoricoItens(pedidoId, diff, funcionarioId, funcNome, autorizadoPor){
  try{
    const id=String(pedidoId);
    addLog(id,"itens_alterados_caixa",funcionarioId,funcNome,{autorizadoPor:autorizadoPor||"",de:diff.de,para:diff.para,
      retirados:diff.retirados.map(_fmtItem),acrescentados:diff.acrescentados.map(_fmtItem),
      alterados:diff.alterados.map(a=>`${a.nome}: ${a.de.quantidade}x→${a.para.quantidade}x`)});
    if(diff.retirados.length) addLog(id,"itens_retirados",funcionarioId,funcNome,{itens:diff.retirados.map(i=>i.nome||("produto "+i.produtoId)),detalhe:diff.retirados.map(_fmtItem)});
    if(diff.acrescentados.length) addLog(id,"itens_acrescentados",funcionarioId,funcNome,{itens:diff.acrescentados.map(i=>i.nome||("produto "+i.produtoId))});
  }catch(e){}
}
// registra (ou ATUALIZA, se já existir) a venda no caixa — nunca cria 2 lançamentos
// ativos pro mesmo pedido, em nenhum caixa
function registrarVendaNoCaixa(dCx, sessaoAlvo, mov, opts={}){
  const idStr=String(mov.pedidoId||"");
  const fmt=(v)=>Number(v||0).toFixed(2);
  const descPag=(m)=>`total ${fmt(m.total)} · ${(m.pagamentos||[]).map(p=>`${p.formaNome}: ${fmt(p.valor)}`).join(" · ")||"—"}`;
  if(idStr){
    for(const s of (dCx.sessoes||[])){
      const ex=(s.movimentos||[]).find(m=>m.tipo==="venda"&&!m.cancelado&&String(m.pedidoId)===idStr);
      if(!ex) continue;
      const alts=[];
      if(opts.itensDiff&&opts.itensDiff.mudou){
        alts.push({em:Date.now(),tipo:"itens",por:opts.por||mov.operador||"",autorizadoPor:opts.autorizadoPor||"",de:opts.itensDiff.de,para:opts.itensDiff.para,
          retirados:opts.itensDiff.retirados.map(_fmtItem),acrescentados:opts.itensDiff.acrescentados.map(_fmtItem),
          alterados:opts.itensDiff.alterados.map(a=>`${a.nome}: ${a.de.quantidade}x ${fmt(a.de.valor)} → ${a.para.quantidade}x ${fmt(a.para.valor)}`)});
      }
      const antesPag=descPag(ex), depoisPag=descPag(mov);
      if(antesPag!==depoisPag) alts.push({em:Date.now(),tipo:"refinalizado",por:opts.por||mov.operador||"",de:antesPag,para:depoisPag,
        caixaOriginal:s.operador||"",caixaAgora:sessaoAlvo?.operador||""});
      Object.assign(ex,{ total:mov.total, itens:mov.itens, pagamentos:mov.pagamentos, outrasDespesas:mov.outrasDespesas, frete:mov.frete,
        clienteNome:mov.clienteNome||ex.clienteNome, alterado:true, alteracoes:[...(ex.alteracoes||[]),...alts], ultimaFinalizacaoEm:Date.now(),
        ...(mov.valorMenor?{valorMenor:mov.valorMenor}:{}) });
      if(s.fechadaEm&&s.resumoFinal){ try{ s.resumoFinal=resumoSessaoCaixa(s); }catch(e){} }
      return { duplicadoEvitado:true, sessao:s, movimento:ex, mesmaSessao:sessaoAlvo&&s.id===sessaoAlvo.id };
    }
  }
  sessaoAlvo.movimentos=sessaoAlvo.movimentos||[];
  sessaoAlvo.movimentos.push(mov);
  return { duplicadoEvitado:false, sessao:sessaoAlvo, movimento:mov, mesmaSessao:true };
}
// NFC-e em SEGUNDO PLANO: não segura a resposta do caixa (SEFAZ pode demorar).
// Resultado vai pro registro de NFC-e emitidas (Gestão de NFC-e); falha vira Aviso.
function emitirNfceEmSegundoPlano(pedidoId, numero, operador){
  (async()=>{
    try{
      const emitidas=lerNfceEmitidas();
      if(emitidas[String(pedidoId)]) return;
      const gerado=await bling(`/pedidos/vendas/${pedidoId}/gerar-nfce`,{method:"POST"});
      const idNotaFiscal=gerado?.data?.id||gerado?.data?.idNotaFiscal||null;
      if(!idNotaFiscal) throw new Error("Bling não retornou o ID da NFC-e");
      let link=null, envioErro=null, numeroNota=null;
      try{
        await bling(`/nfce/${idNotaFiscal}/enviar`,{method:"POST"});
        try{ const det=await bling(`/nfce/${idNotaFiscal}`); link=det?.data?.linkDanfe||det?.data?.linkPDF||null; numeroNota=det?.data?.numero||null; }catch(e){}
      }catch(e){ envioErro=e.message; }
      const em2=lerNfceEmitidas();
      em2[String(pedidoId)]={ idNotaFiscal, numeroNota, link, em:Date.now(), por:operador||"", envioErro:envioErro||null, origem:"caixa_atacado_auto" };
      salvarNfceEmitidas(em2);
      if(envioErro) registrarAviso({tipo:"nfce_nao_transmitida",titulo:`NFC-e do pedido #${numero||pedidoId} gerada mas não transmitida`,pedidoId:String(pedidoId),numero,operador,origem:"Caixa Atacado",erroBling:envioErro,fingerprint:`nfce-env-${pedidoId}`,oQueFazer:`Abra a Gestão de NFC-e (ou o Bling) e reenvie a NFC-e do pedido #${numero||pedidoId}.`});
    }catch(e){
      registrarAviso({tipo:"nfce_falhou",titulo:`NFC-e do pedido #${numero||pedidoId} não foi emitida`,pedidoId:String(pedidoId),numero,operador,origem:"Caixa Atacado",erroBling:e.message,fingerprint:`nfce-falha-${pedidoId}`,oQueFazer:`A venda foi concluída normalmente; só a NFC-e falhou. Emita pela Gestão de NFC-e (botão "O que falta pra emitir" ajuda a ver o problema fiscal).`});
    }
  })();
}
// restaura a situação de um pedido depois de uma edição, com RETRY quando o Bling
// reclama de estoque (ele estorna o estoque ao destravar e pode demorar pra
// processar antes de aceitar a re-baixa). Se mesmo assim faltar, repõe o que falta.
async function _restaurarSituacaoComRetry(id, alvo, itensParaEstoque){
  const patch=(s)=>bling(`/pedidos/vendas/${id}/situacoes/${s}`,{method:"PATCH"});
  const caminho = alvo===SIT.ATENDIDO?[SIT.EM_SEP,SIT.SEPARADO,SIT.ATENDIDO] : alvo===SIT.SEPARADO?[SIT.EM_SEP,SIT.SEPARADO] : [alvo];
  for(const s of caminho.slice(0,-1)){ if(!s) continue; try{ await patch(s); }catch(e){} await sleep(350); }
  const final=caminho[caminho.length-1];
  const esperas=[400,2000,4000,6000];
  let reposto=[], ultimoErro=null;
  for(let t=0;t<esperas.length;t++){
    await sleep(esperas[t]);
    try{ await patch(final); return {ok:true, reposto, tentativas:t+1}; }
    catch(e){
      ultimoErro=e;
      const ehEstoque=/estoque|saldo/i.test(e.message||"")||/estoque|saldo/i.test(JSON.stringify(e.body||{}));
      if(ehEstoque && itensParaEstoque && !reposto.length && t>=1){ try{ reposto=await garantirEstoqueParaItens(itensParaEstoque); }catch(e2){} }
    }
  }
  return {ok:false, erro:ultimoErro?.message, reposto};
}

// Move um pedido pra ATENDIDO (caminhando por Separado), com o mínimo de chamadas e
// retry pra estoque. opts.sitConhecida evita 1 GET; opts.itensParaEstoque permite repor.
async function moverPedidoParaAtendido(pedidoId, opts={}){
  const lerSit=async()=>{ try{ const d=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data); return Number(d?.situacao?.id||0); }catch(e){ return 0; } };
  const patch=async(sitId)=>{ await bling(`/pedidos/vendas/${pedidoId}/situacoes/${sitId}`,{method:"PATCH"}); };
  const caminho=[]; let reposto=[];
  let sitAtual=opts.sitConhecida?Number(opts.sitConhecida):await lerSit();
  if(sitAtual===SIT.ATENDIDO) return {ok:true, situacaoFinal:SIT.ATENDIDO, caminho:["já estava atendido"], reposto};
  // REGRA DO NEGÓCIO: sempre passa por SEPARADO antes de ATENDIDO
  if(sitAtual!==SIT.SEPARADO){
    try{ await patch(SIT.SEPARADO); caminho.push("→ Separado"); }
    catch(e){
      caminho.push("falhou → Separado: "+e.message);
      try{ await patch(SIT.EM_SEP); caminho.push("→ Em separação"); await sleep(400); await patch(SIT.SEPARADO); caminho.push("→ Separado (após Em separação)"); }
      catch(e2){ caminho.push("falhou cascata Separado: "+e2.message); }
    }
    await sleep(400);
  }
  const esperas=[0,2000,4000];
  let ok=false;
  for(let t=0;t<esperas.length&&!ok;t++){
    if(esperas[t]) await sleep(esperas[t]);
    try{ await patch(SIT.ATENDIDO); caminho.push("→ Atendido"); ok=true; }
    catch(e){
      caminho.push("falhou → Atendido: "+e.message);
      const ehEstoque=/estoque|saldo/i.test(e.message||"")||/estoque|saldo/i.test(JSON.stringify(e.body||{}));
      if(ehEstoque && opts.itensParaEstoque && !reposto.length){
        try{ reposto=await garantirEstoqueParaItens(opts.itensParaEstoque); if(reposto.length) caminho.push("estoque reposto: "+reposto.map(r=>(r.nome||r.produtoId)+" +"+r.faltava).join(", ")); }catch(e2){}
      }
    }
  }
  await sleep(300);
  const novo=await lerSit();
  return {ok:novo===SIT.ATENDIDO, situacaoFinal:novo, caminho, reposto};
}

// Move um pedido pra SEPARADO de forma robusta (com cascata EM_SEP -> SEPARADO se o
// Bling exigir, e conferindo se realmente mudou). Retorna {ok, situacaoFinal, caminho}.
async function moverPedidoParaSeparado(pedidoId){
  const lerSit=async()=>{ try{ const d=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data); return Number(d?.situacao?.id||0); }catch(e){ return 0; } };
  const patch=async(sitId)=>{ await bling(`/pedidos/vendas/${pedidoId}/situacoes/${sitId}`,{method:"PATCH"}); };
  const caminho=[];
  let sitAtual=await lerSit();
  if(sitAtual===SIT.SEPARADO) return {ok:true, situacaoFinal:SIT.SEPARADO, caminho:["já estava separado"]};

  // tentativa 1: direto pra SEPARADO
  try{ await patch(SIT.SEPARADO); caminho.push("→ Separado"); }catch(e){ caminho.push("falhou direto: "+e.message); }
  await sleep(400);
  let novo=await lerSit();
  if(novo===SIT.SEPARADO) return {ok:true, situacaoFinal:novo, caminho};

  // tentativa 2: cascata — passa por EM_SEP e depois SEPARADO
  try{
    if(novo!==SIT.EM_SEP){ await patch(SIT.EM_SEP); caminho.push("→ Em separação"); await sleep(500); }
    await patch(SIT.SEPARADO); caminho.push("→ Separado (após Em separação)"); await sleep(400);
  }catch(e){ caminho.push("falhou cascata: "+e.message); }
  novo=await lerSit();
  return {ok:novo===SIT.SEPARADO, situacaoFinal:novo, caminho};
}

// escolhe e executa a transição de status conforme o statusFinal pedido pela tela
// ('atendido' ou 'separado'). Default: atendido (compatibilidade).
async function moverPedidoParaStatusFinal(pedidoId, statusFinal){
  if(statusFinal==="separado") return moverPedidoParaSeparado(pedidoId);
  return moverPedidoParaAtendido(pedidoId);
}

// status de uma finalização (a tela consulta aqui quando a resposta demora — em vez
// de desistir e o operador clicar de novo)
app.get("/api/caixa-atacado/finalizar/status/:opId",(req,res)=>{
  const op=opFinalizarGet(req.params.opId);
  if(!op) return res.json({status:"desconhecido"});
  if(op.status==="em_andamento" && op.pedidoId && !_pedidosEmFinalizacao.has(String(op.pedidoId)) && (Date.now()-(op.atualizadoEm||op.em||0))>3*60*1000){
    return res.json({status:"erro",erro:"A finalização foi interrompida (servidor reiniciou?). Confira no Bling e, se preciso, finalize de novo."});
  }
  res.json({status:op.status, resposta:op.resposta||null, erro:op.erro||null});
});

app.post("/api/caixa-atacado/finalizar",async(req,res)=>{
  const {pedidoId,itens,pagamentos,emitirNfce,funcionarioId,clienteNome,observacao,statusFinal,taxaCredito,outrasDespesasBase,freteBase}=req.body||{};
  const opId=req.body?.opId?String(req.body.opId):null;
  if(!pedidoId) return res.status(400).json({erro:"informe o pedido"});
  if(!Array.isArray(pagamentos)||!pagamentos.length) return res.status(400).json({erro:"Informe ao menos uma forma de pagamento"});
  const chave=String(pedidoId);
  // ---- idempotência: mesma tentativa chegando 2x devolve o resultado pronto ----
  if(opId){
    const op=opFinalizarGet(opId);
    if(op?.status==="ok") return res.json({...op.resposta, repetido:true});
    if(op?.status==="em_andamento" && _pedidosEmFinalizacao.has(chave)) return res.status(202).json({emAndamento:true,opId});
  }
  // ---- trava por pedido: nunca 2 finalizações do mesmo pedido ao mesmo tempo ----
  if(_pedidosEmFinalizacao.has(chave)){
    const em=_pedidosEmFinalizacao.get(chave);
    return res.status(409).json({emAndamento:true, opId:em.opId||null, erro:"Este pedido já está sendo finalizado. Aguarde a conclusão."});
  }
  _pedidosEmFinalizacao.set(chave,{opId,desde:Date.now()});
  if(opId) opFinalizarSet(opId,{status:"em_andamento",pedidoId:chave});
  try{
    const funcNome=(lerJSON(FUNC_FILE,{})[funcionarioId]?.nome)||"—";
    const temItens=Array.isArray(itens)&&itens.length;
    const temObs=observacao&&String(observacao).trim();

    // 1) lê o pedido UMA vez (todo o resto reaproveita)
    let ped=null; try{ ped=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data); }catch(e){}
    if(!ped) throw Object.assign(new Error("Pedido não encontrado no Bling."),{status:404});
    const sitInicial=Number(ped.situacao?.id||0);
    if(sitInicial===SIT.CANCELADO) throw Object.assign(new Error("Este pedido está CANCELADO no Bling e não pode ser finalizado."),{status:400});
    const itensBling=(ped.itens||[]).map(i=>({produtoId:i.produto?.id,nome:i.descricao||"",quantidade:Number(i.quantidade),valor:Number(i.valor)}));
    const itensEfetivos=temItens?itens:itensBling;

    // 2) o que mudou nos itens (pra histórico) — e se precisa regravar
    const diff=temItens?diffItens(itensBling,itens):{mudou:false,retirados:[],acrescentados:[],alterados:[],de:"",para:""};
    const itensMudaram=diff.mudou;

    // 3) estoque: 1 chamada de saldos + entrada só do que faltar (barato)
    let estoqueReposto=[];
    try{ estoqueReposto=await garantirEstoqueParaItens(itensEfetivos); }catch(e){ console.error("garantirEstoque:",e.message); }

    // 4) parcelas, despesas e observação
    const parcelasBling=pagamentos.filter(p=>p.formaId&&Number(p.valor)>0).map(p=>({formaId:Number(p.formaId),valor:+Number(p.valor).toFixed(2)}));
    const taxaAdd=Number(taxaCredito||0);
    const despesasTotal=+(Number(outrasDespesasBase||0)+taxaAdd).toFixed(2);
    const outrasDespesasFinal = taxaAdd>0 ? despesasTotal : (ped.outrasDespesas!=null?Number(ped.outrasDespesas):null);
    const blocos=[]; if(temObs) blocos.push(String(observacao).trim()); if(itensMudaram) blocos.push(blocoHistoricoItens(diff,funcNome,null));
    const obsExtra=blocos.length?blocos.join("\n"):null;

    // 5) grava no Bling em UM PUT (itens+parcelas+obs+despesas), destravando se preciso
    let avisoBling=null, sitDepoisPut=sitInicial;
    if(itensMudaram){
      const r=await atualizarItensBling(pedidoId, itens.map(i=>({produtoId:i.produtoId,quantidade:i.quantidade,valor:i.valor})), obsExtra, {ped, parcelas:parcelasBling, outrasDespesas:outrasDespesasFinal, itensParaEstoque:itensEfetivos});
      if(!r?.ok){
        let m=r?.erro||"erro";
        if(/estoque|saldo/i.test(m)) m="O Bling barrou por estoque insuficiente em um ou mais produtos, mesmo após tentar repor. NADA foi finalizado. Confira o estoque no Bling e tente de novo.";
        throw Object.assign(new Error("Não consegui salvar as alterações no Bling: "+m),{status:502});
      }
      if(r.reposto?.length) estoqueReposto=[...estoqueReposto,...r.reposto];
      sitDepoisPut=r.situacaoFinal||sitInicial;
    } else if(parcelasBling.length){
      const rp=await atualizarParcelasBling(pedidoId, parcelasBling, {append:false, obsExtra, ped, outrasDespesas:outrasDespesasFinal});
      if(!rp?.ok){
        avisoBling="As formas de pagamento não foram gravadas no Bling ("+(rp?.erro||"erro")+"). O caixa registrou a venda; confira o pedido no Bling.";
        registrarAviso({tipo:"pagamento_nao_gravado_bling",titulo:`Pedido #${ped.numero||pedidoId}: formas de pagamento não gravadas no Bling`,pedidoId:chave,numero:ped.numero,operador:funcNome,origem:"Caixa Atacado",erroBling:rp?.erro||"",fingerprint:`pagbling-${chave}-${Date.now()}`,oQueFazer:`No Bling, abra o pedido #${ped.numero||pedidoId} e confira as formas de pagamento: ${pagamentos.map(p=>`${p.formaNome}: ${Number(p.valor).toFixed(2)}`).join(", ")}.`});
      } else if(rp.restauracao?.reposto?.length){ estoqueReposto=[...estoqueReposto,...rp.restauracao.reposto]; }
    }

    // 6) registros locais (pagamento + caixa, sem duplicar)
    const totalItens=+itensEfetivos.reduce((s,i)=>s+Number(i.valor)*Number(i.quantidade),0).toFixed(2);
    const _outras=despesasTotal, _frete=+Number(freteBase||0).toFixed(2);
    const totalPagar=+(totalItens+_outras+_frete).toFixed(2);
    const valorPago=+pagamentos.reduce((s,p)=>s+Number(p.valor),0).toFixed(2);
    const pags=lerPag();
    pags[chave]={ pedidoId:chave, valorPago, valorPedido:totalPagar,
      historico:pagamentos.map(p=>({em:Date.now(),valor:+Number(p.valor).toFixed(2),formaNome:p.formaNome||"",tipo:"caixa_atacado"})),
      statusPagamento:valorPago>=totalPagar-0.05?"pago":(valorPago>0?"parcial":"pendente") };
    salvarJSON(PAG_FILE,pags);
    let jaEstavaNoCaixa=null;
    try{
      const dCx=lerCaixaSessoes();
      const sessaoAtual=(dCx.sessoes||[]).find(s=>!s.fechadaEm&&String(s.funcionarioId)===String(funcionarioId)&&(s.tipoCaixa||"frente")==="atacado");
      if(sessaoAtual){
        const _menor=(req.body.autorizouMenor&&Number(req.body.autorizouMenor.falta)>0)?{faltou:+Number(req.body.autorizouMenor.falta).toFixed(2),autorizadoPor:req.body.autorizouMenor.autorizadoPor||"—"}:null;
        const mov={ tipo:"venda", em:Date.now(), pedidoId, numero:req.body.numero||ped.numero||null,
          total:totalPagar, clienteNome:clienteNome||ped.contato?.nome||"", origem:"caixa_atacado",
          outrasDespesas:_outras, frete:_frete, operador:sessaoAtual.operador||"",
          ...(_menor?{valorMenor:_menor}:{}),
          itens:itensEfetivos.map(i=>({produtoId:i.produtoId,nome:i.nome||"",quantidade:i.quantidade,valor:i.valor,modoPreco:i.modoPreco||null})),
          pagamentos:pagamentos.map(p=>({formaNome:p.formaNome||"",valor:+Number(p.valor).toFixed(2)})) };
        const reg=registrarVendaNoCaixa(dCx, sessaoAtual, mov, {itensDiff:itensMudaram?diff:null, por:funcNome});
        salvarCaixaSessoes(dCx);
        if(reg.duplicadoEvitado) jaEstavaNoCaixa={operador:reg.sessao.operador||"", quando:reg.movimento.em, mesmaSessao:!!reg.mesmaSessao};
        if(_menor) addLog(chave,"fechado_valor_menor",funcionarioId,funcNome,{faltou:_menor.faltou,autorizadoPor:_menor.autorizadoPor});
      } else {
        avisoBling=(avisoBling?avisoBling+" ":"")+"Você não tem um caixa ATACADO aberto — a venda foi salva no Bling e no pagamento, mas não entrou em nenhum caixa.";
      }
    }catch(e){ console.error("Falha ao vincular ao caixa:",e.message); }
    if(itensMudaram) registrarHistoricoItens(chave, diff, funcionarioId, funcNome, null);

    // 7) situação final (Atendido, passando por Separado)
    const alvo=statusFinal==="separado"?"Separado":"Atendido";
    let avisoAtendido=null;
    try{
      const rMov=statusFinal==="separado"
        ? await moverPedidoParaSeparado(pedidoId)
        : await moverPedidoParaAtendido(pedidoId,{sitConhecida:sitDepoisPut, itensParaEstoque:itensEfetivos});
      console.log("Transição do pedido "+pedidoId+" (alvo "+alvo+"):",JSON.stringify(rMov.caminho));
      if(rMov.reposto?.length) estoqueReposto=[...estoqueReposto,...rMov.reposto];
      if(!rMov.ok){
        avisoAtendido="O pagamento foi registrado, mas não consegui mudar a situação do pedido pra "+alvo+" (ficou em "+nomeSituacao(rMov.situacaoFinal)+"). Verifique no Bling.";
        registrarAviso({tipo:"situacao_nao_movida",titulo:`Pedido #${ped.numero||pedidoId} não foi pra ${alvo}`,pedidoId:chave,numero:ped.numero,operador:funcNome,origem:"Caixa Atacado",erroBling:(rMov.caminho||[]).join(" | "),fingerprint:`sit-${chave}-${Date.now()}`,oQueFazer:`Abra o pedido #${ped.numero||pedidoId} no Bling e mude a situação pra ${alvo} manualmente.`});
      }
    }catch(e){ avisoAtendido="O pagamento foi registrado, mas não consegui mudar a situação do pedido pra "+alvo+" ("+e.message+"). Verifique no Bling."; }

    if(estoqueReposto.length){
      registrarAviso({tipo:"estoque_reposto_auto",titulo:`Pedido #${ped.numero||pedidoId}: estoque reposto automaticamente`,pedidoId:chave,numero:ped.numero,operador:funcNome,origem:"Caixa Atacado",
        fingerprint:`repo-${chave}-${_hojeISO()}`, estoqueAjustado:estoqueReposto.map(r=>`${r.nome||("produto "+r.produtoId)} +${r.faltava}`).join(", "),
        oQueFazer:"A entrada de estoque foi lançada só pra o Bling deixar concluir a venda. Confira no Bling se o saldo desses produtos está certo."});
    }

    // 8) NFC-e em SEGUNDO PLANO (não segura o caixa)
    let nfce=null;
    if(emitirNfce){ emitirNfceEmSegundoPlano(pedidoId, ped.numero, funcNome); nfce={pendente:true}; }

    const resposta={ ok:true, pedidoId, numero:ped.numero||null, total:totalItens, nfce,
      aviso:[avisoAtendido,avisoBling].filter(Boolean).join(" ")||null, estoqueReposto, jaEstavaNoCaixa,
      itensAlterados:itensMudaram?{retirados:diff.retirados.map(_fmtItem),acrescentados:diff.acrescentados.map(_fmtItem),alterados:diff.alterados.map(a=>`${a.nome}: ${a.de.quantidade}x→${a.para.quantidade}x`)}:null };
    if(opId) opFinalizarSet(opId,{status:"ok",resposta});
    res.json(resposta);
  }catch(e){
    if(opId) opFinalizarSet(opId,{status:"erro",erro:e.message});
    res.status(e.status||500).json({erro:e.message,detalhe:e.body});
  }finally{ _pedidosEmFinalizacao.delete(chave); }
});

app.post("/api/pedido",async(req,res)=>{
  try{ const {contatoId,itens}=req.body;
    if(!contatoId||!Array.isArray(itens)||!itens.length) return res.status(400).json({erro:"Envie { contatoId, itens }"});
    const payload={contato:{id:Number(contatoId)},itens:itens.map(i=>({produto:{id:Number(i.produtoId)},quantidade:Number(i.quantidade),valor:Number(i.valor)}))};
    res.json(await bling(`/pedidos/vendas`,{method:"POST",body:JSON.stringify(payload)}));
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// Finaliza: concilia contato por CPF/CNPJ (cria se não existir) e gera o pedido de venda
app.post("/api/finalizar", rateLimit({janelaMs:60000,max:5,prefixo:"finalizar"}), async (req, res) => {
  try {
    const { documento, itens, entrega, cadastro } = req.body || {};
    const doc = soDigitos(documento);
    if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ erro: "itens vazios" });
    // SEGURANÇA: valida a entrada antes de qualquer coisa (a tela é pública).
    // Limita o número de itens e valida cada um (produto válido + quantidade sã),
    // pra ninguém conseguir criar pedido gigante/malformado no Bling.
    if (itens.length > 200) return res.status(400).json({ erro: "pedido com itens demais" });
    for (const it of itens) {
      const q = Number(it.quantidade);
      if (!it.produtoId || !Number.isFinite(q) || q <= 0 || q > 100000 || Math.floor(q) !== q) {
        return res.status(400).json({ erro: "item inválido no pedido" });
      }
    }
    // limita o tamanho dos campos de texto livres (evita abuso/poluição no Bling)
    const lim = (s, n) => (typeof s === "string" ? s.slice(0, n) : s);
    const nome = lim(req.body?.nome, 120), email = lim(req.body?.email, 120), telefone = lim(req.body?.telefone, 30);
    if (doc && (doc.length !== 11 && doc.length !== 14)) return res.status(400).json({ erro: "documento inválido" });
    // SEGURANÇA: a taxa de entrega vem do cliente — nunca deixa ser negativa (baixaria
    // o total) nem absurda. Limita a um teto razoável. (O ideal seria recalcular no
    // servidor; por ora, sanitiza pra impedir manipulação óbvia do total.)
    if (entrega && typeof entrega === "object") {
      const t = Number(entrega.taxa);
      entrega.taxa = (Number.isFinite(t) && t >= 0) ? Math.min(t, 1000) : 0;
    }

    // 1) resolve o contato: por documento (identificado) ou contato padrão (sem identificação)
    let contatoId = null, criouContato = false;
    if (doc) {
      const busca = await bling(`/contatos?pesquisa=${encodeURIComponent(doc)}`);
      const achado = (busca.data || []).find((c) => soDigitos(c.numeroDocumento) === doc);
      if (achado) {
        contatoId = achado.id;
        // busca o contato completo para saber o que já tem preenchido
        await new Promise(r=>setTimeout(r,350));
        let contatoAtual={};
        try{ const ca=await bling(`/contatos/${contatoId}`); contatoAtual=ca?.data||{}; }catch(e){}
        const endAtual=contatoAtual.endereco?.geral||{};
        const end=cadastro?.endereco||{};

        // atualiza dados do cliente com as informações fornecidas no totem
        const atualizacao={};
        if(telefone) {
          const telFmt=formatarTelefoneBling(telefone);
          if(telFmt){ atualizacao.celular=telFmt; atualizacao.telefone=telFmt; }
        }
        if(email && /\S+@\S+\.\S+/.test(email) && !contatoAtual.email) atualizacao.email=email;

        // endereço: atualiza campos que estão vazios no Bling mas foram preenchidos no totem
        const endNovo={
          endereco: end.rua || endAtual.endereco || "",
          numero:   end.numero || endAtual.numero || "S/N",
          complemento: end.complemento || endAtual.complemento || "",
          bairro:   end.bairro || endAtual.bairro || "",
          cep:      soDigitos(end.cep||endAtual.cep||""),
          municipio:end.cidade || endAtual.municipio || "",
          uf:       end.uf || endAtual.uf || "MG",
          pais:     "Brasil",
        };
        // só atualiza endereço se tem alguma informação nova
        if(end.rua || end.cep || end.cidade){
          atualizacao.endereco={ geral: endNovo };
        }

        if(Object.keys(atualizacao).length){
          try{
            // PUT exige objeto completo — mescla com dados atuais
            const putBody={
              nome: atualizacao.nome||contatoAtual.nome||nome||"",
              situacao: contatoAtual.situacao||"A",
              tipo: contatoAtual.tipo||"F",
              numeroDocumento: contatoAtual.numeroDocumento||doc||"",
              celular: atualizacao.celular||contatoAtual.celular||"",
              telefone: atualizacao.telefone||contatoAtual.telefone||"",
              email: atualizacao.email||contatoAtual.email||"",
              endereco: atualizacao.endereco||contatoAtual.endereco||undefined,
            };
            await bling(`/contatos/${contatoId}`,{method:"PUT",body:JSON.stringify(putBody)});
            console.log("Contato atualizado:", contatoId, Object.keys(atualizacao));
            await new Promise(r=>setTimeout(r,400));
          }catch(e){ console.error("Erro ao atualizar contato (ignorado):", e.message); }
        }
      } else {
        const tipo = doc.length === 14 ? "J" : "F";
        const end = cadastro?.endereco || {};
        const contato = {
          nome: nome || ("Cliente " + doc),
          tipo, numeroDocumento: doc, situacao: "A",
          telefone: formatarTelefoneBling(telefone), celular: formatarTelefoneBling(telefone),
          email: (email && /\S+@\S+\.\S+/.test(email)) ? email : undefined,
          endereco: { geral: {
            endereco: end.rua || "",
            numero: end.numero || "S/N",
            complemento: end.complemento || "",
            bairro: end.bairro || "",
            cep: soDigitos(end.cep||""),
            municipio: end.cidade || "",
            uf: end.uf || "MG", // fallback MG
            pais: "Brasil",
          } },
        };
        const novo = await bling(`/contatos`, { method: "POST", body: JSON.stringify(contato) });
        contatoId = novo?.data?.id; criouContato = true;
      }
    } else {
      contatoId = await getContatoPadrao();
    }
    if (!contatoId) return res.status(500).json({ erro: "não foi possível obter/criar o contato no Bling" });

    // 2) cria o pedido de venda
    const obs = `Pedido via Totem/App B13. Cliente: ${nome || "-"} (${telefone || "-"}). ` + (entrega && entrega.tipo === "entrega"
      ? `ENTREGA — ${entrega.endereco || ""} (taxa ${brlN(entrega.taxa || 0)})`
      : "RETIRADA na loja");
    const hoje = new Date(Date.now() - 3*3600*1000).toISOString().slice(0,10); // data de hoje (BRT), formato AAAA-MM-DD
    // valor total (itens + frete se for entrega) pra usar na parcela obrigatória do Bling
    // SEGURANÇA: o preço NÃO pode vir do cliente (manipulável). Usa o preço oficial
    // da tabela de atacado (indexado por produtoId). Se não achar, mantém o enviado
    // mas registra — nunca deixa o cliente comprar por um valor arbitrário.
    const _idxCod=indexarVinculosTabela();
    const _precoPorProduto={};
    Object.values(_idxCod).forEach(v=>{ if(v.produtoId!=null) _precoPorProduto[String(v.produtoId)]=Number(v.precoAtacado)||0; });
    // SEGURANÇA: só aceita produtos que existem na tabela oficial com preço válido.
    // O preço SEMPRE vem do servidor (nunca do cliente). Produto que não está na
    // tabela é descartado — assim ninguém injeta um produtoId qualquer com preço
    // arbitrário. Se sobrar nenhum item válido, recusa o pedido.
    const itensSeguros=itens
      .map(i=>{
        const precoOficial=_precoPorProduto[String(i.produtoId)];
        if(!(precoOficial!=null && precoOficial>0)) return null; // fora da tabela → descarta
        return { produtoId:i.produtoId, descricao:i.descricao, quantidade:Number(i.quantidade), valor:precoOficial };
      })
      .filter(Boolean);
    if(!itensSeguros.length) return res.status(400).json({ erro: "nenhum item válido no pedido" });
    const totalItensCalc=itensSeguros.reduce((s,i)=>s+Number(i.quantidade)*Number(i.valor),0);
    const freteCalc=(entrega&&entrega.tipo==="entrega")?(Number(entrega.taxa)||0):0;
    const totalPedidoCalc=+(totalItensCalc+freteCalc).toFixed(2);
    // usa "Ficha Financeira" como forma de pagamento da parcela — não é usada de
    // verdade na loja, então serve de marcador claro de "ainda não foi pago de
    // fato" pra quem olhar direto no Bling (diferente de "Dinheiro", que é comum)
    const formaFichaFinanceira=await getFormaPagamentoIdPorNome("ficha financeira");
    console.log("[totem] forma 'Ficha Financeira' encontrada:", formaFichaFinanceira);
    const payload = {
      data: hoje,
      contato: { id: Number(contatoId) },
      itens: itensSeguros.map((i) => ({ produto: { id: Number(i.produtoId) }, quantidade: Number(i.quantidade), valor: Number(i.valor) })),
      observacoes: obs,
    };
    if(formaFichaFinanceira){
      payload.parcelas=[{ formaPagamento:{id:formaFichaFinanceira}, dataVencimento:hoje, valor:totalPedidoCalc }];
    }
    if (entrega && entrega.tipo === "entrega"){
      payload.transporte = {
        fretePorConta: 0,
        frete: Number(entrega.taxa) || 0,
        // quantidade/pesoBruto sempre preenchidos (mesmo com frete grátis) —
        // suspeita: o Bling pode estar descartando o endereço de entrega
        // quando o bloco de transporte parece "vazio" (frete=0 E quantidade=0)
        quantidade: 1,
        pesoBruto: estimarPesoPedido(itensSeguros.map(i=>({descricao:i.descricao||"",quantidade:i.quantidade})))||1,
      };
      // usa os campos ESTRUTURADOS do endereço (cadastro.endereco), não o texto
      // formatado pra exibição — quebrar aquele texto por vírgula misturava
      // número/bairro/cidade/UF nos campos errados (o texto usa " - " misturado
      // com vírgulas, então não bate 1:1 com uma vírgula = um campo)
      const endCad=cadastro?.endereco||{};
      if(endCad.rua||entrega.endereco){
        Object.assign(payload.transporte, montarBlocoEnderecoEntrega(endCad, nome||""));
      }
    }
    // pedidos do totem sempre vêm com vendedor "SISTEMA" (ID 15596923213 no Bling),
    // pra distinguir de pedidos digitados manualmente por um vendedor de verdade.
    // Blindado contra env var vazia/invalida (NaN vira null no JSON, e o Bling reseta pra 0)
    let vendedorIdTotem=Number(process.env.BLING_VENDEDOR_ID);
    if(!vendedorIdTotem||isNaN(vendedorIdTotem)) vendedorIdTotem=15596923213;
    payload.vendedor = { id: vendedorIdTotem };
    console.log("[totem] vendedor enviado no payload:", JSON.stringify(payload.vendedor));
    // NÃO definir situação aqui — criar em Em digitação (padrão) sem condição de pagamento
    // depois mover para AGUARDANDO SEPARAÇÃO
    await new Promise(r=>setTimeout(r,350)); // delay para evitar rate limit
    const pedido = await bling(`/pedidos/vendas`, { method: "POST", body: JSON.stringify(payload) });
    const pedidoId=pedido?.data?.id;
    console.log("[totem] vendedor retornado na criação:", JSON.stringify(pedido?.data?.vendedor));
    // reforço: alguns endpoints do Bling não respeitam vendedor na criação (POST),
    // só no PUT — garante explicitamente logo depois de criar
    if(pedidoId){
      try{
        await new Promise(r=>setTimeout(r,350));
        const rReforco=await bling(`/pedidos/vendas/${pedidoId}`,{method:"PUT",body:JSON.stringify(payload)});
        console.log("[totem] vendedor após reforço (PUT):", JSON.stringify(rReforco?.data?.vendedor));
      }catch(e){ console.log("[totem] erro ao reforçar vendedor via PUT:", e.message); }
    }
    // registra localmente se era entrega ou retirada (a listagem do Bling não traz
    // esse detalhe, e frete grátis por valor mínimo zera o valor sem deixar de ser entrega)
    if(pedidoId){
      try{
        const entregas=lerJSON(ENTREGAS_FILE,{});
        entregas[String(pedidoId)]={
          tipo: entrega?.tipo==="entrega"?"entrega":"retirada",
          freteOriginal: entrega?.tipo==="entrega"?(Number(entrega.taxa)||0):0,
          endereco: entrega?.endereco||"",
          em: Date.now(),
        };
        salvarJSON(ENTREGAS_FILE,entregas);
      }catch(e){}
      // marca que esse pedido passou pelo nosso fluxo desde a criação — sem isso,
      // a checagem de pagamento cai no heurístico de "venda à vista" do Bling e
      // classifica erroneamente como pago um pedido recém-criado, ainda não pago
      addLog(String(pedidoId),"pedido_criado_totem",null,"Totem",{nome,telefone,tipoEntrega:entrega?.tipo});
    }
    // mover para status AGUARDANDO SEPARAÇÃO após criação
    if(pedidoId && process.env.BLING_SITUACAO_ID){
      try{
        await new Promise(r=>setTimeout(r,400));
        await bling(`/pedidos/vendas/${pedidoId}/situacoes/${Number(process.env.BLING_SITUACAO_ID)}`,{method:"PATCH"});
      }catch(e){ console.log("Erro ao mover status:", e.message); }
    }
    // nota: condição de pagamento padrão deve ser removida nas configurações do Bling
    // Ajustes → Preferências → Vendas → Condição de pagamento padrão → vazio

    // REGISTRA o pedido na lista de "Propostas & Pedidos" (aba Pedidos), pra os pedidos
    // do totem e do site caírem junto com os do atacado. É gravação local (rápida) e
    // nunca quebra a venda. O número, se o Bling não devolver na criação, é buscado
    // em segundo plano depois de responder.
    if(pedidoId){
      try{
        const origem = (req.body?.origem==="site"||req.body?.origem==="totem") ? req.body.origem : "online";
        const itensReg=(itens||[]).map(i=>({produtoId:i.produtoId, nome:i.nome||"", quantidade:Number(i.quantidade)||0, valor:Number(i.valor)||0}));
        const totalItensReg=+itensReg.reduce((s,i)=>s+i.valor*i.quantidade,0).toFixed(2);
        const freteReg=(entrega&&entrega.tipo==="entrega")?(Number(entrega.taxa)||0):0;
        const numeroCriado=pedido?.data?.numero||null;
        const idReg="ped-"+String(pedidoId);
        const props=lerPropostas();
        props[idReg]={
          id:idReg, origem, tipo:"pedido",
          cliente:{ id:contatoId||null, nome:(nome||cadastro?.nome||"Consumidor Final"), telefone:(telefone||"") },
          itens:itensReg,
          total:+(totalItensReg+freteReg).toFixed(2),
          vendedorNome: origem==="site"?"Site":"Totem",
          entrega:{ tipo: entrega?.tipo==="entrega"?"entrega":"retirada", taxa:freteReg },
          observacao:"",
          status:"pedido_gerado",
          pedidoBlingId:pedidoId,
          pedidoBlingNumero: numeroCriado||pedidoId,
          criadoEm:Date.now(), atualizadoEm:Date.now(),
        };
        salvarPropostas(props);
        // se o número não veio na criação, busca em SEGUNDO PLANO e corrige (não trava a resposta)
        if(!numeroCriado){
          (async()=>{
            try{
              const det=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data);
              const num=det?.numero; if(!num) return;
              const pp=lerPropostas(); if(pp[idReg]){ pp[idReg].pedidoBlingNumero=num; salvarPropostas(pp); }
            }catch(e){}
          })();
        }
      }catch(e){ console.error("Falha ao registrar pedido totem/site na lista de propostas (ignorado):",e.message); }
    }

    res.json({ ok: true, contatoId, criouContato, pedido });
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// ------------------------- Frete / Entrega (Google Maps) -------------------------
function configEntrega(){
  const t=lerTabela(); const c=(t&&t.meta&&t.meta.entrega)||{};
  return {
    origem: c.origem || "AV. BRIGADEIRO EDUARDO GOMES, 1668, GLÓRIA, BELO HORIZONTE - MG",
    maxKm: c.maxKm ?? 23,
    minEntrega: c.minEntrega ?? 1000,
    faixas: (c.faixas && c.faixas.length ? c.faixas : [
      {min:1000, porKm:3.60},{min:2300, porKm:2.80},{min:2600, porKm:2.50},{min:3000, porKm:0}
    ]),
  };
}
function porKmPara(valor, faixas){
  let escolhido=null;
  faixas.slice().sort((a,b)=>a.min-b.min).forEach(f=>{ if(valor > Number(f.min)) escolhido=f; });
  return escolhido;
}
app.get("/api/frete", rateLimit({janelaMs:60000,max:20,prefixo:"frete"}), async (req,res)=>{
  try{
    const endereco=(req.query.endereco||"").toString().slice(0,200).trim();
    const valor=Number(req.query.valor||0);
    const cfg=configEntrega();
    if(!endereco) return res.status(400).json({erro:"endereco obrigatório"});
    if(valor < cfg.minEntrega) return res.json({entregaDisponivel:false, motivo:`Entrega disponível a partir de ${brlN(cfg.minEntrega)}. Abaixo disso, somente retirada.`, minEntrega:cfg.minEntrega});
    if(!GOOGLE_MAPS_KEY) return res.status(500).json({erro:"GOOGLE_MAPS_KEY não configurada no servidor."});
    const url=`https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&mode=driving&origins=${encodeURIComponent(cfg.origem)}&destinations=${encodeURIComponent(endereco)}&key=${GOOGLE_MAPS_KEY}`;
    const r=await fetch(url); const j=await r.json();
    const el=j?.rows?.[0]?.elements?.[0];
    if(!el || el.status!=="OK") return res.json({entregaDisponivel:false, motivo:"Não consegui calcular a distância desse endereço. Confira e tente novamente.", detalhe:el?.status||j.status});
    const km=el.distance.value/1000;
    if(km > cfg.maxKm) return res.json({entregaDisponivel:false, motivo:`Endereço a ${km.toFixed(1)} km — fora do limite de ${cfg.maxKm} km para entrega.`, km:Number(km.toFixed(1))});
    const faixa=porKmPara(valor, cfg.faixas);
    const porKm=faixa?Number(faixa.porKm):0;
    const taxa=Math.round(porKm*km*100)/100;
    res.json({entregaDisponivel:true, km:Number(km.toFixed(1)), porKm, taxa, gratis:porKm===0});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// ------------------------- Painel de pedidos -------------------------
app.get("/api/pedidos", async (req, res) => {
  try {
    const offsetBR=3*60*60*1000;
    const hojeBR=new Date(Date.now()-offsetBR).toISOString().slice(0,10);
    const dias=Number(req.query.dias||30);
    const dataIniDefault=new Date(Date.now()-offsetBR-dias*86400000).toISOString().slice(0,10);
    // se pedir todos (paginar=true), faz paginação automática
    if(req.query.todos==="1"){
      const todos=[];
      const dataIni=req.query.dataInicial||dataIniDefault;
      const dataFim=req.query.dataFinal||hojeBR;
      for(let pg=1;pg<=100;pg++){
        const p=new URLSearchParams({pagina:pg,limite:100,dataInicial:dataIni,dataFinal:dataFim});
        if(req.query.idsSituacoes) String(req.query.idsSituacoes).split(",").forEach(id=>p.append("idsSituacoes[]",id.trim()));
        const r=await bling(`/pedidos/vendas?${p.toString()}`);
        const arr=r.data||[]; todos.push(...arr);
        if(arr.length<100) break;
        if(pg%3===0) await new Promise(r=>setTimeout(r,400));
      }
      return res.json({data:todos});
    }
    const p = new URLSearchParams();
    p.set("pagina", req.query.pagina || 1);
    p.set("limite", req.query.limite || 100);
    if (req.query.idsSituacoes){
      String(req.query.idsSituacoes).split(",").forEach(id=>p.append("idsSituacoes[]", id.trim()));
    }
    // sempre inclui datas — padrão 30 dias se não informado
    p.set("dataInicial", req.query.dataInicial||dataIniDefault);
    p.set("dataFinal", req.query.dataFinal||hojeBR);
    res.json(await bling(`/pedidos/vendas?${p.toString()}`));
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});
app.get("/api/pedidos/:id", async (req, res) => {
  try { res.json(await bling(`/pedidos/vendas/${req.params.id}`)); }
  catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// Detalhe do pedido ENRIQUECIDO para a expedição: un (caixa), estoque e imagem por item
app.get("/api/expedicao/pedido/:id", async (req, res) => {
  try {
    const j = await bling(`/pedidos/vendas/${req.params.id}`);
    const ped = j?.data; if (!ped) return res.status(404).json({ erro: "pedido não encontrado" });
    // mapa código -> {un, imagem?} da tabela publicada
    const tab = lerTabela(); const unPorCod = {};
    (tab?.model || []).forEach(c => (c.itens || []).forEach(it => (it.bling || []).forEach(b => { unPorCod[String(b.codigo)] = { un: it.caixa || 1 }; })));
    const est = await getEstoqueMap();
    const itens = await Promise.all((ped.itens || []).map(async (i) => {
      const pid = i.produto?.id;
      let codigo = null, imagem = "", estoque = null, un = 1;
      // acha o produto no mapa de estoque por id (para pegar código/imagem/estoque)
      for (const k in est) { if (est[k].id === pid) { codigo = k; imagem = est[k].imagem || ""; estoque = est[k].estoque; break; } }
      if (codigo && unPorCod[codigo]) un = unPorCod[codigo].un;
      return { produtoId: pid, descricao: i.descricao || ("Produto " + pid), quantidade: i.quantidade || 1, valor: i.valor || 0, un, estoque, imagem, codigo };
    }));
    res.json({ pedido: { id: ped.id, numero: ped.numero, data: ped.data, contato: ped.contato, observacoes: ped.observacoes, situacao: ped.situacao }, itens });
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// Pendências (registro estruturado no volume)
function lerPend(){ try{ return JSON.parse(fs.readFileSync(PEND_FILE,"utf8")); }catch{ return {}; } }
function salvarPend(o){ fs.writeFileSync(PEND_FILE, JSON.stringify(o)); }
app.post("/api/pendencias", (req, res) => {
  try {
    const { pedidoId, numero, cliente, telefone, faltas } = req.body || {};
    if (!pedidoId) return res.status(400).json({ erro: "pedidoId obrigatório" });
    const o = lerPend();
    o[String(pedidoId)] = { pedidoId, numero, cliente, telefone, faltas: faltas || [], sugestao: "", status: "pendente", em: Date.now() };
    salvarPend(o); res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
app.get("/api/pendencias", (req, res) => {
  const o = lerPend();
  const lista = Object.values(o).filter(p => p.status !== "resolvido").sort((a,b)=>a.em-b.em);
  res.json({ data: lista });
});
// busca pendência de um pedido específico (inclui resolvidas — para resolver pendências)
app.get("/api/pendencias/:id", (req, res) => {
  const o = lerPend(); const p = o[String(req.params.id)];
  res.json({ data: p||null });
});
app.patch("/api/pendencias/:id", (req, res) => {
  const o = lerPend(); const p = o[String(req.params.id)];
  if (!p) return res.status(404).json({ erro: "pendência não encontrada" });
  if (typeof req.body?.sugestao === "string") p.sugestao = req.body.sugestao;
  if (req.body?.status) p.status = req.body.status;
  salvarPend(o); res.json({ ok: true, pendencia: p });
});

// ==================== MOVIMENTAÇÕES DE PRODUTO (itens retirados) ====================
// Consolida os produtos que SAÍRAM de pedidos: retirados na edição do caixa
// (movimentacoes_pedido.json) e retirados na expedição (acrescimos.json).
app.get("/api/movimentacoes/retirados",(req,res)=>{
  try{
    const lista=[];
    const movs=lerJSON(`${DATA_DIR}/movimentacoes_pedido.json`,{});
    Object.values(movs).forEach(m=>{
      (m.removidos||[]).forEach(r=>{
        lista.push({pedidoId:m.pedidoId,numero:m.numero,cliente:m.cliente,
          produtoId:r.produtoId,descricao:r.descricao,quantidade:r.quantidade,
          em:m.em,por:m.por||"",origem:"Edição no caixa"});
      });
    });
    const acrs=lerJSON(ACRS_FILE,{});
    Object.values(acrs).forEach(a=>{
      (a.itensRetirados||[]).forEach(r=>{
        lista.push({pedidoId:a.pedidoId,numero:a.numero,cliente:a.cliente,
          produtoId:r.produtoId||r.id||null,descricao:r.descricao||r.nome||"",quantidade:r.quantidade||r.qtd||null,
          em:a.em,por:a.por||"",origem:"Retirada na expedição"});
      });
    });
    lista.sort((a,b)=>(b.em||0)-(a.em||0));
    res.json({data:lista.slice(0,200)});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.patch("/api/pedidos/:id/situacao", async (req, res) => {
  try {
    const idSituacao = Number(req.body?.idSituacao);
    if (!idSituacao) return res.status(400).json({ erro: "idSituacao obrigatório" });
    res.json(await bling(`/pedidos/vendas/${req.params.id}/situacoes/${idSituacao}`, { method: "PATCH" }));
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// Busca produtos com PREÇO DE ATACADO (da tabela publicada) + estoque ao vivo
app.get("/api/buscar-atacado", async (req, res) => {
  try {
    const nome = (req.query.nome || "").trim();
    if (nome.length < 2) return res.json({ data: [] });
    const termo = nome.toLowerCase();
    const porId={};

    // 1) índice local (todos os produtos, busca em qualquer parte do nome)
    const indice=lerJSON(GTIN_INDEX_FILE,{});
    Object.values(indice).forEach(p=>{
      if((p.nome||"").toLowerCase().includes(termo) || String(p.codigo||"").toLowerCase()===termo){
        porId[p.produtoId]={ id:p.produtoId, nome:p.nome, codigo:p.codigo, estoque:null, precoBling:p.preco ?? null };
      }
    });
    // 2) se índice vazio/sem match, tenta o Bling
    if(!Object.keys(porId).length){
      const add=(arr)=>(arr||[]).forEach(p=>{ if((p.nome||"").toLowerCase().includes(termo)) porId[p.id]={ id: p.id, nome: p.nome, codigo: p.codigo, estoque: p.estoque?.saldoVirtualTotal ?? null, precoBling: p.preco ?? null }; });
      try{ const d=await bling(`/produtos?nome=${encodeURIComponent(nome)}&limite=50`); add(d.data); }catch(e){}
    }
    let lista=Object.values(porId);

    // aplica o preço de atacado (tabela publicada); se não houver, usa o preço padrão do Bling
    // também traz o "múltiplo" de venda (campo caixa da tabela: soma de N em N unidades)
    // e o preço de FARDO (se cadastrado), quando existir pra aquele item da tabela
    const idxTabela = _indicePrecosTabela();
    lista.forEach(p => {
      const vinc = idxTabela.porCodigo[String(p.codigo)];
      const atacado = vinc?.precoAtacado;
      p.precoAtacado = (atacado != null) ? atacado : null;
      p.preco = (atacado != null) ? atacado : (p.precoBling ?? 0);
      p.origemPreco = (atacado != null) ? "atacado" : "bling";
      p.multiplo = vinc?.caixaQtd || 1; // de quantas em quantas unidades some
      p.precoFardo = vinc?.precoFardo ?? null;
    });
    // busca o estoque AO VIVO dos primeiros resultados (o índice não guarda saldo,
    // que muda toda hora) — limita pra não estourar o rate limit do Bling
    const topN=lista.slice(0,8);
    await Promise.all(topN.map(async p=>{
      try{
        const r=await bling(`/produtos/${p.id}`);
        p.estoque=r?.data?.estoque?.saldoVirtualTotal ?? r?.data?.estoque?.saldoFisicoTotal ?? null;
      }catch(e){ p.estoque=null; }
    }));
    res.json({ data: lista });
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// Atualiza os ITENS de um pedido (mantém o resto do pedido), bloqueando Atendido/Cancelado
// Atualiza os itens de um pedido no Bling (reduzindo quantidade/removendo item,
// por ex. quando teve dano/não entrega), ajustando as parcelas já existentes
// proporcionalmente ao novo total — sem isso, o Bling rejeita a parcela por
// não bater com o total do pedido. Reaproveitado tanto pela edição manual de
// itens (resolução de pendências) quanto pela confirmação de entrega com
// ocorrências (Em Rota).
async function atualizarItensBling(id,itens,obsExtra,opts={}){
  try{
    // opts.ped: pedido já lido pelo chamador (evita 1 GET). opts.parcelas: [{formaId,valor}]
    // grava as formas de pagamento no MESMO PUT. opts.outrasDespesas: valor a gravar.
    // opts.itensParaEstoque: pra repor estoque se o Bling barrar a re-baixa ao restaurar.
    const atualJson=opts.ped?{data:opts.ped}:await bling(`/pedidos/vendas/${id}`);
    const ped=atualJson?.data; if(!ped) return {ok:false,erro:"pedido não encontrado"};
    const sit=ped.situacao?.id;
    if(sit===12) return {ok:false,erro:"Pedido Cancelado não pode ser editado."};

    const blingComRetry=async(url,opts={},tentativas=3,delayMs=1200)=>{
      for(let t=0;t<tentativas;t++){
        try{ return await bling(url,opts); }
        catch(e){
          if(e.status===429&&t<tentativas-1){ await new Promise(r=>setTimeout(r,delayMs*(t+1))); continue; }
          throw e;
        }
      }
    };

    const SIT_EM_DIGITACAO=21;
    const STATUS_BLOQUEADOS=[SIT.EM_SEP,SIT.SEP_PEND,SIT.SEPARADO,SIT.CONF_ENTREGA,SIT.EM_ROTA,SIT.ATENDIDO];
    const precisaUnlock=STATUS_BLOQUEADOS.includes(sit);

    const tsEdit=new Date().toISOString().slice(0,16).replace('T',' ');
    const obsBase=(ped.observacoes||"").replace(/\s*\|\s*edit\s+[\d\-: ]+$/,"").trim();
    // se veio observação do caixa, acrescenta ela (sem duplicar) ao texto base
    let obsFinal=obsBase;
    if(obsExtra && String(obsExtra).trim()){
      const oe=String(obsExtra).trim();
      obsFinal = obsBase && !obsBase.includes(oe) ? obsBase+"\n"+oe : (obsBase||oe);
    }
    const payload={
      data:ped.data,
      contato:{id:ped.contato?.id},
      // PRESERVA o vendedor original do pedido (senão o Bling troca/remove o vendedor
      // no PUT, o que causava "vendedor trocado" e erro "Vendedor inativo").
      ...(ped.vendedor?.id?{vendedor:{id:ped.vendedor.id}}:{}),
      itens:itens.map(i=>({produto:{id:Number(i.produtoId)},quantidade:Number(i.quantidade),valor:Number(i.valor)})),
      observacoes:obsFinal?obsFinal+" | edit "+tsEdit:"edit "+tsEdit,
    };
    // preserva desconto e outras despesas (senão o PUT zera no Bling)
    if(ped.desconto&&ped.desconto.valor!=null) payload.desconto={valor:Number(ped.desconto.valor)||0,unidade:ped.desconto.unidade||"REAL"};
    if(opts.outrasDespesas!=null) payload.outrasDespesas=+Number(opts.outrasDespesas).toFixed(2);
    else if(ped.outrasDespesas!=null) payload.outrasDespesas=+Number(ped.outrasDespesas).toFixed(2);
    if(Array.isArray(opts.parcelas)&&opts.parcelas.length){
      payload.parcelas=opts.parcelas.filter(p=>p.formaId&&(Number(p.valor)||0)>0).map(p=>({formaPagamento:{id:Number(p.formaId)},dataVencimento:ped.data,valor:+Number(p.valor).toFixed(2)}));
    } else if(ped.parcelas?.length){
      const novoTotalItens=itens.reduce((s,i)=>s+Number(i.quantidade)*Number(i.valor),0);
      const freteAtual=+(ped.transporte?.frete||0);
      const novoTotal=+(novoTotalItens+freteAtual+Number(payload.outrasDespesas||0)-Number(payload.desconto?.valor||0)).toFixed(2);
      const somaParcelasAtual=ped.parcelas.reduce((s,p)=>s+(p.valor||0),0);
      const fator=somaParcelasAtual>0?novoTotal/somaParcelasAtual:1;
      payload.parcelas=ped.parcelas.map(p=>({
        formaPagamento:{id:p.formaPagamento?.id}, dataVencimento:p.dataVencimento||ped.data,
        valor:+((p.valor||0)*fator).toFixed(2),
      }));
      const somaAjustada=payload.parcelas.reduce((s,p)=>s+p.valor,0);
      const diffArred=+(novoTotal-somaAjustada).toFixed(2);
      if(payload.parcelas.length&&Math.abs(diffArred)>0.001){
        const ultima=payload.parcelas[payload.parcelas.length-1];
        ultima.valor=+(ultima.valor+diffArred).toFixed(2);
      }
    }
    if(ped.transporte){
      payload.transporte={fretePorConta:ped.transporte.fretePorConta??0,frete:ped.transporte.frete||0};
      if(ped.transporte.enderecoEntrega){
        const end=ped.transporte.enderecoEntrega;
        Object.assign(payload.transporte, montarBlocoEnderecoEntrega(end, ped.contato?.nome||""));
      }
    }
    if(ped.loja?.id) payload.loja={id:ped.loja.id};
    if(ped.vendedor?.id) payload.vendedor={id:ped.vendedor.id};

    let resultado, fezUnlock=false, _ultimaRestauracao=null;
    try{
      await new Promise(r=>setTimeout(r,200));
      resultado=await blingComRetry(`/pedidos/vendas/${id}`,{method:"PUT",body:JSON.stringify(payload)});
    }catch(e1){
      if(!precisaUnlock) throw e1;
      try{
        await blingComRetry(`/pedidos/vendas/${id}/situacoes/${SIT_EM_DIGITACAO}`,{method:"PATCH"});
        fezUnlock=true;
        await new Promise(r=>setTimeout(r,400));
        resultado=await blingComRetry(`/pedidos/vendas/${id}`,{method:"PUT",body:JSON.stringify(payload)});
      }catch(e2){ throw e2; }
    }finally{
      if(fezUnlock){
        await new Promise(r=>setTimeout(r,400));
        const sitRestaurar=sit===SIT.SEP_PEND?SIT.EM_SEP:sit;
        if(sitRestaurar===SIT.ATENDIDO||sitRestaurar===SIT.SEPARADO){
          const rr=await _restaurarSituacaoComRetry(id, sitRestaurar, opts.itensParaEstoque||itens);
          _ultimaRestauracao={ok:rr.ok, reposto:rr.reposto||[], erro:rr.erro, situacaoFinal:rr.ok?sitRestaurar:null};
          if(!rr.ok){ try{ await bling(`/pedidos/vendas/${id}/situacoes/${SIT.AGUARDANDO}`,{method:"PATCH"}); }catch(e){} }
        } else {
          let restaurado=false;
          for(let t=0;t<3;t++){
            try{ await bling(`/pedidos/vendas/${id}/situacoes/${sitRestaurar}`,{method:"PATCH"}); restaurado=true; break; }
            catch(e){ await new Promise(r=>setTimeout(r,600*(t+1))); }
          }
          if(!restaurado){ try{ await bling(`/pedidos/vendas/${id}/situacoes/${SIT.AGUARDANDO}`,{method:"PATCH"}); }catch(e){} }
          _ultimaRestauracao={ok:restaurado, reposto:[], situacaoFinal:restaurado?sitRestaurar:null};
        }
      }
    }
    const rest=_ultimaRestauracao||{ok:true,reposto:[],situacaoFinal:sit};
    return {ok:true,resultado,fezUnlock,restaurouOk:rest.ok,situacaoFinal:rest.situacaoFinal||sit,reposto:rest.reposto||[],erroRestaurar:rest.erro||null};
  }catch(e){ return {ok:false,erro:e.message,status:e.status,body:e.body}; }
}

app.put("/api/pedidos/:id/itens", async (req, res) => {
  try {
    const {itens, funcionarioId, funcionarioNome, motivo} = req.body||{};
    if (!Array.isArray(itens)) return res.status(400).json({ erro: "itens inválidos" });
    const atualJson = await bling(`/pedidos/vendas/${req.params.id}`);
    const ped = atualJson?.data; if (!ped) return res.status(404).json({ erro: "pedido não encontrado" });
    const sit = ped.situacao?.id;
    if (sit === 9 || sit === 12) return res.status(400).json({ erro: "Pedido Atendido/Cancelado não pode ser editado." });

    // helper com retry para chamadas ao Bling
    const blingComRetry=async(url,opts={},tentativas=3,delayMs=1200)=>{
      for(let t=0;t<tentativas;t++){
        try{ return await bling(url,opts); }
        catch(e){
          if(e.status===429&&t<tentativas-1){ await new Promise(r=>setTimeout(r,delayMs*(t+1))); continue; }
          throw e;
        }
      }
    };

    // tenta editar direto — se der 400, tenta via Em Digitação (que aceita qualquer transição)
    // mapa de transições permitidas para cada status
    const SIT_EM_DIGITACAO=21; // Em digitação
    // status que precisam de unlock via Em digitação (id=21) para editar itens
    // requer transição criada no Bling: STATUS → Em digitação → STATUS
    const STATUS_BLOQUEADOS=[SIT.EM_SEP,SIT.SEP_PEND,SIT.SEPARADO,SIT.CONF_ENTREGA,SIT.EM_ROTA];
    const precisaUnlock=STATUS_BLOQUEADOS.includes(sit);

    // monta payload mínimo — sem situação (não pode mudar via PUT)
    const tsEdit=new Date().toISOString().slice(0,16).replace('T',' ');
    const obsBase=(ped.observacoes||"").replace(/\s*\|\s*edit\s+[\d\-: ]+$/,"").trim();
    const payload = {
      data: ped.data,
      contato: { id: ped.contato?.id },
      itens: itens.map(i => ({
        produto: { id: Number(i.produtoId) },
        quantidade: Number(i.quantidade),
        valor: Number(i.valor)
      })),
      observacoes: obsBase ? obsBase+" | edit "+tsEdit : "edit "+tsEdit,
    };
    // preserva as parcelas que já existem no pedido — sem isso, o Bling reseta
    // a forma de pagamento pro padrão dele (Dinheiro) toda vez que os itens
    // são editados (ex: resolução de pendências), mesmo sem mexer no pagamento.
    // Ajusta o valor proporcionalmente pro novo total (itens podem ter mudado),
    // senão o Bling rejeita com 400 por causa da soma das parcelas não bater.
    // preserva desconto e outras despesas (senão o PUT zera no Bling)
    if(ped.desconto&&ped.desconto.valor!=null) payload.desconto={valor:Number(ped.desconto.valor)||0,unidade:ped.desconto.unidade||"REAL"};
    if(opts.outrasDespesas!=null) payload.outrasDespesas=+Number(opts.outrasDespesas).toFixed(2);
    else if(ped.outrasDespesas!=null) payload.outrasDespesas=+Number(ped.outrasDespesas).toFixed(2);
    if(Array.isArray(opts.parcelas)&&opts.parcelas.length){
      payload.parcelas=opts.parcelas.filter(p=>p.formaId&&(Number(p.valor)||0)>0).map(p=>({formaPagamento:{id:Number(p.formaId)},dataVencimento:ped.data,valor:+Number(p.valor).toFixed(2)}));
    } else if(ped.parcelas?.length){
      const novoTotalItens=itens.reduce((s,i)=>s+Number(i.quantidade)*Number(i.valor),0);
      const freteAtual=+(ped.transporte?.frete||0);
      const novoTotal=+(novoTotalItens+freteAtual+Number(payload.outrasDespesas||0)-Number(payload.desconto?.valor||0)).toFixed(2);
      const somaParcelasAtual=ped.parcelas.reduce((s,p)=>s+(p.valor||0),0);
      const fator=somaParcelasAtual>0?novoTotal/somaParcelasAtual:1;
      payload.parcelas=ped.parcelas.map(p=>({
        formaPagamento:{id:p.formaPagamento?.id}, dataVencimento:p.dataVencimento||ped.data,
        valor:+((p.valor||0)*fator).toFixed(2),
      }));
      // corrige arredondamento na última parcela pra bater exatamente com o novo total
      const somaAjustada=payload.parcelas.reduce((s,p)=>s+p.valor,0);
      const diffArred=+(novoTotal-somaAjustada).toFixed(2);
      if(payload.parcelas.length&&Math.abs(diffArred)>0.001){
        const ultima=payload.parcelas[payload.parcelas.length-1];
        ultima.valor=+(ultima.valor+diffArred).toFixed(2);
      }
    }
    // incluir transporte/endereço se existir (UF obrigatório no Bling)
    if(ped.transporte){
      payload.transporte={
        fretePorConta:ped.transporte.fretePorConta??0,
        frete:ped.transporte.frete||0,
      };
      if(ped.transporte.enderecoEntrega){
        const end=ped.transporte.enderecoEntrega;
        Object.assign(payload.transporte, montarBlocoEnderecoEntrega(end, ped.contato?.nome||""));
      }
    }
    if(ped.loja?.id) payload.loja={id:ped.loja.id};
    if(ped.vendedor?.id) payload.vendedor={id:ped.vendedor.id};
    console.log("PUT transporte:", JSON.stringify(ped.transporte));
    console.log("PUT payload situacao:", ped.situacao?.id, "itens:", itens.length);

    let resultado;
    let fezUnlock=false;
    try{
      // tenta editar direto (funciona para alguns status)
      await new Promise(r=>setTimeout(r,200));
      resultado=await blingComRetry(`/pedidos/vendas/${req.params.id}`,{ method:"PUT", body:JSON.stringify(payload) });
    }catch(e1){
      if(e1.status!==400||!precisaUnlock) throw e1;
      // 400: desbloqueia tentando situações editáveis que este Bling aceite
      console.log("Tentando desbloquear para editar itens, sit atual:", sit);
      try{
        const sitDestravado=await _destravarSituacao(req.params.id);
        if(!sitDestravado) throw e1;
        fezUnlock=true; // marcou que mudou status — DEVE restaurar no finally
        await new Promise(r=>setTimeout(r,400));
        resultado=await blingComRetry(`/pedidos/vendas/${req.params.id}`,{ method:"PUT", body:JSON.stringify(payload) });
      }catch(e2){
        console.error("PUT itens erro final:", JSON.stringify(e2.body||e2.message));
        throw e2;
      }
    }finally{
      // SEMPRE restaura o status original se fez unlock — mesmo em caso de erro
      if(fezUnlock){
        await new Promise(r=>setTimeout(r,400));
        // se estava em SEP_PEND, após editar vai para EM_SEP (expedição precisa separar de novo)
        const sitRestaurar=sit===SIT.SEP_PEND?SIT.EM_SEP:sit;
        console.log("Restaurando status:", sit, "→", sitRestaurar, "pedido:", req.params.id);
        await _restaurarSituacao(req.params.id, sitRestaurar);
      }
    }
    if(funcionarioId) addLog(String(req.params.id),"itens_editados",funcionarioId,funcionarioNome,{motivo:motivo||"edição manual",qtdItens:itens.length});
    res.json(resultado||{ok:true});
  } catch (e) {
    // log detalhado do erro do Bling
    console.error("PUT /itens erro:", JSON.stringify({status:e.status,msg:e.message,body:e.body}));
    res.status(e.status || 500).json({ erro: `Bling ${e.status||500}: ${e.message}`, detalhe: e.body });
  }
});

// Anexa uma observação ao pedido (registro de faltas na separação)
app.patch("/api/pedidos/:id/observacao", async (req, res) => {
  try {
    const texto = req.body?.texto || "";
    const atual = await bling(`/pedidos/vendas/${req.params.id}`);
    const ped = atual?.data; if (!ped) return res.status(404).json({ erro: "pedido não encontrado" });
    const obs = (ped.observacoes ? ped.observacoes + " | " : "") + texto;
    const payload = {
      data: ped.data, contato: { id: ped.contato?.id },
      itens: (ped.itens || []).map(i => ({ produto: { id: i.produto?.id }, quantidade: i.quantidade, valor: i.valor })),
      observacoes: obs,
    };
    if (ped.transporte?.frete) payload.transporte = { fretePorConta: ped.transporte.fretePorConta ?? 0, frete: ped.transporte.frete };
    if (ped.vendedor?.id) payload.vendedor = { id: ped.vendedor.id };
    if (ped.situacao?.id) payload.situacao = { id: ped.situacao.id };
    res.json(await bling(`/pedidos/vendas/${req.params.id}`, { method: "PUT", body: JSON.stringify(payload) }));
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

app.get("/pedir", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "totem.html")); });
app.get("/pedir-online", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "pedir-online.html")); });
// ---- ATALHOS CURTOS (encurtador próprio, com a marca B13) ----
// Links curtos e fáceis de mandar pro cliente. O /tabela abre a tabela de preços
// pro cliente (a tela interna de gestão foi movida pra /tabela-atacado).
// no-store nos redirects pra o navegador não cachear o destino (evita mostrar a
// versão antiga de /tabela, que antes servia a tela interna com login).
function atalho(destino){
  return (req,res)=>{ res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.redirect(destino); };
}
app.get("/tabela", atalho("/pedir-online?modo=tabela"));
app.get("/precos", atalho("/pedir-online?modo=tabela"));
app.get("/tabela-precos", atalho("/pedir-online?modo=tabela"));
app.get("/loja",   atalho("/pedir-online"));
app.get("/pedir-agora", atalho("/pedir-online"));
app.get("/ofertas", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "ofertas.html")); });
app.get("/pedir-tabela", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "pedir-tabela.html")); });
app.get("/painel", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "painel.html")); });
// ------------------------- Fechamento de Caixa -------------------------
const _vendedorCache={};
async function nomeVendedor(id){
  if(!id) return "Sem vendedor";
  if(_vendedorCache[id]) return _vendedorCache[id];
  try{
    await new Promise(r=>setTimeout(r,350));
    const v=await bling(`/vendedores/${id}`);
    const nome=v?.data?.nome||v?.data?.contato?.nome||`Vendedor ${id}`;
    _vendedorCache[id]=nome; return nome;
  }catch(e){ return `Vendedor ${id}`; }
}
function nomeSituacaoFechamento(id){
  const nomes={
    [SIT.AGUARDANDO]:"Aguardando", [SIT.EM_SEP]:"Em Separação", [SIT.SEP_PEND]:"Separado c/ Pendências",
    [SIT.SEPARADO]:"Separado", [SIT.EM_ROTA]:"Em Rota", [SIT.ATENDIDO]:"Atendido",
    21:"Em digitação", 6:"Em aberto", 12:"Cancelado",
  };
  return nomes[id]||`Situação ${id}`;
}

// Mesma lógica do GET /api/pagamentos/:id, mas reaproveitando um pedido (ped) e
// log já buscados, pra não duplicar chamadas ao Bling no fechamento de caixa.
async function resolverPagamentoPedido(ped,pagLocal,logPedido){
  const totalPed=+(ped?.total||ped?.totalProdutos||0);
  if(pagLocal){
    return {valorPago:+(pagLocal.valorPago||0),statusPagamento:pagLocal.statusPagamento||"pendente",historico:pagLocal.historico||[],doBling:false,previsto:[]};
  }
  const passouPeloNossoFluxo=(logPedido||[]).some(e=>
    ["pedido_criado_totem","separar_para_entregar","enviado_separacao_pago","pedido_aberto_separacao",
     "separacao_completa","separacao_com_falta","conferido_entrega","conferido_retirada",
     "pagamento_registrado","recebido_cliente_separou"].includes(e.evento)
  );
  const parcelasBrutas=ped?.parcelas||[];
  // O totem cria o pedido com uma parcela de "ficha financeira" só como marcador
  // interno — isso NÃO é pagamento real. Separa as parcelas reais das de ficha:
  const parcelas=[];
  for(const pc of parcelasBrutas){
    const nomeForma=await nomeFormaPagamentoId(pc.formaPagamento?.id);
    const ehFicha=(nomeForma||"").toLowerCase().includes("ficha financeira");
    if(!ehFicha) parcelas.push({...pc,_nomeForma:nomeForma});
  }

  // Se passou pelo fluxo interno e NÃO tem nenhuma parcela real (só a ficha, ou nada),
  // é não pago — o pagamento ainda não foi registrado nem interno nem no Bling.
  if(passouPeloNossoFluxo && parcelas.length===0){
    return {valorPago:0,statusPagamento:"pendente",historico:[],doBling:false,previsto:[]};
  }
  if(parcelas.length===0){
    // sem nenhuma forma de pagamento real cadastrada — não pago
    return {valorPago:0,statusPagamento:"pendente",historico:[],doBling:false,previsto:[]};
  }
  // tem forma de pagamento REAL registrada — conta como pago (data igual ou diferente).
  // parcelas com data de vencimento diferente da data do pedido continuam
  // destacadas em "previsto" (pode ser erro de digitação de prazo, ou pedido de
  // entrega criado num dia e pago/entregue em outro), mas entram no total pago.
  const historico=[]; const previsto=[]; let valorPago=0;
  for(const pc of parcelas){
    const nomeForma=pc._nomeForma||await nomeFormaPagamentoId(pc.formaPagamento?.id);
    const aPrazo=!!(pc.dataVencimento&&ped?.data&&String(pc.dataVencimento)!==String(ped.data));
    const valor=+(pc.valor||0);
    valorPago+=valor;
    historico.push({valor,formaNome:nomeForma,origem:"bling",em:Date.now(),aPrazo,vencimento:pc.dataVencimento||""});
    if(aPrazo) previsto.push({formaNome:nomeForma,valor,vencimento:pc.dataVencimento||""});
  }
  valorPago=+valorPago.toFixed(2);
  return {valorPago,statusPagamento:valorPago>=totalPed-0.01?"pago":"parcial",historico,doBling:true,previsto};
}

app.get("/api/em-digitacao", async(req,res)=>{
  try{
    const hoje=dataBR();
    const dataInicial=req.query.dataInicial||new Date(Date.now()-90*86400000).toISOString().slice(0,10);
    const dataFinal=req.query.dataFinal||hoje;

    const lista=[];
    for(let pg=1;pg<=100;pg++){
      const p=new URLSearchParams({pagina:pg,limite:100,dataInicial,dataFinal,idsSituacoes:"21"});
      const r=await bling(`/pedidos/vendas?${p.toString()}`);
      const arr=r.data||[]; lista.push(...arr);
      if(arr.length<100) break;
      // fila global ja garante o espacamento
    }

    // rastreia desde quando cada pedido foi visto em Em Digitação (Bling não dá hora, só data)
    const track=lerJSON(EMDIG_TRACK_FILE,{});
    const idsAtuais=new Set(lista.map(p=>String(p.id)));
    const agora=Date.now();
    lista.forEach(p=>{ const id=String(p.id); if(!track[id]) track[id]={desde:agora}; track[id].ultimaVez=agora; });
    // limpa do rastreamento pedidos que não estão mais em digitação (saíram do estado)
    Object.keys(track).forEach(id=>{ if(!idsAtuais.has(id)) delete track[id]; });
    salvarJSON(EMDIG_TRACK_FILE,track);

    const porVendedor={};
    const todosPedidos=[];
    for(const pRaw of lista){
      let vendedorId=null, det=null;
      try{ const r=await bling(`/pedidos/vendas/${pRaw.id}`); det=r?.data||null; vendedorId=det?.vendedor?.id||null; }catch(e){}
      const vendedorNome=await nomeVendedor(vendedorId);
      const desde=track[String(pRaw.id)]?.desde||agora;
      const obj={
        id:pRaw.id, numero:pRaw.numero, cliente:pRaw.contato?.nome||"—", vendedor:vendedorNome,
        total:+(pRaw.total||pRaw.totalProdutos||0), data:pRaw.data,
        desde, desdeHora:new Date(desde).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit",timeZone:"America/Sao_Paulo"}),
        itens:(det?.itens||[]).map(i=>({descricao:i.descricao||i.produto?.nome||"Produto",quantidade:i.quantidade,valor:i.valor})),
      };
      if(!porVendedor[vendedorNome]) porVendedor[vendedorNome]=[];
      porVendedor[vendedorNome].push(obj);
      todosPedidos.push(obj);
    }
    todosPedidos.sort((a,b)=>b.desde-a.desde);
    res.json({data:{total:lista.length,porVendedor,recentes:todosPedidos}});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});


// Fechamento baseado no DIA DO PAGAMENTO (não na data de criação do pedido) —
// funciona por dia único ou período. Duas fontes:
// 1) pagamentos.json (nosso sistema) - tem a hora exata que cada pagamento foi
//    registrado, então sabemos com certeza em que dia entrou o dinheiro.
// 2) pedidos direto do Bling (nunca passaram pelo nosso sistema) - usamos a
//    data de vencimento da parcela como aproximação do dia do pagamento,
//    procurando numa janela ampla de pedidos criados até a data final.
app.get("/api/fechamento-por-pagamento", async(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.setHeader("X-Accel-Buffering","no");
  res.flushHeaders();
  const send=(d)=>{ res.write(`data: ${JSON.stringify(d)}\n\n`); };
  const heartbeat=setInterval(()=>{ try{ res.write(`: ping\n\n`); }catch(e){} },10000);
  res.on("close",()=>clearInterval(heartbeat));

  try{
    const dataRegex=/^\d{4}-\d{2}-\d{2}$/;
    let dataInicial=req.query.dataInicial, dataFinal=req.query.dataFinal;
    if(!dataInicial||!dataFinal){
      const data=req.query.data;
      if(!data||!dataRegex.test(data)){ send({tipo:"erro",erro:"informe ?data=AAAA-MM-DD ou ?dataInicial=&dataFinal="}); clearInterval(heartbeat); return res.end(); }
      dataInicial=data; dataFinal=data;
    }
    if(!dataRegex.test(dataInicial)||!dataRegex.test(dataFinal)){ send({tipo:"erro",erro:"datas em formato inválido (AAAA-MM-DD)"}); clearInterval(heartbeat); return res.end(); }

    const inicioMs=new Date(dataInicial+"T00:00:00").getTime();
    const fimMs=new Date(dataFinal+"T23:59:59.999").getTime();

    send({tipo:"status",mensagem:"Verificando pagamentos registrados pelo nosso sistema…"});

    // ---- 1) pagamentos.json — fonte confiável, com hora exata ----
    const pags=lerPag();
    const porForma={}; // nome -> {valor, qtd}
    let totalPago=0;
    const pedidosEncontrados=new Map(); // id -> {numero,cliente,total,valorNoPeriodo,situacao,data}
    const idsJaVistos=new Set();

    for(const [id,p] of Object.entries(pags)){
      const entradasNoPeriodo=(p.historico||[]).filter(h=>h.em>=inicioMs&&h.em<=fimMs&&h.valor);
      if(!entradasNoPeriodo.length) continue;
      idsJaVistos.add(id);
      let valorNoPeriodo=0;
      entradasNoPeriodo.forEach(h=>{
        const nome=h.formaNome||(h.tipo==="estorno"?"Estorno":"Não identificada");
        if(!porForma[nome]) porForma[nome]={valor:0,qtd:0};
        porForma[nome].valor+=h.valor; porForma[nome].qtd++;
        valorNoPeriodo+=h.valor;
      });
      totalPago+=valorNoPeriodo;
      pedidosEncontrados.set(id,{id,valorNoPeriodo});
    }
    send({tipo:"status",mensagem:`${pedidosEncontrados.size} pedido(s) do nosso sistema encontrados. Verificando pedidos direto do Bling…`});

    // ---- 2) pedidos direto do Bling — usa vencimento da parcela como aproximação ----
    // busca pedidos criados numa janela ampla (até 60 dias antes da data final),
    // já que um pedido pode ter sido criado bem antes de ser pago
    const janelaBuscaDias=7;
    const dataBuscaInicial=new Date(new Date(dataFinal+"T00:00:00").getTime()-janelaBuscaDias*86400000).toISOString().slice(0,10);
    const lista=[];
    for(let pg=1;pg<=100;pg++){
      const p=new URLSearchParams({pagina:pg,limite:100,dataInicial:dataBuscaInicial,dataFinal});
      const r=await bling(`/pedidos/vendas?${p.toString()}`);
      const arr=r.data||[]; lista.push(...arr);
      if(arr.length<100) break;
    }
    send({tipo:"total",total:lista.length});

    const logsTodos=lerJSON(LOG_FILE,{});
    for(let i=0;i<lista.length;i++){
      const pRaw=lista[i];
      const id=String(pRaw.id);
      send({tipo:"progresso",atual:i+1,total:lista.length,pedido:pRaw.numero});
      if(idsJaVistos.has(id)) continue; // já contado via pagamentos.json
      const sitNome=nomeSituacaoFechamento(pRaw.situacao?.id);
      if(sitNome==="Cancelado") continue;
      let det=null;
      try{ const r=await bling(`/pedidos/vendas/${id}`); det=r?.data||null; }catch(e){}
      const parcelas=(det||pRaw)?.parcelas||[];
      if(!parcelas.length) continue; // sem parcela = sem pagamento registrado no Bling
      let valorNoPeriodo=0;
      for(const pc of parcelas){
        const venc=pc.dataVencimento;
        if(!venc) continue;
        const vencMs=new Date(venc+"T12:00:00").getTime(); // meio-dia, evita problema de fuso
        if(vencMs<inicioMs||vencMs>fimMs) continue;
        const nome=await nomeFormaPagamentoId(pc.formaPagamento?.id);
        const valor=+(pc.valor||0);
        if(!porForma[nome]) porForma[nome]={valor:0,qtd:0};
        porForma[nome].valor+=valor; porForma[nome].qtd++;
        valorNoPeriodo+=valor;
      }
      if(valorNoPeriodo>0){ totalPago+=valorNoPeriodo; pedidosEncontrados.set(id,{id,valorNoPeriodo}); idsJaVistos.add(id); }
    }

    // busca dados básicos (número, cliente, situação, total, data) de cada pedido encontrado
    send({tipo:"status",mensagem:`Buscando detalhes de ${pedidosEncontrados.size} pedido(s)…`});
    const pedidosFinal=[];
    let i2=0;
    for(const [id,info] of pedidosEncontrados){
      i2++;
      let pRaw=lista.find(p=>String(p.id)===id);
      if(!pRaw){ try{ const r=await bling(`/pedidos/vendas/${id}`); pRaw=r?.data||null; }catch(e){} }
      if(!pRaw) continue;
      const total=+(pRaw.total??pRaw.totalProdutos??0);
      pedidosFinal.push({
        numero:pRaw.numero, id, cliente:pRaw.contato?.nome||"—",
        data:pRaw.data, situacao:nomeSituacaoFechamento(pRaw.situacao?.id),
        total, valorRecebidoNoPeriodo:+info.valorNoPeriodo.toFixed(2),
      });
      send({tipo:"progresso2",atual:i2,total:pedidosEncontrados.size});
    }
    pedidosFinal.sort((a,b)=>String(a.data).localeCompare(String(b.data)));

    const formasArr=Object.entries(porForma).map(([nome,v])=>({nome,valor:+v.valor.toFixed(2),qtd:v.qtd})).sort((a,b)=>b.valor-a.valor);
    send({tipo:"done",dataInicial,dataFinal,
      totalPago:+totalPago.toFixed(2), qtdPedidos:pedidosFinal.length,
      formasPagamento:formasArr, pedidos:pedidosFinal});
  }catch(e){ send({tipo:"erro",erro:e.message}); }
  clearInterval(heartbeat);
  res.end();
});

app.get("/api/formas-pagamento-por-data", async(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.setHeader("X-Accel-Buffering","no");
  res.flushHeaders();
  const send=(d)=>{ res.write(`data: ${JSON.stringify(d)}\n\n`); };
  const heartbeat=setInterval(()=>{ try{ res.write(`: ping\n\n`); }catch(e){} },10000);
  res.on("close",()=>clearInterval(heartbeat));

  try{
    const dataRegex=/^\d{4}-\d{2}-\d{2}$/;
    const dataAlvo=req.query.data;
    if(!dataAlvo||!dataRegex.test(dataAlvo)){ send({tipo:"erro",erro:"informe ?data=AAAA-MM-DD"}); clearInterval(heartbeat); return res.end(); }
    const janelaDias=Math.max(1,parseInt(req.query.dias)||7);
    const alvo=new Date(dataAlvo+"T00:00:00");
    const dataInicial=dataAlvo;
    const dataFinal=new Date(alvo.getTime()+janelaDias*86400000).toISOString().slice(0,10);

    send({tipo:"status",mensagem:`Buscando pedidos criados entre ${dataInicial} e ${dataFinal}…`});
    const lista=[];
    for(let pg=1;pg<=100;pg++){
      const p=new URLSearchParams({pagina:pg,limite:100,dataInicial,dataFinal});
      const r=await bling(`/pedidos/vendas?${p.toString()}`);
      const arr=r.data||[]; lista.push(...arr);
      if(arr.length<100) break;
    }
    send({tipo:"total",total:lista.length});

    const pags=lerPag();
    const logsTodos=lerJSON(LOG_FILE,{});
    const porForma={}; // nome -> {valor, qtd}
    let totalPago=0, qtdPagos=0, totalNaoPago=0, qtdNaoPagos=0;
    const pedidosDetalhados=[];
    for(let i=0;i<lista.length;i++){
      const pRaw=lista[i];
      const id=String(pRaw.id);
      const sitNome=nomeSituacaoFechamento(pRaw.situacao?.id);
      if(sitNome==="Cancelado"){ send({tipo:"progresso",atual:i+1,total:lista.length}); continue; }
      let det=null;
      try{ const r=await bling(`/pedidos/vendas/${id}`); det=r?.data||null; }catch(e){}
      const total=+(det?.total??pRaw.total??pRaw.totalProdutos??0);
      const pagLocal=pags[id];
      const {valorPago,historico}=await resolverPagamentoPedido(det||pRaw,pagLocal,logsTodos[id]||[]);
      const pago=valorPago>=total-0.01&&valorPago>0;
      if(pago){
        totalPago+=total; qtdPagos++;
        // soma por forma de pagamento — usa o histórico (pode ter mais de uma forma)
        (historico||[]).forEach(h=>{
          const nome=h.formaNome||"Não identificada";
          if(!porForma[nome]) porForma[nome]={valor:0,qtd:0};
          porForma[nome].valor+=+(h.valor||0);
          porForma[nome].qtd++;
        });
      } else {
        totalNaoPago+=total; qtdNaoPagos++;
      }
      pedidosDetalhados.push({numero:pRaw.numero,id:pRaw.id,cliente:pRaw.contato?.nome||"—",data:pRaw.data,situacao:sitNome,total,pago});
      send({tipo:"progresso",atual:i+1,total:lista.length,pedido:pRaw.numero});
    }
    const formasArr=Object.entries(porForma).map(([nome,v])=>({nome,valor:+v.valor.toFixed(2),qtd:v.qtd})).sort((a,b)=>b.valor-a.valor);
    send({tipo:"done",dataAlvo,dataInicial,dataFinal,janelaDias,
      totalPago:+totalPago.toFixed(2),qtdPagos,totalNaoPago:+totalNaoPago.toFixed(2),qtdNaoPagos,
      formasPagamento:formasArr, pedidos:pedidosDetalhados});
  }catch(e){ send({tipo:"erro",erro:e.message}); }
  clearInterval(heartbeat);
  res.end();
});

// ------------------------- Ledger diário de pagamentos -------------------------
// Sincroniza pedidos criados no período [dataInicial,dataFinal] (data do PEDIDO)
// e atualiza a ficha local de cada um. IMPORTANTE: uma vez que um pedido é
// detectado como PAGO, sua dataPagamento fica travada — sincronizações futuras
// não mudam mais essa data, então o fechamento de um dia já fechado é estável.
// Pedidos já marcados como "pago" não são reconsultados no Bling (mais rápido).
app.get("/api/ledger/sincronizar", async(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.setHeader("X-Accel-Buffering","no");
  res.flushHeaders();
  const send=(d)=>{ res.write(`data: ${JSON.stringify(d)}\n\n`); };
  const heartbeat=setInterval(()=>{ try{ res.write(`: ping\n\n`); }catch(e){} },10000);
  res.on("close",()=>clearInterval(heartbeat));

  try{
    const dataRegex=/^\d{4}-\d{2}-\d{2}$/;
    const dataInicial=req.query.dataInicial, dataFinal=req.query.dataFinal;
    if(!dataInicial||!dataFinal||!dataRegex.test(dataInicial)||!dataRegex.test(dataFinal)){
      send({tipo:"erro",erro:"informe ?dataInicial=AAAA-MM-DD&dataFinal=AAAA-MM-DD"}); clearInterval(heartbeat); return res.end();
    }
    send({tipo:"status",mensagem:`Buscando pedidos criados entre ${dataInicial} e ${dataFinal}…`});
    const lista=[];
    for(let pg=1;pg<=100;pg++){
      const p=new URLSearchParams({pagina:pg,limite:100,dataInicial,dataFinal});
      const r=await bling(`/pedidos/vendas?${p.toString()}`);
      const arr=r.data||[]; lista.push(...arr);
      if(arr.length<100) break;
    }
    send({tipo:"total",total:lista.length});

    const ledger=lerLedger();
    const pags=lerPag();
    const logsTodos=lerJSON(LOG_FILE,{});
    const hoje=dataBR();
    let atualizados=0, jaEstavaPago=0, novosPagos=0, novosPendentes=0, novosParciais=0;

    for(let i=0;i<lista.length;i++){
      const pRaw=lista[i];
      const id=String(pRaw.id);
      send({tipo:"progresso",atual:i+1,total:lista.length,pedido:pRaw.numero});
      const sitNome=nomeSituacaoFechamento(pRaw.situacao?.id);
      if(sitNome==="Cancelado"){ if(ledger[id]) ledger[id].status="cancelado"; continue; }

      let entry=ledger[id]||{id,numero:pRaw.numero,cliente:pRaw.contato?.nome||"—",vendedor:null,dataPedido:pRaw.data,dataPagamento:null,total:0,formas:[],status:"pendente"};
      if(entry.status==="pago"){ jaEstavaPago++; continue; } // já fechado, não reconsulta

      let det=null;
      try{ det=(await bling(`/pedidos/vendas/${id}`))?.data||null; }catch(e){}
      const total=+(det?.total??pRaw.total??pRaw.totalProdutos??0);
      const vendedorId=det?.vendedor?.id||null;
      const vendedorNome=await nomeVendedor(vendedorId);
      const pagLocal=pags[id];
      const {valorPago,historico}=await resolverPagamentoPedido(det||pRaw,pagLocal,logsTodos[id]||[]);
      const pago=valorPago>=total-0.01 && valorPago>0;

      entry.numero=pRaw.numero; entry.cliente=pRaw.contato?.nome||"—"; entry.vendedor=vendedorNome;
      entry.total=total; entry.dataPedido=pRaw.data;
      entry.formas=(historico||[]).map(h=>({nome:h.formaNome||"Não identificada",valor:+(h.valor||0)}));

      if(pago){
        // trava a data de pagamento agora, se ainda não tinha uma —
        // usa a hora real do nosso sistema (pagamentos.json) quando existir,
        // senão considera hoje como o dia em que detectamos o recebimento
        if(!entry.dataPagamento){
          const emReal=(pagLocal?.historico||[]).slice(-1)[0]?.em;
          entry.dataPagamento = emReal ? dataBR(emReal) : hoje;
        }
        entry.status="pago"; novosPagos++;
      } else {
        entry.status = valorPago>0 ? "parcial" : "pendente";
        if(entry.status==="parcial") novosParciais++; else novosPendentes++;
      }
      ledger[id]=entry;
      atualizados++;
    }
    salvarLedger(ledger);
    send({tipo:"done",atualizados,jaEstavaPago,totalPedidos:lista.length,novosPagos,novosPendentes,novosParciais});
  }catch(e){ send({tipo:"erro",erro:e.message}); }
  clearInterval(heartbeat);
  res.end();
});

// Lê o relatório diário direto da ficha local (rápido, sem chamar o Bling).
// modo=pagamento (padrão): agrupa pelo dia em que o dinheiro foi de fato
// recebido — esse é o número que fecha o caixa e não muda depois.
// modo=pedido: agrupa pelo dia em que o pedido foi criado (útil pra ver o que
// ainda está em aberto/sem pagamento daquele dia, mesmo que feche em outro dia).
// Limpa a ficha local — tudo, ou só as entradas de um período (por data do PEDIDO).
// Não mexe no Bling, só apaga o que está guardado aqui pra poder sincronizar de novo do zero.
app.post("/api/ledger/limpar", requireAdmin, (req,res)=>{
  const {dataInicial,dataFinal}=req.body||{};
  const ledger=lerLedger();
  if(!dataInicial||!dataFinal){
    const qtd=Object.keys(ledger).length;
    salvarLedger({});
    return res.json({ok:true,removidos:qtd,modo:"tudo"});
  }
  let removidos=0;
  for(const id of Object.keys(ledger)){
    const dp=ledger[id].dataPedido;
    if(dp && dp>=dataInicial && dp<=dataFinal){ delete ledger[id]; removidos++; }
  }
  salvarLedger(ledger);
  res.json({ok:true,removidos,modo:"periodo",dataInicial,dataFinal});
});

app.get("/api/ledger/relatorio", (req,res)=>{
  const modo=req.query.modo==="pedido"?"pedido":"pagamento";
  const dataRegex=/^\d{4}-\d{2}-\d{2}$/;
  let dataInicial=req.query.dataInicial, dataFinal=req.query.dataFinal;
  if(!dataInicial||!dataFinal){
    const data=req.query.data;
    if(!dataRegex.test(data||"")) return res.status(400).json({erro:"informe ?data=AAAA-MM-DD ou ?dataInicial=&dataFinal="});
    dataInicial=data; dataFinal=data;
  }
  if(!dataRegex.test(dataInicial)||!dataRegex.test(dataFinal)) return res.status(400).json({erro:"datas em formato inválido (AAAA-MM-DD)"});
  const campo=modo==="pedido"?"dataPedido":"dataPagamento";
  const ledger=lerLedger();
  const linhas=Object.values(ledger).filter(e=>e[campo] && e[campo]>=dataInicial && e[campo]<=dataFinal && e.status!=="cancelado");
  const pagos=linhas.filter(e=>e.status==="pago");
  const naoPagos=linhas.filter(e=>e.status!=="pago");

  const porForma={}, porVendedor={};
  pagos.forEach(e=>{
    (e.formas||[]).forEach(f=>{
      if(!porForma[f.nome]) porForma[f.nome]={valor:0,qtd:0};
      porForma[f.nome].valor+=f.valor; porForma[f.nome].qtd++;
    });
    const vend=e.vendedor||"Sem vendedor";
    if(!porVendedor[vend]) porVendedor[vend]={valor:0,qtd:0,formas:{}};
    porVendedor[vend].valor+=e.total; porVendedor[vend].qtd++;
    (e.formas||[]).forEach(f=>{
      if(!porVendedor[vend].formas[f.nome]) porVendedor[vend].formas[f.nome]={valor:0,qtd:0};
      porVendedor[vend].formas[f.nome].valor+=f.valor; porVendedor[vend].formas[f.nome].qtd++;
    });
  });

  res.json({
    dataInicial, dataFinal, modo,
    totalPago:+pagos.reduce((s,e)=>s+e.total,0).toFixed(2), qtdPagos:pagos.length,
    totalNaoPago:+naoPagos.reduce((s,e)=>s+e.total,0).toFixed(2), qtdNaoPagos:naoPagos.length,
    formasPagamento:Object.entries(porForma).map(([nome,v])=>({nome,valor:+v.valor.toFixed(2),qtd:v.qtd})).sort((a,b)=>b.valor-a.valor),
    porVendedor:Object.entries(porVendedor).map(([nome,v])=>({
      nome,valor:+v.valor.toFixed(2),qtd:v.qtd,
      formas:Object.entries(v.formas).map(([n,x])=>({nome:n,valor:+x.valor.toFixed(2),qtd:x.qtd})).sort((a,b)=>b.valor-a.valor),
    })).sort((a,b)=>b.valor-a.valor),
    pedidosPagos:pagos.map(e=>({numero:e.numero,cliente:e.cliente,vendedor:e.vendedor,total:e.total,dataPedido:e.dataPedido,dataPagamento:e.dataPagamento,formas:e.formas})).sort((a,b)=>String(a[campo]).localeCompare(String(b[campo]))),
    pedidosNaoPagos:naoPagos.map(e=>({numero:e.numero,cliente:e.cliente,vendedor:e.vendedor,total:e.total,dataPedido:e.dataPedido,status:e.status})).sort((a,b)=>String(a.dataPedido).localeCompare(String(b.dataPedido))),
  });
});


app.get("/api/fechamento-caixa/progresso", async(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.setHeader("X-Accel-Buffering","no"); // evita proxy segurar o buffer (Railway/nginx)
  res.flushHeaders();
  const send=(d)=>{ res.write(`data: ${JSON.stringify(d)}\n\n`); };
  // batimento cardíaco: mantém a conexão viva em buscas longas (evita o proxy
  // derrubar por "inatividade" mesmo com o processamento rodando normalmente)
  const heartbeat=setInterval(()=>{ try{ res.write(`: ping\n\n`); }catch(e){} },10000);
  res.on("close",()=>clearInterval(heartbeat));

  try{
    const dataRegex=/^\d{4}-\d{2}-\d{2}$/;
    let dataInicial=req.query.dataInicial, dataFinal=req.query.dataFinal;
    if(!dataInicial||!dataFinal){
      const data=req.query.data;
      if(!data||!dataRegex.test(data)){ send({tipo:"erro",erro:"informe ?data=AAAA-MM-DD ou ?dataInicial=&dataFinal="}); clearInterval(heartbeat); return res.end(); }
      dataInicial=data; dataFinal=data;
    }
    if(!dataRegex.test(dataInicial)||!dataRegex.test(dataFinal)){ send({tipo:"erro",erro:"datas em formato inválido (AAAA-MM-DD)"}); clearInterval(heartbeat); return res.end(); }
    const data=dataInicial; // mantido por compatibilidade no objeto de resposta

    const rapido=req.query.rapido==="1";
    send({tipo:"status",mensagem:dataInicial===dataFinal?"Buscando pedidos do dia…":"Buscando pedidos do período…"});
    const lista=[];
    for(let pg=1;pg<=100;pg++){
      const p=new URLSearchParams({pagina:pg,limite:100,dataInicial,dataFinal});
      const r=await bling(`/pedidos/vendas?${p.toString()}`);
      const arr=r.data||[]; lista.push(...arr);
      if(arr.length<100) break;
      // fila global ja garante o espacamento
    }
    send({tipo:"total",total:lista.length});

    const pags=lerPag();
    const logs=lerLog();
    const pedidosDetalhados=[];
    const porStatus={}, porVendedor={}, porFormaPagamento={}, porCliente={};
    let totalGeral=0, totalPago=0, totalNaoPago=0, totalCancelados=0, qtdCancelados=0;

    for(let i=0;i<lista.length;i++){
      const pRaw=lista[i];
      const id=String(pRaw.id);
      const sitNome=nomeSituacaoFechamento(pRaw.situacao?.id);
      const cancelado=sitNome==="Cancelado";

      // busca o detalhe do pedido ANTES de decidir o total — a listagem em
      // lote do Bling pode ficar desatualizada depois que os itens são
      // editados (ex: resolução de pendências ajustando mercadoria), então
      // sempre prioriza o valor do detalhe individual (mais confiável)
      let detPedido=null;
      if(!rapido && !cancelado){
        try{ const r=await bling(`/pedidos/vendas/${id}`); detPedido=r?.data||null; }catch(e){}
      }
      const total=+(detPedido?.total ?? pRaw.total ?? pRaw.totalProdutos ?? 0);

      if(cancelado){
        // cancelados não entram no total geral/pago/não pago — só contados à parte
        qtdCancelados++; totalCancelados+=total;
        if(!porStatus[sitNome]) porStatus[sitNome]={qtd:0,total:0};
        porStatus[sitNome].qtd++; porStatus[sitNome].total+=total;
        send({tipo:"progresso",atual:i+1,total:lista.length,pedido:pRaw.numero});
        continue;
      }
      totalGeral+=total;

      let vendedorNome, valorPago, historico, doBling, previsto;
      if(rapido){
        // modo rápido: não consulta detalhe do pedido (sem vendedor, sem checar parcela do Bling)
        vendedorNome="Não verificado (busca rápida)";
        const pagLocal=pags[id];
        valorPago=+(pagLocal?.valorPago||0); historico=pagLocal?.historico||[]; doBling=false; previsto=[];
      } else {
        const vendedorId=detPedido?.vendedor?.id||null;
        vendedorNome=await nomeVendedor(vendedorId);
        const pagLocal=pags[id];
        ({valorPago,historico,doBling,previsto}=await resolverPagamentoPedido(detPedido||pRaw,pagLocal,logs[id]||[]));
      }
      const pago=valorPago>=total-0.01&&valorPago>0;
      const parcial=!pago && valorPago>0; // pagou algo, mas não cobre o total
      const falta=+(total-valorPago).toFixed(2);
      // pagou a MAIS que o total (comum quando uma pendência é resolvida removendo
      // itens do pedido depois que ele já tinha sido pago no valor cheio) — precisa
      // de estorno pro cliente, mesmo contando como "pago" pra fins de fechamento
      const excedente=+(valorPago-total).toFixed(2);
      const precisaEstorno=excedente>0.01;
      if(pago) totalPago+=total; else totalNaoPago+=total;
      // pedido não pago do totem que ainda está com a parcela "Ficha Financeira"
      // (placeholder que o Bling exige na criação, sem nenhum pagamento real ainda)
      let fichaFinanceira=false;
      if(!pago&&detPedido?.parcelas?.length){
        for(const pc of detPedido.parcelas){
          const nomeForma=await nomeFormaPagamentoId(pc.formaPagamento?.id);
          if((nomeForma||"").toLowerCase().includes("ficha financeira")){ fichaFinanceira=true; break; }
        }
      }
      const clienteNome=pRaw.contato?.nome||"—";

      // por status
      if(!porStatus[sitNome]) porStatus[sitNome]={qtd:0,total:0};
      porStatus[sitNome].qtd++; porStatus[sitNome].total+=total;

      // por cliente (geral)
      if(!porCliente[clienteNome]) porCliente[clienteNome]={qtd:0,total:0};
      porCliente[clienteNome].qtd++; porCliente[clienteNome].total+=total;

      // por vendedor (com detalhamento aninhado de forma de pagamento e cliente)
      if(!porVendedor[vendedorNome]) porVendedor[vendedorNome]={qtd:0,total:0,pago:0,naoPago:0,porFormaPagamento:{},porCliente:{}};
      const v=porVendedor[vendedorNome];
      v.qtd++; v.total+=total;
      if(pago) v.pago+=total; else v.naoPago+=total;
      if(!v.porCliente[clienteNome]) v.porCliente[clienteNome]={qtd:0,total:0};
      v.porCliente[clienteNome].qtd++; v.porCliente[clienteNome].total+=total;

      // formas de pagamento — geral e por vendedor (do histórico local ou do heurístico do Bling)
      const formas=historico.length?historico:(pago?[{valor:valorPago,formaNome:doBling?"Bling (à vista)":"Sem forma registrada"}]:[]);
      formas.forEach(h=>{
        const nome=h.formaNome||"Outro"; const v2=Number(h.valor)||0; if(v2<=0) return;
        porFormaPagamento[nome]=(porFormaPagamento[nome]||0)+v2;
        v.porFormaPagamento[nome]=(v.porFormaPagamento[nome]||0)+v2;
      });

      pedidosDetalhados.push({
        numero:pRaw.numero, id:pRaw.id, data:pRaw.data, cliente:clienteNome, situacao:sitNome,
        vendedor:vendedorNome, total, valorPago, pago, parcial, falta, precisaEstorno, excedente, doBling, fichaFinanceira,
        formasPagamento:formas.map(h=>({nome:h.formaNome,valor:+(Number(h.valor)||0).toFixed(2),vencimento:h.aPrazo&&h.vencimento?h.vencimento.split('-').reverse().join('/'):''})),
        formasPrevisto:(previsto||[]).map(p=>({nome:p.formaNome,valor:+(Number(p.valor)||0).toFixed(2),vencimento:p.vencimento?p.vencimento.split('-').reverse().join('/'):''})),
      });

      send({tipo:"progresso",atual:i+1,total:lista.length,pedido:pRaw.numero});
    }

    const totalPrevisto=pedidosDetalhados.filter(p=>p.pago&&p.formasPrevisto?.length).reduce((s,p)=>s+p.total,0);
    const qtdPrevisto=pedidosDetalhados.filter(p=>p.pago&&p.formasPrevisto?.length).length;
    const totalFichaFinanceira=pedidosDetalhados.filter(p=>p.fichaFinanceira).reduce((s,p)=>s+p.total,0);
    const qtdFichaFinanceira=pedidosDetalhados.filter(p=>p.fichaFinanceira).length;
    // pagamentos parciais: pagou algo mas não cobre o total do pedido
    const parciais=pedidosDetalhados.filter(p=>p.parcial);
    const qtdParciais=parciais.length;
    const totalFaltaParciais=+parciais.reduce((s,p)=>s+p.falta,0).toFixed(2);
    // pagos a MAIS que o total — geralmente pendência resolvida com itens removidos
    // depois do pagamento cheio; precisa devolver o excedente pro cliente
    const precisamEstorno=pedidosDetalhados.filter(p=>p.precisaEstorno);
    const qtdPrecisamEstorno=precisamEstorno.length;
    const totalExcedenteEstorno=+precisamEstorno.reduce((s,p)=>s+p.excedente,0).toFixed(2);
    res.write(`data: ${JSON.stringify({tipo:"done",relatorio:{
      data, dataInicial, dataFinal, totalPedidos:lista.length, totalGeral:+totalGeral.toFixed(2),
      totalPago:+totalPago.toFixed(2), totalNaoPago:+totalNaoPago.toFixed(2),
      totalCancelados:+totalCancelados.toFixed(2), qtdCancelados,
      totalPrevisto:+totalPrevisto.toFixed(2), qtdPrevisto,
      totalFichaFinanceira:+totalFichaFinanceira.toFixed(2), qtdFichaFinanceira,
      qtdParciais, totalFaltaParciais,
      qtdPrecisamEstorno, totalExcedenteEstorno,
      porStatus, porVendedor, porFormaPagamento, porCliente, pedidos:pedidosDetalhados,
    }})}\n\n`);
  }catch(e){ send({tipo:"erro",erro:e.message}); }
  clearInterval(heartbeat);
  res.end();
});


app.get("/expedicao", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "expedicao.html")); });
app.get("/caixa", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "caixa.html")); });
app.get("/caixa-diario", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "caixa-diario.html")); });
app.get("/gestao-caixas", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "gestao-caixas.html")); });
app.get("/caixa-atacado", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "caixa-atacado.html")); });
app.get("/frente-caixa", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "frente-caixa.html")); });
app.get("/lista-fardo", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "lista-fardo.html")); });
app.get("/etiquetas", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "etiquetas.html")); });
app.get("/listas-extras", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "listas-extras.html")); });
app.get("/gestao", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "gestao.html")); });
app.get("/rotas", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "rotas.html")); });
app.get("/estoque", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "estoque-painel.html")); });
app.get("/estoque-simples", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "estoque-simples.html")); });
app.get("/entrada-estoque", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "entrada-estoque.html")); });
app.get("/movimentacoes", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "movimentacoes.html")); });
app.get("/gerenciamento", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "gerenciamento.html")); });
app.get("/funcionarios", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "funcionarios.html")); });
app.get("/operacional", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "operacional.html")); });
app.get("/painel-pedidos", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "painel-pedidos.html")); });
// Retorna o preço de um produto pelo código (usa cache de estoque + busca direta no Bling)
app.get("/api/preco-codigo", async (req, res) => {
  try {
    const codigo = String(req.query.codigo || "").trim();
    if (!codigo) return res.status(400).json({ erro: "?codigo=..." });
    // tenta primeiro no mapa de estoque (cache)
    const est = await getEstoqueMap();
    const item = est[codigo];
    if (item?.id) {
      // busca o produto pelo id pra pegar o preço atualizado
      try {
        const p = await bling(`/produtos/${item.id}`);
        const preco = p?.data?.preco ?? 0;
        return res.json({ codigo, preco, nome: p?.data?.nome || item.nome });
      } catch(e) {}
    }
    // fallback: busca por código direto
    const d = await bling(`/produtos?codigo=${encodeURIComponent(codigo)}&limite=1`);
    const prod = (d.data || [])[0];
    res.json({ codigo, preco: prod?.preco ?? 0, nome: prod?.nome || "" });
  } catch(e) { res.status(e.status||500).json({ erro: e.message }); }
});
app.get("/conferencia",(req,res)=>res.sendFile(path.join(__dirname,"conferencia.html")));
// Config pública (situações)
app.get("/api/config",(req,res)=>res.json({SIT}));

// bancos do PIX (pra a pergunta "qual banco?" no caixa atacado) — editáveis na Gestão
function lerPixBancos(){
  const d=lerJSON(PIX_BANCOS_FILE,null);
  let bancos=(d&&Array.isArray(d.bancos))?d.bancos.map(b=>String(b||"").trim()).filter(Boolean):[];
  if(!bancos.length) bancos=["Inter","Santander","Itaú"];
  const padrao=(d&&d.padrao&&bancos.includes(d.padrao))?d.padrao:bancos[0];
  return {bancos,padrao};
}
app.get("/api/pix-bancos",(req,res)=>{ res.json(lerPixBancos()); });
app.post("/api/pix-bancos",(req,res)=>{
  const {bancos,padrao}=req.body||{};
  const lista=(Array.isArray(bancos)?bancos:[]).map(b=>String(b||"").trim()).filter(Boolean);
  const vistos=new Set(); const limpa=[];
  for(const b of lista){ const k=b.toLowerCase(); if(!vistos.has(k)){ vistos.add(k); limpa.push(b); } }
  if(!limpa.length) return res.status(400).json({erro:"informe ao menos um banco"});
  const pad=(padrao&&limpa.includes(padrao))?padrao:limpa[0];
  salvarJSON(PIX_BANCOS_FILE,{bancos:limpa,padrao:pad});
  res.json({ok:true,bancos:limpa,padrao:pad});
});
// tela INTERNA de gestão da tabela de atacado (renomeada de /tabela pra /tabela-atacado
// pra liberar o /tabela como link curto do cliente). Precisa de login/permissão.
app.get("/tabela-atacado",(req,res)=>res.sendFile(path.join(__dirname,"tabela.html")));
// mantém /tabela-interna como apelido, caso algum link antigo aponte pra cá
app.get("/tabela-interna",(req,res)=>res.sendFile(path.join(__dirname,"tabela.html")));
app.get("/listas", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "listas.html")); });
app.get("/dashboard", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "dashboard.html")); });
app.get("/perdas", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "perdas.html")); });
app.get("/venda-atacado", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "venda-atacado.html")); });
app.get("/propostas", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "propostas.html")); });
// ===== RELATÓRIO DE ENTRADAS POR PRODUTO (Com NF x Sem papel) =====
// Vem dos PEDIDOS DE COMPRA. Cada item tem notaFiscal.id: se != 0 -> entrou COM nota
// fiscal; se 0 -> entrou SEM papel. Abrir o detalhe de cada compra é pesado, então
// calcula em SEGUNDO PLANO e guarda em cache por mês.
function lerEntradasCache(){ return lerJSON(ENTRADAS_CACHE_FILE,{}); }
function salvarEntradasCache(d){ salvarJSON(ENTRADAS_CACHE_FILE,d); }
function _mesAtual(){ const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}`; }
function _rangeMes(mes){
  const [a,m]=mes.split("-").map(Number);
  const ini=`${a}-${String(m).padStart(2,"0")}-01`;
  const fimD=new Date(a,m,0);
  const fim=`${fimD.getFullYear()}-${String(fimD.getMonth()+1).padStart(2,"0")}-${String(fimD.getDate()).padStart(2,"0")}`;
  return {ini,fim};
}
let _entradasCalculando={};
async function calcularEntradasMes(mes){
  if(_entradasCalculando[mes]) return;
  _entradasCalculando[mes]=true;
  const {ini,fim}=_rangeMes(mes);
  const iniH=`${ini} 00:00:00`, fimH=`${fim} 23:59:59`;
  try{
    // ===== fontes =====
    // COM NF: notas fiscais de ENTRADA (/nfe tipo 0) — as notas de compra do fornecedor
    let notas=[], pag=1;
    for(let i=0;i<15;i++){
      const p=new URLSearchParams({tipo:"0", dataEmissaoInicial:iniH, dataEmissaoFinal:fimH, pagina:String(pag), limite:"100"});
      const r=await blingLento(`/nfe?${p.toString()}`); const arr=r?.data||[];
      notas=notas.concat(arr); if(arr.length<100) break; pag++; await sleep(150);
    }
    // SEM PAPEL: pedidos de compra do mês (entradas sem nota vinculada)
    let compras=[]; pag=1;
    for(let i=0;i<15;i++){
      const p=new URLSearchParams({dataInicial:ini, dataFinal:fim, pagina:String(pag), limite:"100"});
      const r=await blingLento(`/pedidos/compras?${p.toString()}`); const arr=r?.data||[];
      compras=compras.concat(arr); if(arr.length<100) break; pag++; await sleep(150);
    }
    const totalDocs=notas.length+compras.length;
    const cache=lerEntradasCache();
    cache[mes]={ status:"calculando", calculadoEm:Date.now(), comNF:{}, semPapel:{}, totalCompras:totalDocs, processadas:0 };
    salvarEntradasCache(cache);

    const comNF={}, semPapel={};
    const soma=(bucket,it)=>{
      const pid=String(it.produto?.id||it.descricao||"?");
      if(!bucket[pid]) bucket[pid]={nome:it.descricao||("produto "+pid), codigo:it.produto?.codigo||"", qtd:0, valor:0};
      bucket[pid].qtd += Number(it.quantidade)||0;
      bucket[pid].valor += (Number(it.quantidade)||0)*(Number(it.valor)||0);
    };
    let feitas=0;
    const marcarProgresso=()=>{ feitas++; if(feitas%5===0){ const cc=lerEntradasCache(); if(cc[mes]){ cc[mes].processadas=feitas; salvarEntradasCache(cc); } } };

    // COM NF — abre o detalhe de cada nota de entrada e soma os itens
    for(const n of notas){
      try{ const d=await blingLento(`/nfe/${n.id}`).then(r=>r?.data); (d?.itens||[]).forEach(it=>soma(comNF,it)); }catch(e){}
      marcarProgresso(); await sleep(120);
    }
    // SEM PAPEL — abre o detalhe de cada pedido de compra e soma os itens
    for(const c of compras){
      try{ const d=await blingLento(`/pedidos/compras/${c.id}`).then(r=>r?.data); (d?.itens||[]).forEach(it=>soma(semPapel,it)); }catch(e){}
      marcarProgresso(); await sleep(120);
    }

    const cache2=lerEntradasCache();
    cache2[mes]={ status:"pronto", calculadoEm:Date.now(), comNF, semPapel, totalCompras:totalDocs, processadas:feitas, qtdNotas:notas.length, qtdCompras:compras.length };
    salvarEntradasCache(cache2);
  }catch(e){
    const cache=lerEntradasCache();
    cache[mes]={ ...(cache[mes]||{}), status:"erro", erro:e.message, calculadoEm:Date.now() };
    salvarEntradasCache(cache);
  }finally{ _entradasCalculando[mes]=false; }
}

// devolve o relatório do mês (do cache); calcula em 2º plano se não tiver ou se pedir recalcular
app.get("/api/entradas/mes",(req,res)=>{
  const mes=(req.query.mes||_mesAtual());
  const recalc=req.query.recalcular==="1";
  const cache=lerEntradasCache();
  const item=cache[mes];
  if(recalc || !item){ calcularEntradasMes(mes); return res.json({mes, status:"calculando", processadas:0, totalCompras:(item?.totalCompras||0)}); }
  if(item.status==="calculando" && !_entradasCalculando[mes]) calcularEntradasMes(mes); // retoma se travou
  const resumir=(obj)=>{
    const lista=Object.values(obj||{}).sort((a,b)=>b.qtd-a.qtd);
    const qtd=lista.reduce((s,x)=>s+x.qtd,0), valor=+lista.reduce((s,x)=>s+x.valor,0).toFixed(2);
    return {itens:lista, totalQtd:qtd, totalValor:valor, skus:lista.length};
  };
  res.json({ mes, status:item.status, calculadoEm:item.calculadoEm, totalCompras:item.totalCompras, processadas:item.processadas,
    erro:item.erro||null, comNF:resumir(item.comNF), semPapel:resumir(item.semPapel) });
});

// ===== PAINEL DE AVISOS =====
// Registra eventos que precisam de conferência humana (ex: auto-correção de estoque
// numa edição, Bling recusou algo, divergência caixa x Bling). Guarda o máximo de
// detalhe pra dar pra rastrear depois.
function lerAvisos(){ const d=lerJSON(AVISOS_FILE,{lista:[]}); if(!Array.isArray(d.lista)) d.lista=[]; return d; }
function salvarAvisos(d){ salvarJSON(AVISOS_FILE,d); }
function registrarAviso(aviso){
  try{
    const d=lerAvisos();
    if(aviso.fingerprint && (d.lista||[]).some(a=>a.fingerprint===aviso.fingerprint)) return null; // já existe, não duplica
    const id="av-"+Date.now()+"-"+Math.random().toString(36).slice(2,7);
    d.lista.unshift({ id, em:Date.now(), resolvido:false, ...aviso });
    if(d.lista.length>500) d.lista=d.lista.slice(0,500); // não cresce infinito
    salvarAvisos(d);
    return id;
  }catch(e){ console.error("Falha ao registrar aviso:",e.message); return null; }
}

// ===== AUDITORIA GERAL: roda todos os testes de consistência numa passada só e =====
// registra os problemas achados no painel de Avisos (com dedupe por fingerprint, pra
// não repetir o mesmo aviso toda vez que rodar). Cobre: caixa x Bling divergente,
// pedidos duplicados em 2 caixas, caixa esquecido aberto, NFC-e pendente há dias,
// pedidos Atendido que não passaram no caixa atacado (fora de vendedor de varejo).
async function rodarAuditoriaGeral(diasCaixaBling=1){
  const achados={ caixaBlingDivergente:0, pedidosDuplicados:0, caixaEsquecidoAberto:0, atacadoSemPassarCaixa:0, entregaSemPagamento:0 };
  const hojeISO=_hojeISO();
  // 1) caixa x Bling (últimos N dias) — reaproveita a lógica de /api/diag/sync-caixa-bling
  try{
    const desde=Date.now()-diasCaixaBling*86400000;
    const dCx=lerCaixaSessoes(); const vendas=[];
    (dCx.sessoes||[]).forEach(s=>{ if((s.tipoCaixa||"frente")!=="atacado") return; (s.movimentos||[]).forEach(m=>{ if(m.tipo!=="venda"||m.cancelado||m.em<desde) return; vendas.push({pedidoId:m.pedidoId,numero:m.numero,total:Number(m.total)||0,pagamentos:(m.pagamentos||[]).map(p=>({forma:p.formaNome||"—",valor:Number(p.valor)||0})),em:m.em,operador:m.operador||s.operador}); }); });
    const norm=(s)=>String(s||"").toLowerCase().replace(/pix.*/,"pix").replace(/[^a-z0-9]/g,"");
    for(const v of vendas.slice(0,60)){
      let b=null; try{ b=await blingLento(`/pedidos/vendas/${v.pedidoId}`).then(r=>r?.data); }catch(e){}
      if(!b){ registrarAviso({ tipo:"caixa_bling_nao_encontrado", titulo:`Pedido #${v.numero||v.pedidoId} não encontrado no Bling`, pedidoId:v.pedidoId, numero:v.numero, operador:v.operador, origem:"Auditoria", fingerprint:`nfenc-${v.pedidoId}`, oQueFazer:`Confira se o pedido #${v.numero||v.pedidoId} existe no Bling. Se não existir, a venda foi registrada no caixa mas não foi salva no Bling.` }); achados.caixaBlingDivergente++; continue; }
      const parcelas=[]; for(const pc of (b.parcelas||[])){ parcelas.push({forma:await nomeFormaPagamentoId(pc.formaPagamento?.id), valor:Number(pc.valor)||0}); }
      const somaCaixa=+v.pagamentos.reduce((s,p)=>s+p.valor,0).toFixed(2), somaBling=+parcelas.reduce((s,p)=>s+p.valor,0).toFixed(2);
      const formasCaixa=v.pagamentos.map(p=>norm(p.forma)).sort().join("|"), formasBling=parcelas.map(p=>norm(p.forma)).sort().join("|");
      if(Math.abs(v.total-(Number(b.total)||0))>0.009 || Math.abs(somaCaixa-somaBling)>0.009 || formasCaixa!==formasBling){
        registrarAviso({ tipo:"caixa_bling_divergente", titulo:`Pedido #${v.numero||v.pedidoId} diferente entre caixa e Bling`, pedidoId:v.pedidoId, numero:v.numero, operador:v.operador, origem:"Auditoria",
          fingerprint:`div-${v.pedidoId}-${hojeISO}`, erroBling:`Caixa: ${somaCaixa} (${v.pagamentos.map(p=>p.forma).join(", ")}) — Bling: ${somaBling} (${parcelas.map(p=>p.forma).join(", ")})`,
          oQueFazer:`Confira o pedido #${v.numero||v.pedidoId} no Bling e ajuste pra bater com o caixa, ou vice-versa.` });
        achados.caixaBlingDivergente++;
      }
      await sleep(100);
    }
  }catch(e){}
  // 2) pedidos duplicados: mesmo pedido registrado em CAIXAS DIFERENTES (grave — pode
  // contar 2x no fechamento) ou 2+ vezes ATIVAS na mesma sessão (suspeito). Varre os
  // últimos 30 dias, não só hoje, pra pegar casos antigos que passaram batido.
  try{
    const desde=Date.now()-30*86400000;
    const dCx=lerCaixaSessoes(); const porPedido={};
    (dCx.sessoes||[]).forEach(s=>(s.movimentos||[]).forEach(m=>{
      if(m.tipo!=="venda"||m.cancelado||m.em<desde) return;
      const pid=String(m.pedidoId||m.numero||""); if(!pid) return;
      (porPedido[pid]=porPedido[pid]||[]).push({sessaoId:s.id,operador:s.operador||"—",total:m.total,em:m.em,numero:m.numero||pid});
    }));
    Object.entries(porPedido).forEach(([pid,ocs])=>{
      const sessoes=new Set(ocs.map(o=>o.sessaoId));
      const num=ocs[0]?.numero||pid;
      const quando=ocs.map(o=>new Date(o.em).toLocaleDateString("pt-BR",{timeZone:"America/Sao_Paulo"}));
      if(sessoes.size>=2){
        const ops=[...new Set(ocs.map(o=>o.operador))].join(", ");
        registrarAviso({ tipo:"pedido_duplicado_caixas", titulo:`Pedido #${num} registrado em ${sessoes.size} caixas diferentes`, pedidoId:pid, numero:num, origem:"Auditoria",
          fingerprint:`dup-caixas-${pid}`,
          oQueFazer:`O pedido #${num} foi lançado em caixas diferentes (${ops}) em ${[...new Set(quando)].join(", ")}. Pode estar contando a venda 2x no fechamento — confira e cancele o lançamento errado pela Gestão de Caixas.` });
        achados.pedidosDuplicados++;
      } else if(ocs.length>=2){
        registrarAviso({ tipo:"pedido_duplicado_sessao", titulo:`Pedido #${num} lançado ${ocs.length}x no mesmo caixa`, pedidoId:pid, numero:num, origem:"Auditoria",
          fingerprint:`dup-sessao-${pid}-${ocs.length}`,
          oQueFazer:`O pedido #${num} tem ${ocs.length} lançamentos ativos no caixa de ${ocs[0].operador} (${[...new Set(quando)].join(", ")}). Se não foi reabertura/edição, um deles é duplicado — cancele o lançamento errado pela Gestão de Caixas.` });
        achados.pedidosDuplicados++;
      }
    });
  }catch(e){}
  // 3) caixa aberto há mais de 15h (provável esquecimento)
  try{
    const dCx=lerCaixaSessoes(); const limite=Date.now()-15*3600*1000;
    (dCx.sessoes||[]).filter(s=>!s.fechadaEm && s.abertaEm<limite).forEach(s=>{
      registrarAviso({ tipo:"caixa_esquecido_aberto", titulo:`Caixa de ${s.operador||"—"} aberto há mais de 15h`, origem:"Auditoria", fingerprint:`esq-${s.id}`, oQueFazer:`O caixa de ${s.operador||"—"} (${s.tipoCaixa||"frente"}) está aberto desde ${new Date(s.abertaEm).toLocaleString("pt-BR")}. Confira se foi esquecido e feche pela Gestão de Caixas.` });
      achados.caixaEsquecidoAberto++;
    });
  }catch(e){}
  // (removido) o aviso de "venda sem NFC-e há X dias" saía pra toda venda do atacado
  // sem nota emitida PELO SISTEMA — mas muitas são emitidas direto no Bling, então era
  // ruído. Agora só avisa quando a emissão é TENTADA e FALHA (nfce_falhou /
  // nfce_nao_transmitida, gerados na finalização da venda).

  // 4.5) ENTREGA AGENDADA SEM PAGAMENTO: pedido que já passou do dia da entrega
  // (ou é de hoje) e ainda não foi recebido em nenhum caixa. É o caso mais caro:
  // a mercadoria sai e ninguém cobrou.
  try{
    const turnos=lerJSON(`${DATA_DIR}/turnos_entrega.json`,{});
    const props=lerPropostas(); const porPedido={};
    Object.values(props||{}).forEach(p=>{ if(p.pedidoBlingId) porPedido[String(p.pedidoBlingId)]=p; });
    const hojeIni=_inicioDia(hojeISO);
    Object.entries(turnos).forEach(([pid,ag])=>{
      if(!ag||!ag.data) return;
      const iniDia=_inicioDia(ag.data);
      if(iniDia>hojeIni) return;                       // entrega futura: ainda não é problema
      if(iniDia<hojeIni-30*86400000) return;           // muito antiga: não fica repetindo
      const sit=_sitOnline[pid];
      if(sit&&sit.situacaoId===SIT.CANCELADO) return;  // cancelado não conta
      const pag=_pagamentoDoPedido(pid);
      if(pag.pago) return;
      const prop=porPedido[pid]||null;
      const numero=ag.numero||prop?.pedidoBlingNumero||pid;
      const total=Number(prop?.total||0);
      const cliente=prop?.cliente?.nome||"—";
      const ehHoje=iniDia===hojeIni;
      registrarAviso({ tipo:"entrega_sem_pagamento",
        titulo:`Entrega ${ehHoje?"de hoje":"de "+ag.data.split("-").reverse().join("/")} sem pagamento — pedido #${numero}`,
        pedidoId:pid, numero, origem:"Gerenciamento de Rota",
        fingerprint:`entrsempag-${pid}-${ag.data}`,
        novoTotal:total,
        oQueFazer:`O pedido #${numero} (${cliente}${total?`, ${total.toFixed(2)}`:""}) está agendado pra entrega em ${ag.data.split("-").reverse().join("/")} e ainda NÃO foi recebido em nenhum caixa${pag.parcial?` (pago parcial: ${Number(pag.valorPago||0).toFixed(2)} de ${Number(pag.valorPedido||0).toFixed(2)})`:""}. Confira se foi cobrado antes de sair pra entrega.` });
      achados.entregaSemPagamento=(achados.entregaSemPagamento||0)+1;
    });
  }catch(e){}

  // 5) pedidos Atendido no Bling que não passaram pelo caixa atacado — usa a
  // classificação já pronta (campo p.origem), feita na mesma varredura, sem recalcular
  try{
    if(_centralBling.dia===hojeISO && _centralBling.pedidos && !_centralBling.pedidos.erro){
      (_centralBling.pedidos.lista||[]).forEach(p=>{
        if(p.origem!=="possivel_erro") return;
        registrarAviso({ tipo:"atacado_sem_passar_caixa", titulo:`Pedido #${p.numero} Atendido mas não passou no caixa atacado`, numero:p.numero, origem:"Auditoria", fingerprint:`avejo-${p.id}-${hojeISO}`, oQueFazer:`Pedido #${p.numero} (${p.cliente}, vendedor ${p.vendedor}) está Atendido no Bling mas não tem registro no caixa atacado. Confira se foi cobrado por outro caminho ou se ficou pendente.` });
        achados.atacadoSemPassarCaixa++;
      });
    }
  }catch(e){}
  return achados;
}

app.get("/api/auditoria/rodar",async(req,res)=>{
  try{ const achados=await rodarAuditoriaGeral(Number(req.query.dias||1)); res.json({ok:true, achados, em:Date.now()}); }
  catch(e){ res.status(500).json({erro:e.message}); }
});

app.get("/api/avisos",(req,res)=>{
  const incluirResolvidos=req.query.todos==="1";
  const d=lerAvisos();
  let lista=d.lista||[];
  if(!incluirResolvidos) lista=lista.filter(a=>!a.resolvido);
  res.json({ lista:lista.slice(0,200), naoResolvidos:(d.lista||[]).filter(a=>!a.resolvido).length, total:(d.lista||[]).length });
});
app.get("/api/avisos/contagem",(req,res)=>{
  const d=lerAvisos();
  res.json({ naoResolvidos:(d.lista||[]).filter(a=>!a.resolvido).length });
});
// marca TODOS os avisos pendentes como resolvidos de uma vez
app.post("/api/avisos/resolver-todos",(req,res)=>{
  try{
    const d=lerAvisos();
    const por=req.body?.por||"";
    let n=0;
    (d.lista||[]).forEach(a=>{ if(!a.resolvido){ a.resolvido=true; a.resolvidoEm=Date.now(); a.resolvidoPor=por; a.resolvidoEmLote=true; n++; } });
    salvarAvisos(d);
    res.json({ok:true, resolvidos:n});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.post("/api/avisos/:id/resolver",(req,res)=>{
  const d=lerAvisos(); const a=(d.lista||[]).find(x=>x.id===req.params.id);
  if(!a) return res.status(404).json({erro:"aviso não encontrado"});
  a.resolvido=true; a.resolvidoEm=Date.now(); a.resolvidoPor=req.body?.por||"";
  salvarAvisos(d); res.json({ok:true});
});

// ===== CENTRAL (página inicial): resumo geral do dia =====
// Varre o sistema (caixas abertos E fechados, logs, pagamentos, propostas, avisos, NFC-e)
// e o Bling (notas, entradas, pedidos por vendedor, pedidos em aberto). Datas SEMPRE no
// horário de Brasília (o servidor roda em UTC e "virava o dia" às 21h).
let _centralBling={ em:0, calculando:false, dia:null };
function _hojeISO(dia){
  if(dia&&/^\d{4}-\d{2}-\d{2}$/.test(dia)) return dia;
  const n=new Date(new Date().toLocaleString("en-US",{timeZone:"America/Sao_Paulo"}));
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`;
}
function _inicioDia(iso){ return new Date(iso+"T00:00:00-03:00").getTime(); }
function _fimDia(iso){ return _inicioDia(iso)+86400000; }

async function _atualizarCentralBling(dia){
  if(_centralBling.calculando) return;
  _centralBling.calculando=true;
  const out={ em:Date.now(), calculando:true, dia, erro:null };
  // publica parcialmente: antes o resultado só aparecia no FIM da varredura (que leva
  // minutos), então o card do varejo ficava sem dado. Agora cada etapa que termina já vai pra tela.
  const publicar=()=>{ _centralBling={...out, calculando:true}; };
  try{
    // pedidos de venda do dia: varre igual ao Fechamento de Caixa (mesma fonte e mesmos
    // helpers), classifica Atacado x Varejo e DEDUPLICA contra o nosso caixa numa
    // passada só. Regras:
    //  - Consumidor Final (por ID do contato) => sempre VAREJO
    //  - pedido presente no caixa atacado => ATACADO
    //  - vendedor de varejo (Jéssica/Andreia) => VAREJO
    //  - Atendido, não é varejo e não passou no caixa => POSSÍVEL ERRO
    // Também detecta duplicidade cruzando os DOIS lados (nosso caixa e o Bling).
    try{
      const VENDEDORES_VAREJO=/j[ée]ssica|andr[ée]ia/i;
      const dCx=lerCaixaSessoes();
      // índice do NOSSO caixa: pedidoId -> lançamentos ativos (pra dedupe e p/ origem)
      const noCaixa={};
      (dCx.sessoes||[]).forEach(s=>(s.movimentos||[]).forEach(m=>{
        if(m.tipo!=="venda"||m.cancelado||!m.pedidoId) return;
        const k=String(m.pedidoId);
        (noCaixa[k]=noCaixa[k]||[]).push({sessaoId:s.id,operador:s.operador||"",tipoCaixa:s.tipoCaixa||"frente",em:m.em,total:Number(m.total)||0,numero:m.numero});
      }));
      let pag=1, lista=[];
      for(let i=0;i<10;i++){
        const r=await blingLento(`/pedidos/vendas?dataInicial=${dia}&dataFinal=${dia}&pagina=${pag}&limite=100`);
        const arr=r?.data||[]; lista=lista.concat(arr);
        if(arr.length<100) break; pag++; await sleep(150);
      }
      // DEDUPE do lado do Bling: a listagem pode repetir o mesmo pedido entre páginas
      const vistos=new Set(); const duplicadosBling=[];
      lista=lista.filter(p=>{ const k=String(p.id); if(vistos.has(k)){ duplicadosBling.push(p.numero); return false; } vistos.add(k); return true; });

      const detalhados=[];
      for(const p of lista.slice(0,250)){
        let vendedor="(sem vendedor)", contatoId=p.contato?.id||null, cliente=p.contato?.nome||"—", totalDet=Number(p.total)||0, parcelas=[], itensPed=[];
        try{
          const d=await blingLento(`/pedidos/vendas/${p.id}`).then(x=>x?.data);
          if(d){
            vendedor=await nomeVendedor(d.vendedor?.id||null); contatoId=d.contato?.id||contatoId;
            cliente=d.contato?.nome||cliente; totalDet=Number(d.total ?? p.total)||0;
            // formas de pagamento do próprio Bling (é como o varejo/PDV registra —
            // esse dinheiro não passa pelos nossos caixas)
            for(const pc of (d.parcelas||[])){
              parcelas.push({forma:await nomeFormaPagamentoId(pc.formaPagamento?.id), valor:Number(pc.valor)||0});
            }
            itensPed=(d.itens||[]).map(i=>({nome:i.descricao||i.produto?.nome||"produto", quantidade:Number(i.quantidade)||0, valor:Number(i.valor)||0}));
          }
        }catch(e){}
        const consumidorFinal = contatoId===CONSUMIDOR_FINAL_ID || /consumidor\s*final/i.test(cliente||"");
        const situacaoId=Number(p.situacao?.id||0);
        const lancs=noCaixa[String(p.id)]||[];
        const noCaixaAtacado=lancs.some(l=>l.tipoCaixa==="atacado");
        let origem;
        if(consumidorFinal) origem="varejo";                       // Consumidor Final SEMPRE varejo
        else if(noCaixaAtacado) origem="atacado";
        else if(VENDEDORES_VAREJO.test(vendedor)) origem="varejo";
        else if(situacaoId===SIT.ATENDIDO) origem="possivel_erro"; // Atendido e não passou no caixa
        else origem="varejo_pendente";
        detalhados.push({ id:p.id, numero:p.numero, vendedor, cliente, consumidorFinal, origem,
          total:totalDet, situacaoId, situacao:nomeSituacao(situacaoId), parcelas, itens:itensPed,
          lancamentosNoCaixa:lancs.length, caixas:lancs.map(l=>l.operador) });
        await sleep(80);
      }

      // DUPLICIDADES (cruzando os dois lados)
      const dupNoCaixa=detalhados.filter(p=>p.lancamentosNoCaixa>1)
        .map(p=>({numero:p.numero,pedidoId:p.id,cliente:p.cliente,totalBling:p.total,vezes:p.lancamentosNoCaixa,
          caixas:(noCaixa[String(p.id)]||[]).map(l=>({operador:l.operador,quando:new Date(l.em).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"}),total:l.total})),
          somaNoCaixa:+(noCaixa[String(p.id)]||[]).reduce((a,l)=>a+l.total,0).toFixed(2)}));
      // no caixa mas o pedido não apareceu no Bling deste dia (pedido de outro dia ou sumiu)
      const idsBling=new Set(detalhados.map(d=>String(d.id)));
      const iniDia=_inicioDia(dia), fimDia=_fimDia(dia);
      const soNoCaixa=[];
      Object.entries(noCaixa).forEach(([pid,lancs])=>{
        const doDia=lancs.filter(l=>l.em>=iniDia&&l.em<fimDia);
        if(doDia.length&&!idsBling.has(pid)) soNoCaixa.push({pedidoId:pid,numero:doDia[0].numero,operador:doDia[0].operador,total:doDia[0].total});
      });

      const porVend={}; const emAberto=[];
      detalhados.forEach(p=>{
        const v=p.consumidorFinal?"Consumidor Final (varejo)":p.vendedor;
        if(!porVend[v]) porVend[v]={qtd:0,valor:0}; porVend[v].qtd++; porVend[v].valor+=p.total;
        if(p.situacaoId!==SIT.ATENDIDO && p.situacaoId!==SIT.CANCELADO) emAberto.push({numero:p.numero, cliente:p.cliente, total:p.total, situacao:p.situacao});
      });
      const atacado=detalhados.filter(p=>p.origem==="atacado");
      const varejo=detalhados.filter(p=>p.origem==="varejo"||p.origem==="varejo_pendente");
      const possiveisErros=detalhados.filter(p=>p.origem==="possivel_erro").sort((a,b)=>b.total-a.total);
      // formas de pagamento por origem, vindas do BLING (cobre o varejo/PDV, que não
      // passa pelos nossos caixas — era por isso que a Central mostrava Varejo zerado)
      const somaFormas=(lista)=>{
        const m={};
        lista.forEach(p=>(p.parcelas||[]).forEach(pc=>{ const k=pc.forma||"—"; m[k]=(m[k]||0)+pc.valor; }));
        return Object.entries(m).map(([nome,valor])=>({nome,valor:+valor.toFixed(2)})).sort((a,b)=>b.valor-a.valor);
      };
      const soAtendidos=(l)=>l.filter(p=>p.situacaoId===SIT.ATENDIDO); // só o que foi efetivamente pago
      const atacadoAt=soAtendidos(atacado), varejoAt=soAtendidos(varejo);
      // produtos que mais saíram, por origem (itens vêm do próprio Bling)
      const topProdutos=(lista)=>{
        const m={};
        lista.forEach(p=>(p.itens||[]).forEach(i=>{
          const k=i.nome||"produto";
          if(!m[k]) m[k]={nome:k,qtd:0,valor:0};
          m[k].qtd+=i.quantidade; m[k].valor+=i.quantidade*i.valor;
        }));
        return Object.values(m).sort((a,b)=>b.qtd-a.qtd).slice(0,20).map(x=>({...x,valor:+x.valor.toFixed(2)}));
      };
      const agrupa=(lista,fn)=>Object.entries(lista.reduce((acc,p)=>{ const k=fn(p)||"—"; if(!acc[k]) acc[k]={qtd:0,valor:0}; acc[k].qtd++; acc[k].valor+=p.total; return acc; },{}))
        .map(([nome,v])=>({nome,qtd:v.qtd,valor:+v.valor.toFixed(2)})).sort((a,b)=>b.valor-a.valor);
      const naoAtendidos=detalhados.filter(p=>p.situacaoId!==SIT.ATENDIDO&&p.situacaoId!==SIT.CANCELADO);
      out.pedidos={ total:detalhados.length, valor:+detalhados.reduce((a,p)=>a+p.total,0).toFixed(2),
        porVendedor:Object.entries(porVend).map(([nome,v])=>({nome,qtd:v.qtd,valor:+v.valor.toFixed(2)})).sort((a,b)=>b.valor-a.valor),
        maiores:detalhados.map(p=>({numero:p.numero,cliente:p.cliente,total:p.total})).sort((a,b)=>b.total-a.total).slice(0,10),
        emAberto:emAberto.sort((a,b)=>b.total-a.total).slice(0,30), qtdEmAberto:emAberto.length,
        lista:detalhados,
        origem:{ atacado:{qtd:atacado.length, valor:+atacado.reduce((s,p)=>s+p.total,0).toFixed(2)},
          varejo:{qtd:varejo.length, valor:+varejo.reduce((s,p)=>s+p.total,0).toFixed(2)},
          possiveisErros, qtdPossiveisErros:possiveisErros.length },
        // fechamento por origem, direto do Bling (só pedidos Atendidos = pagos)
        fechamentoBling:{
          atacado:{ qtd:atacadoAt.length, valor:+atacadoAt.reduce((s,p)=>s+p.total,0).toFixed(2), porForma:somaFormas(atacadoAt) },
          varejo:{ qtd:varejoAt.length, valor:+varejoAt.reduce((s,p)=>s+p.total,0).toFixed(2), porForma:somaFormas(varejoAt) },
          porVendedorVarejo:agrupa(varejoAt,p=>p.vendedor),
          porVendedorAtacado:agrupa(atacadoAt,p=>p.vendedor),
          produtosAtacado:topProdutos(atacadoAt),
          produtosVarejo:topProdutos(varejoAt),
          // mesmas informações do Fechamento de Caixa:
          porStatus:Object.entries(detalhados.reduce((acc,p)=>{ const k=p.situacao||"—"; if(!acc[k]) acc[k]={qtd:0,valor:0}; acc[k].qtd++; acc[k].valor+=p.total; return acc; },{}))
            .map(([nome,v])=>({nome,qtd:v.qtd,valor:+v.valor.toFixed(2)})).sort((a,b)=>b.valor-a.valor),
          clientes:agrupa(soAtendidos(detalhados),p=>p.cliente).slice(0,25),
          naoPagos:{ qtd:naoAtendidos.length, valor:+naoAtendidos.reduce((s,p)=>s+p.total,0).toFixed(2),
            pedidos:naoAtendidos.sort((a,b)=>b.total-a.total).slice(0,25).map(p=>({numero:p.numero,cliente:p.cliente,total:p.total,situacao:p.situacao,vendedor:p.vendedor})) },
          totalPago:+soAtendidos(detalhados).reduce((s,p)=>s+p.total,0).toFixed(2),
          qtdPago:soAtendidos(detalhados).length,
        },
        duplicidades:{ noCaixa:dupNoCaixa, qtdNoCaixa:dupNoCaixa.length,
          soNoCaixa, qtdSoNoCaixa:soNoCaixa.length,
          repetidosNaListagemBling:duplicadosBling, qtdRepetidosBling:duplicadosBling.length } };
    }catch(e){ out.pedidos={erro:e.message}; }
    publicar(); // publica o que já ficou pronto (não espera a varredura toda)
    // notas EMITIDAS no dia. IMPORTANTE: NFC-e fica em /nfce (o /nfe?tipo=1 devolve 0 —
    // era por isso que a Central não mostrava as notas do varejo/PDV). Busca as duas.
    try{
      const pegaValor=(n)=>Number(n.valorNota ?? n.valor ?? n.totalNota ?? n.total ?? 0);
      const buscarTudo=async(base)=>{
        let arr=[], pag=1;
        for(let i=0;i<8;i++){
          const r=await blingLento(`${base}&pagina=${pag}&limite=100`);
          const d=r?.data||[]; arr=arr.concat(d);
          if(d.length<100) break; pag++; await sleep(150);
        }
        return arr;
      };
      const janela=`dataEmissaoInicial=${dia} 00:00:00&dataEmissaoFinal=${dia} 23:59:59`;
      let nfce=[], nfe=[];
      try{ nfce=await buscarTudo(`/nfce?${janela}`); }catch(e){}
      try{ nfe=await buscarTudo(`/nfe?tipo=1&${janela}`); }catch(e){}
      // situação 5 = Autorizada (as canceladas/denegadas não contam no faturamento).
      // As demais indicam problema (rejeitada, denegada, pendente de transmissão...).
      const autorizadas=(l)=>l.filter(n=>Number(n.situacao)===5);
      const nomeSitNota=(c)=>({1:"Pendente",2:"Cancelada",3:"Aguardando recibo",4:"Rejeitada",5:"Autorizada",
        6:"Emitida DANFE",7:"Registrada",8:"Aguardando protocolo",9:"Denegada",10:"Consultando situação",11:"Bloqueada"})[Number(c)]||("Situação "+c);
      const nfceOk=autorizadas(nfce), nfeOk=autorizadas(nfe);
      // a listagem do Bling não traz o valor da nota — busca o detalhe (em blocos,
      // pra não travar) só das autorizadas do dia
      const somaComDetalhe=async(lista)=>{
        let soma=0, semValor=0;
        for(const n of lista.slice(0,60)){ // teto pra não alongar demais a varredura
          let v=pegaValor(n);
          if(!v){
            try{ const d=await blingLento(`/nfce/${n.id}`).then(r=>r?.data); v=pegaValor(d||{}); }catch(e){}
            await sleep(60);
          }
          if(v) soma+=v; else semValor++;
        }
        return {soma:+soma.toFixed(2), semValor};
      };
      const sNfce=await somaComDetalhe(nfceOk);
      const sNfe=nfeOk.length?{soma:+nfeOk.reduce((a,n)=>a+pegaValor(n),0).toFixed(2),semValor:0}:{soma:0,semValor:0};
      out.notasEmitidas={
        qtd:nfceOk.length+nfeOk.length, valor:+(sNfce.soma+sNfe.soma).toFixed(2),
        nfce:{qtd:nfceOk.length, valor:sNfce.soma, canceladas:nfce.length-nfceOk.length},
        nfe:{qtd:nfeOk.length, valor:sNfe.soma},
        semValor:sNfce.semValor,
        // quebra por situação e as que NÃO ficaram autorizadas (precisam de atenção)
        porSituacao:Object.entries([...nfce,...nfe].reduce((acc,n)=>{ const k=nomeSitNota(n.situacao); acc[k]=(acc[k]||0)+1; return acc; },{}))
          .map(([nome,qtd])=>({nome,qtd})).sort((a,b)=>b.qtd-a.qtd),
        comProblema:[...nfce,...nfe].filter(n=>Number(n.situacao)!==5)
          .map(n=>({numero:n.numero, serie:n.serie, situacao:nomeSitNota(n.situacao), situacaoId:Number(n.situacao),
            cliente:n.contato?.nome||"—", dataEmissao:n.dataEmissao, id:n.id}))
          .sort((a,b)=>String(b.dataEmissao||"").localeCompare(String(a.dataEmissao||""))).slice(0,20),
        qtdComProblema:[...nfce,...nfe].filter(n=>Number(n.situacao)!==5).length,
        porCliente:Object.entries([...nfceOk,...nfeOk].reduce((acc,n)=>{ const k=n.contato?.nome||"—"; acc[k]=(acc[k]||0)+pegaValor(n); return acc; },{}))
          .map(([nome,valor])=>({nome,valor:+valor.toFixed(2)})).filter(x=>x.valor>0).sort((a,b)=>b.valor-a.valor).slice(0,15) };
    }catch(e){ out.notasEmitidas={erro:e.message}; }
    publicar(); // publica o que já ficou pronto (não espera a varredura toda)
    // notas de ENTRADA no dia — qtd, valor, fornecedores, e produtos entrados (abre até 20 notas)
    try{
      const r=await blingLento(`/nfe?tipo=0&dataEmissaoInicial=${dia} 00:00:00&dataEmissaoFinal=${dia} 23:59:59&limite=100`);
      const arr=r?.data||[]; const prod={};
      for(const n of arr.slice(0,20)){ try{ const d=await blingLento(`/nfe/${n.id}`).then(x=>x?.data); (d?.itens||[]).forEach(it=>{ const k=it.descricao||it.produto?.nome||"produto"; if(!prod[k]) prod[k]={nome:k,qtd:0,valor:0}; prod[k].qtd+=Number(it.quantidade)||0; prod[k].valor+=(Number(it.quantidade)||0)*(Number(it.valor)||0); }); }catch(e){} await sleep(100); }
      out.entradas={ qtd:arr.length, fornecedores:[...new Set(arr.map(n=>n.contato?.nome).filter(Boolean))].slice(0,12),
        produtos:Object.values(prod).sort((a,b)=>b.qtd-a.qtd).slice(0,15).map(p=>({...p,valor:+p.valor.toFixed(2)})) };
    }catch(e){ out.entradas={erro:e.message}; }
    publicar(); // publica o que já ficou pronto (não espera a varredura toda)
  }catch(e){ out.erro=e.message; }
  out.calculando=false;
  _centralBling=out;
}

// ===== ENTREGAS AGENDADAS (acompanhamento por dia) =====
// Junta: o agendamento (dia/turno/observação), o pedido (cliente, valor, frete) e o
// que o CAIXA ATACADO já registrou (se foi pago e como). Tudo local = instantâneo.
// confere o SALDO ATUAL dos produtos que foram retirados de pedidos — pra confirmar
// se saíram mesmo por falta de estoque (ou se o estoque já foi reposto)
app.get("/api/central/retirados-estoque",async(req,res)=>{
  try{
    const nomes=String(req.query.nomes||"").split("|").map(x=>x.trim()).filter(Boolean).slice(0,25);
    if(!nomes.length) return res.json({data:[]});
    const indice=lerJSON(GTIN_INDEX_FILE,{});
    const porNome={};
    Object.values(indice).forEach(p=>{ if(p.nome) porNome[String(p.nome).toLowerCase().trim()]=p.produtoId; });
    const alvos=nomes.map(n=>({nome:n, produtoId:porNome[n.toLowerCase().trim()]||null}));
    const ids=alvos.map(a=>a.produtoId).filter(Boolean);
    const saldos={};
    for(let i=0;i<ids.length;i+=40){
      const bloco=ids.slice(i,i+40);
      try{
        const r=await bling(`/estoques/saldos?${bloco.map(id=>`idsProdutos[]=${id}`).join("&")}`);
        (r?.data||[]).forEach(x=>{ saldos[x.produto?.id]={fisico:Number(x.saldoFisicoTotal??0), disponivel:Number(x.saldoVirtualTotal??0)}; });
      }catch(e){}
      await sleep(180);
    }
    res.json({ data: alvos.map(a=>({ ...a, saldo:a.produtoId?(saldos[a.produtoId]||null):null,
      semEstoque: a.produtoId&&saldos[a.produtoId] ? saldos[a.produtoId].disponivel<=0 : null })) });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.get("/api/central/entregas",(req,res)=>{
  try{
    const turnos=lerJSON(`${DATA_DIR}/turnos_entrega.json`,{});
    const props=lerPropostas();
    const porPedido={}; // pedidoBlingId -> proposta (tem cliente, total, entrega)
    Object.values(props||{}).forEach(p=>{ if(p.pedidoBlingId) porPedido[String(p.pedidoBlingId)]=p; });
    // o que o caixa atacado já cobrou de cada pedido
    const dCx=lerCaixaSessoes(); const noCaixa={};
    (dCx.sessoes||[]).forEach(s=>(s.movimentos||[]).forEach(m=>{
      if(m.tipo!=="venda"||m.cancelado||!m.pedidoId) return;
      noCaixa[String(m.pedidoId)]={ total:Number(m.total)||0, em:m.em, operador:m.operador||s.operador||"",
        formas:(m.pagamentos||[]).map(x=>`${x.formaNome}: ${Number(x.valor).toFixed(2)}`).join(" · ") };
    }));
    const pags=lerPag();
    const dias={};
    Object.entries(turnos).forEach(([pid,ag])=>{
      if(!ag||!ag.data) return;
      const prop=porPedido[pid]||null;
      const cx=noCaixa[pid]||null;
      const pg=pags[pid]||null;
      const sit=_sitOnline[pid]||null;
      const total=Number(prop?.total ?? cx?.total ?? 0);
      const frete=Number(prop?.entrega?.taxa||0);
      const item={
        pedidoId:pid, numero:ag.numero||prop?.pedidoBlingNumero||pid,
        cliente:prop?.cliente?.nome||"—",
        endereco:prop?.entrega?.endereco||"",
        turno:ag.turno||"qualquer", obsEntrega:ag.obsEntrega||"", agendadoPor:ag.por||"",
        total, frete,
        pago: !!cx || pg?.statusPagamento==="pago",
        pagoNoCaixa: cx?{valor:cx.total,quando:cx.em,operador:cx.operador,formas:cx.formas}:null,
        situacao: sit?sit.situacao:null,
        cancelado: sit?sit.situacaoId===SIT.CANCELADO:false,
      };
      if(!dias[ag.data]) dias[ag.data]={data:ag.data, pedidos:[], total:0, frete:0, qtdPagos:0, totalPago:0, manha:0, tarde:0, qualquer:0};
      const d=dias[ag.data];
      if(item.cancelado) return; // cancelado não entra no acompanhamento
      d.pedidos.push(item);
      d.total+=item.total; d.frete+=item.frete;
      if(item.pago){ d.qtdPagos++; d.totalPago+=item.total; }
      d[item.turno==="manha"?"manha":(item.turno==="tarde"?"tarde":"qualquer")]++;
    });
    const lista=Object.values(dias).map(d=>({
      ...d, total:+d.total.toFixed(2), frete:+d.frete.toFixed(2), totalPago:+d.totalPago.toFixed(2),
      qtd:d.pedidos.length, aReceber:+(d.total-d.totalPago).toFixed(2),
      pedidos:d.pedidos.sort((a,b)=>{ const o=x=>x.turno==="manha"?0:(x.turno==="tarde"?1:2); return o(a)-o(b)||b.total-a.total; }),
    })).sort((a,b)=>a.data.localeCompare(b.data));
    // atualiza a situação desses pedidos em 2º plano (pra próxima consulta já ter)
    const idsSemSit=Object.keys(turnos).filter(id=>!_sitOnline[id]).slice(0,40);
    if(idsSemSit.length) _atualizarSituacoesOnline(idsSemSit);
    const hoje=_hojeISO();
    res.json({ hoje, dias:lista,
      resumo:{ diasComEntrega:lista.length,
        totalPedidos:lista.reduce((s,d)=>s+d.qtd,0),
        totalValor:+lista.reduce((s,d)=>s+d.total,0).toFixed(2),
        totalFrete:+lista.reduce((s,d)=>s+d.frete,0).toFixed(2),
        aReceber:+lista.reduce((s,d)=>s+d.aReceber,0).toFixed(2) } });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.get("/api/central/resumo",(req,res)=>{
  try{
    const dia=_hojeISO(req.query.data);
    const ini=_inicioDia(dia), fim=_fimDia(dia);
    const noDia=(ms)=>ms>=ini&&ms<fim;
    const dCx=lerCaixaSessoes();
    const rc=(s)=>{ const r=resumoSessaoCaixa(s); return { id:s.id, operador:s.operador, tipoCaixa:s.tipoCaixa||"frente", abertaEm:s.abertaEm, fechadaEm:s.fechadaEm||null, resumo:r, totalPix:(r.porForma||[]).filter(f=>/pix/i.test(f.nome)).reduce((a,f)=>a+f.valor,0), fechamento:s.fechamento||null }; };
    const abertos=(dCx.sessoes||[]).filter(s=>!s.fechadaEm).map(rc);
    const fechadosDia=(dCx.sessoes||[]).filter(s=>s.fechadaEm && (noDia(s.fechadaEm)||noDia(s.abertaEm))).map(rc);

    // ===== varredura das VENDAS do dia (todos os caixas, abertos e fechados) =====
    const porForma={}, porOperador={}, clientes={}, produtos={}, porModo={};
    const porTipo={ atacado:{total:0,qtd:0,porForma:{}}, frente:{total:0,qtd:0,porForma:{}} };
    let totalDia=0, qtdDia=0, sangrias=0, supr=0, canceladas=0, consumidorFinal={qtd:0,valor:0};
    const vendasDia=[];
    (dCx.sessoes||[]).forEach(s=>{
      (s.movimentos||[]).forEach(m=>{
        if(!noDia(m.em)) return;
        if(m.tipo==="sangria"){ sangrias+=Number(m.valor)||0; return; }
        if(m.tipo==="suprimento"){ supr+=Number(m.valor)||0; return; }
        if(m.tipo!=="venda") return;
        if(m.cancelado){ canceladas++; return; }
        const tot=Number(m.total)||0; totalDia+=tot; qtdDia++;
        const tipo=(s.tipoCaixa||"frente")==="atacado"?"atacado":"frente";
        vendasDia.push({ numero:m.numero||m.pedidoId, cliente:m.clienteNome||"Consumidor Final", total:tot, operador:m.operador||s.operador||"—", em:m.em, tipoCaixa:tipo, formas:(m.pagamentos||[]).map(p=>p.formaNome).join(", ") });
        porTipo[tipo].total+=tot; porTipo[tipo].qtd++;
        (m.pagamentos||[]).forEach(p=>{ const k=p.formaNome||"—"; porForma[k]=(porForma[k]||0)+(Number(p.valor)||0); porTipo[tipo].porForma[k]=(porTipo[tipo].porForma[k]||0)+(Number(p.valor)||0); });
        const op=m.operador||s.operador||"—"; if(!porOperador[op]) porOperador[op]={qtd:0,valor:0}; porOperador[op].qtd++; porOperador[op].valor+=tot;
        const cli=(m.clienteNome||"").trim(); if(!cli||/consumidor/i.test(cli)){ consumidorFinal.qtd++; consumidorFinal.valor+=tot; } else { if(!clientes[cli]) clientes[cli]={qtd:0,valor:0}; clientes[cli].qtd++; clientes[cli].valor+=tot; }
        (m.itens||[]).forEach(i=>{ const k=i.nome||("produto "+i.produtoId); if(!produtos[k]) produtos[k]={nome:k,qtd:0,valor:0}; produtos[k].qtd+=Number(i.quantidade)||0; produtos[k].valor+=(Number(i.quantidade)||0)*(Number(i.valor)||0);
          const modo=i.modoPreco||"não informado"; if(!porModo[modo]) porModo[modo]={itens:0,unidades:0,valor:0}; porModo[modo].itens++; porModo[modo].unidades+=Number(i.quantidade)||0; porModo[modo].valor+=(Number(i.quantidade)||0)*(Number(i.valor)||0); });
      });
    });
    const arr=(o,f)=>Object.entries(o).map(([k,v])=>f(k,v));
    const dinheiroAtacado=+(porTipo.atacado.porForma["Dinheiro"]||0).toFixed(2);
    const dinheiroVarejo=+(porTipo.frente.porForma["Dinheiro"]||0).toFixed(2);
    const fechamentoDia={ totalVendas:+totalDia.toFixed(2), qtdVendas:qtdDia, canceladas, sangrias:+sangrias.toFixed(2), suprimentos:+supr.toFixed(2),
      porForma:arr(porForma,(nome,valor)=>({nome,valor:+valor.toFixed(2)})).sort((a,b)=>b.valor-a.valor),
      totalPix:+Object.entries(porForma).filter(([n])=>/pix/i.test(n)).reduce((a,[,v])=>a+v,0).toFixed(2),
      porOperador:arr(porOperador,(nome,v)=>({nome,qtd:v.qtd,valor:+v.valor.toFixed(2)})).sort((a,b)=>b.valor-a.valor),
      consumidorFinal:{qtd:consumidorFinal.qtd, valor:+consumidorFinal.valor.toFixed(2)},
      clientes:arr(clientes,(nome,v)=>({nome,qtd:v.qtd,valor:+v.valor.toFixed(2)})).sort((a,b)=>b.valor-a.valor).slice(0,25),
      produtosMaisVendidos:Object.values(produtos).sort((a,b)=>b.qtd-a.qtd).slice(0,20).map(p=>({...p,valor:+p.valor.toFixed(2)})),
      maioresVendas:vendasDia.sort((a,b)=>b.total-a.total).slice(0,10),
      porModoPreco:arr(porModo,(modo,v)=>({modo,itens:v.itens,unidades:v.unidades,valor:+v.valor.toFixed(2)})).sort((a,b)=>b.valor-a.valor),
      porTipoCaixa:{
        atacado:{ total:+porTipo.atacado.total.toFixed(2), qtd:porTipo.atacado.qtd, porForma:arr(porTipo.atacado.porForma,(nome,valor)=>({nome,valor:+valor.toFixed(2)})).sort((a,b)=>b.valor-a.valor) },
        varejo:{ total:+porTipo.frente.total.toFixed(2), qtd:porTipo.frente.qtd, porForma:arr(porTipo.frente.porForma,(nome,valor)=>({nome,valor:+valor.toFixed(2)})).sort((a,b)=>b.valor-a.valor) },
      },
      dinheiroTotal:+(dinheiroAtacado+dinheiroVarejo).toFixed(2), dinheiroAtacado, dinheiroVarejo,
    };

    // ===== AUTORIZAÇÕES e ITENS RETIRADOS (logs do dia) =====
    const log=lerLog(); const autorizacoes=[]; const retirados={};
    const evAut=new Set(["fechado_valor_menor","pagamento_editado_caixa","pedido_reaberto","venda_cancelada","venda_cancelada_gestao","itens_retirados","itens_acrescentados","itens_alterados_gestao","itens_alterados_caixa","pedido_incluido_no_caixa"]);
    Object.entries(log||{}).forEach(([pid,evs])=>{ (Array.isArray(evs)?evs:[]).forEach(ev=>{
      const em=ev.em||ev.quando||0; if(!noDia(em)) return;
      if(evAut.has(ev.evento)){ const d=ev.detalhes||{}; const det=d.faltou!=null?("faltou "+d.faltou):(Array.isArray(d.retirados)&&d.retirados.length?("retirou "+d.retirados.join(", ")+(d.acrescentados?.length?" · acrescentou "+d.acrescentados.join(", "):"")+(d.alterados?.length?" · alterou "+d.alterados.join(", "):"")):(Array.isArray(d.itens)?d.itens.join(", "):(d.de?(d.de+" → "+d.para):""))); autorizacoes.push({ pedidoId:pid, evento:ev.evento, em, por:ev.funcionarioNome||ev.funcionario||"—", autorizadoPor:d.autorizadoPor||"", detalhe:det }); }
      if(ev.evento==="itens_retirados"){ (ev.detalhes?.itens||[]).forEach(n=>{ retirados[n]=(retirados[n]||0)+1; }); }
    }); });
    // itens retirados também pelas alterações de itens gravadas no movimento (de→para)
    // RETIRADOS: acontece quando o pedido é REABERTO no caixa atacado (já pago) e o
    // produto sai por não ter estoque. Guarda também de qual pedido, quem tirou e quando.
    const detRetirados={}; // nome -> {vezes, unidades, ocorrencias:[{pedido,por,em}]}
    const addRetirado=(txt,ctx)=>{
      const t=String(txt||"").trim(); if(!t) return;
      const m2=t.match(/^(\d+(?:[.,]\d+)?)x\s*(.+)$/);
      const qtd=m2?Number(String(m2[1]).replace(",",".")):0;
      const nome=(m2?m2[2]:t).trim();
      if(!nome) return;
      retirados[nome]=(retirados[nome]||0)+1;
      if(!detRetirados[nome]) detRetirados[nome]={nome,vezes:0,unidades:0,ocorrencias:[]};
      const d=detRetirados[nome];
      d.vezes++; d.unidades+=qtd;
      if(d.ocorrencias.length<8) d.ocorrencias.push(ctx);
    };
    (dCx.sessoes||[]).forEach(s=>(s.movimentos||[]).forEach(m=>{ (m.alteracoes||[]).forEach(a=>{ if(a.tipo==="itens"&&noDia(a.em)){
      const ctx={pedido:m.numero||m.pedidoId, pedidoId:m.pedidoId, por:a.por||m.operador||s.operador||"", autorizadoPor:a.autorizadoPor||"", em:a.em};
      if(Array.isArray(a.retirados)){ a.retirados.forEach(x=>addRetirado(x,ctx)); return; } // formato novo (estruturado)
      const antes=String(a.de||"").split(", ").filter(Boolean); const depois=new Set(String(a.para||"").split(", ").filter(Boolean));
      antes.forEach(x=>{ if(!depois.has(x)) addRetirado(x,ctx); }); } }); }));
    autorizacoes.sort((a,b)=>b.em-a.em);

    // ===== pagamentos NÃO pagos (pedidos do dia com status diferente de pago) =====
    const pags=lerPag(); const naoPagos=[];
    Object.entries(pags||{}).forEach(([pid,p])=>{ const em=p.em||p.atualizadoEm||0; if(em&&noDia(em)&&p.statusPagamento&&p.statusPagamento!=="pago"&&p.statusPagamento!=="cancelado") naoPagos.push({pedidoId:pid, status:p.statusPagamento, valorPedido:p.valorPedido||null, valorPago:p.valorPago||0}); });

    // NFC-e, avisos, propostas
    const emit=lerNfceEmitidas(); const nfceHoje=Object.values(emit).filter(x=>x&&noDia(x.em)).length;
    let pendNfce=0; (dCx.sessoes||[]).forEach(s=>{ if((s.tipoCaixa||"frente")!=="atacado") return; (s.movimentos||[]).forEach(m=>{ if(m.tipo==="venda"&&!m.cancelado&&noDia(m.em)&&!emit[String(m.pedidoId)]) pendNfce++; }); });
    const av=lerAvisos(); const avPend=(av.lista||[]).filter(a=>!a.resolvido);
    const props=lerPropostas(); const pl=Object.values(props||{});
    const propostas={ abertas:pl.filter(p=>!p.pedidoBlingId&&p.status!=="cancelada").length, pedidosGeradosDia:pl.filter(p=>p.pedidoBlingId&&noDia(p.criadoEm||0)).length,
      porOrigemDia:pl.filter(p=>p.pedidoBlingId&&noDia(p.criadoEm||0)).reduce((acc,p)=>{ const o=p.origem||"atacado"; acc[o]=(acc[o]||0)+1; return acc; },{}) };
    // entradas do mês (cache) — produtos que mais entraram
    const ec=lerEntradasCache(); const mesKey=dia.slice(0,7); const em=ec[mesKey];
    const maisEntraram=em&&em.status==="pronto" ? Object.values({...(em.semPapel||{}),...(em.comNF||{})}).sort((a,b)=>b.qtd-a.qtd).slice(0,15) : null;

    if(_centralBling.dia!==dia || Date.now()-_centralBling.em>5*60*1000) _atualizarCentralBling(dia);

    // ORIGEM DOS PEDIDOS (Atacado x Varejo): já vem PRONTA do cache — a correlação com
    // o nosso caixa é feita uma única vez, dentro da mesma varredura em
    // _atualizarCentralBling, e não recalculada aqui a cada carregamento da página.
    const origemPedidos=(_centralBling.pedidos&&!_centralBling.pedidos.erro)?_centralBling.pedidos.origem:null;

    res.json({
      dia, geradoEm:Date.now(),
      caixasAbertos:abertos, totalCaixasAbertos:+abertos.reduce((s,c)=>s+(c.resumo.totalVendas||0),0).toFixed(2),
      caixasFechadosDia:fechadosDia,
      fechamentoDia, autorizacoes:autorizacoes.slice(0,40), qtdAutorizacoes:autorizacoes.length,
      produtosRetirados:Object.values(detRetirados).map(d=>({...d, unidades:+d.unidades.toFixed(3)})).sort((a,b)=>b.vezes-a.vezes),
      naoPagos:naoPagos.slice(0,30), qtdNaoPagos:naoPagos.length,
      nfce:{ emitidasDia:nfceHoje, pendentesDia:pendNfce },
      avisos:{ pendentes:avPend.length, ultimos:avPend.slice(0,5).map(a=>({id:a.id,titulo:a.titulo,em:a.em})) },
      propostas, entradasMesTop:maisEntraram, entradasMesStatus:em?em.status:null,
      origemPedidos,
      bling:{ ..._centralBling, calculando:_centralBling.calculando&&_centralBling.dia===dia },
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// ===================== PAINEL DE ESTOQUE =====================
// Lista depósitos (pra escolher antes de mexer em qualquer coisa)
// ===================== PEDIDOS ONLINE (totem / site) =====================
// Lê do REGISTRO LOCAL que o /api/finalizar já grava a cada pedido do totem/site
// (tem cliente, telefone, itens, total e entrega/retirada). É instantâneo — antes
// eu varria o Bling abrindo o detalhe de TODOS os pedidos do período, o que levava
// minutos e a tela ficava só carregando. A situação atual de cada pedido é buscada
// no Bling em SEGUNDO PLANO e vai sendo preenchida (cache de 60s).
let _sitOnline={};        // pedidoBlingId -> {situacaoId, situacao, em}
let _sitOnlineRodando=false;
async function _atualizarSituacoesOnline(ids){
  if(_sitOnlineRodando) return;
  _sitOnlineRodando=true;
  try{
    for(const id of ids){
      const c=_sitOnline[String(id)];
      if(c && (Date.now()-c.em)<60*1000) continue;
      try{
        const d=await bling(`/pedidos/vendas/${id}`).then(r=>r?.data);
        const sit=Number(d?.situacao?.id||0);
        _sitOnline[String(id)]={situacaoId:sit, situacao:nomeSituacao(sit), em:Date.now()};
      }catch(e){ _sitOnline[String(id)]={situacaoId:0, situacao:"—", em:Date.now()}; }
      await sleep(120);
    }
  }catch(e){}
  _sitOnlineRodando=false;
}
function _turnosEntrega(){ try{ return lerJSON(`${DATA_DIR}/turnos_entrega.json`,{}); }catch(e){ return {}; } }
app.get("/api/pedidos-online",(req,res)=>{
  try{
    const dias=Math.min(Number(req.query.dias||3),30);
    const desde=Date.now()-dias*86400000;
    const props=lerPropostas();
    const lista=Object.values(props||{})
      .filter(p=>p && p.pedidoBlingId && (p.criadoEm||0)>=desde
        && (req.query.origem==="online" ? (p.origem==="totem"||p.origem==="site") : true))
      .map(p=>{
        const sit=_sitOnline[String(p.pedidoBlingId)]||null;
        const ag=_turnosEntrega()[String(p.pedidoBlingId)]||null;
        return { id:p.pedidoBlingId, numero:p.pedidoBlingNumero||p.pedidoBlingId,
          agendamento: ag?{data:ag.data,turno:ag.turno,obsEntrega:ag.obsEntrega||"",por:ag.por}:null,
          criadoEm:p.criadoEm||0, origem:p.origem||"atacado",
          vendedor:p.vendedorNome||p.funcionarioNome||"", // vendedor do pedido (ou quem digitou)
          cliente:p.cliente?.nome||"—", telefone:p.cliente?.telefone||"",
          total:Number(p.total)||0, frete:Number(p.entrega?.taxa)||0,
          tipo:(p.entrega?.tipo==="entrega")?"entrega":"retirada",
          endereco:p.entrega?.endereco||"",
          itens:(p.itens||[]).map(i=>({nome:i.nome||"",quantidade:Number(i.quantidade)||0,valor:Number(i.valor)||0})),
          situacaoId: sit?sit.situacaoId:null, situacao: sit?sit.situacao:"carregando…",
          cancelado: sit?sit.situacaoId===SIT.CANCELADO:false };
      })
      .sort((a,b)=>(b.criadoEm||0)-(a.criadoEm||0));
    // dispara a atualização das situações em 2º plano (não segura a resposta)
    _atualizarSituacoesOnline(lista.slice(0,120).map(p=>p.id));
    res.json({data:lista, situacoesCarregando:_sitOnlineRodando});
  }catch(e){ res.status(500).json({erro:e.message}); }
});
// contagem de NOVOS pedidos online por usuário (cada um tem seu "já vi até aqui")
const VISTOS_ONLINE_FILE=`${DATA_DIR}/pedidos_online_vistos.json`;
function _listaOnlineSimples(dias){
  const desde=Date.now()-(dias||3)*86400000;
  const props=lerPropostas();
  return Object.values(props||{})
    .filter(p=>p && (p.origem==="totem"||p.origem==="site") && (p.criadoEm||0)>=desde) // sino: só totem/site
    .sort((a,b)=>(b.criadoEm||0)-(a.criadoEm||0));
}
app.get("/api/pedidos-online/novos/:funcionarioId",(req,res)=>{
  try{
    const vistos=lerJSON(VISTOS_ONLINE_FILE,{});
    const marca=vistos[String(req.params.funcionarioId)]||{ultimoEm:0};
    const lista=_listaOnlineSimples(3);
    const novos=lista.filter(p=>(p.criadoEm||0)>Number(marca.ultimoEm||0));
    // busca a situação atual dos novos em 2º plano, pra o sino poder mostrá-la
    if(novos.length) _atualizarSituacoesOnline(novos.slice(0,10).map(p=>p.pedidoBlingId));
    res.json({ novos:novos.length, vistoAte:Number(marca.ultimoEm||0),
      ultimoEm: lista.length?Math.max(...lista.map(p=>p.criadoEm||0)):0,
      pedidos:novos.slice(0,10).map(p=>{
        const sit=_sitOnline[String(p.pedidoBlingId)]||null;
        return {numero:p.pedidoBlingNumero||p.pedidoBlingId, cliente:p.cliente?.nome||"", total:Number(p.total)||0,
          tipo:(p.entrega?.tipo==="entrega")?"entrega":"retirada", criadoEm:p.criadoEm||0,
          situacao: sit?sit.situacao:"—", situacaoId: sit?sit.situacaoId:null,
          origem:p.origem||"", vendedor:p.vendedorNome||p.funcionarioNome||""};
      }) });
  }catch(e){ res.json({novos:0}); }
});
app.post("/api/pedidos-online/marcar-visto/:funcionarioId",(req,res)=>{
  try{
    const vistos=lerJSON(VISTOS_ONLINE_FILE,{});
    const lista=_listaOnlineSimples(3);
    const maior=lista.length?Math.max(...lista.map(p=>p.criadoEm||0)):Date.now();
    vistos[String(req.params.funcionarioId)]={ultimoEm:maior,em:Date.now()};
    salvarJSON(VISTOS_ONLINE_FILE,vistos);
    res.json({ok:true,ultimoEm:maior});
  }catch(e){ res.status(500).json({erro:e.message}); }
});
// cancela um pedido online (totem/site) direto pelo id do Bling
app.post("/api/pedidos-online/:blingId/cancelar",async(req,res)=>{
  try{
    const id=req.params.blingId;
    const d=await bling(`/pedidos/vendas/${id}`).then(r=>r?.data);
    if(!d) return res.status(404).json({erro:"pedido não encontrado"});
    const sit=Number(d.situacao?.id||0);
    if(sit===SIT.CANCELADO) return res.status(400).json({erro:"esse pedido já está cancelado"});
    if(sit===SIT.ATENDIDO) return res.status(400).json({erro:"pedido já ATENDIDO (foi pago/entregue) — cancele pela Gestão de Caixas"});
    await bling(`/pedidos/vendas/${id}/situacoes/${SIT.CANCELADO}`,{method:"PATCH"});
    const funcNome=(lerJSON(FUNC_FILE,{})[req.body?.funcionarioId]?.nome)||"—";
    addLog(String(id),"pedido_online_cancelado",req.body?.funcionarioId,funcNome,{motivo:req.body?.motivo||"",numero:d.numero});
    _sitOnline[String(id)]={situacaoId:SIT.CANCELADO, situacao:"Cancelado", em:Date.now()};
    res.json({ok:true,numero:d.numero});
  }catch(e){ res.status(e.status||500).json({erro:e.message}); }
});

// ===== AGENDAR ENTREGA (a partir da tela de Pedidos) =====
// Coloca o pedido no Gerenciamento de Rota no dia escolhido, com o TURNO
// (manhã/tarde). Fica em "_semCarro" — pronto pra entrar na distribuição.
const TURNOS_ENTREGA_FILE=`${DATA_DIR}/turnos_entrega.json`; // pedidoId -> {data,turno,por,em}
app.post("/api/pedidos-online/:blingId/agendar-entrega",async(req,res)=>{
  try{
    const id=Number(req.params.blingId);
    const {data,turno,obsEntrega,funcionarioId}=req.body||{};
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(data||""))) return res.status(400).json({erro:"escolha o dia da entrega"});
    const turnoOk=["manha","tarde","qualquer"].includes(turno)?turno:"qualquer"; // padrão: qualquer horário
    // confere se o pedido existe e ainda pode ser agendado
    let ped=null; try{ ped=await bling(`/pedidos/vendas/${id}`).then(r=>r?.data); }catch(e){}
    if(!ped) return res.status(404).json({erro:"pedido não encontrado no Bling"});
    if(Number(ped.situacao?.id)===SIT.CANCELADO) return res.status(400).json({erro:"pedido cancelado não pode ser agendado"});
    // tira de qualquer outro dia antes de agendar no novo (evita duplicar na rota)
    removerPedidoDeTodasRotas(id);
    const rotas=lerRotasDias();
    if(!rotas[data]) rotas[data]={};
    if(!rotas[data]["_semCarro"]) rotas[data]["_semCarro"]={pedidoIds:[]};
    if(!rotas[data]["_semCarro"].pedidoIds.includes(id)) rotas[data]["_semCarro"].pedidoIds.push(id);
    salvarRotasDias(rotas);
    const turnos=lerJSON(TURNOS_ENTREGA_FILE,{});
    const funcNome=(lerJSON(FUNC_FILE,{})[funcionarioId]?.nome)||"—";
    // obsEntrega é SÓ do nosso sistema — não vai pro Bling nem pra nota do cliente
    turnos[String(id)]={data,turno:turnoOk,obsEntrega:String(obsEntrega||"").slice(0,300),por:funcNome,em:Date.now(),numero:ped.numero};
    salvarJSON(TURNOS_ENTREGA_FILE,turnos);
    addLog(String(id),"entrega_agendada",funcionarioId,funcNome,{data,turno:turnoOk,obs:obsEntrega||"",numero:ped.numero});
    res.json({ok:true,data,turno:turnoOk,numero:ped.numero});
  }catch(e){ res.status(e.status||500).json({erro:e.message}); }
});
app.post("/api/pedidos-online/:blingId/desagendar-entrega",(req,res)=>{
  try{
    const id=Number(req.params.blingId);
    removerPedidoDeTodasRotas(id);
    const turnos=lerJSON(TURNOS_ENTREGA_FILE,{}); delete turnos[String(id)]; salvarJSON(TURNOS_ENTREGA_FILE,turnos);
    res.json({ok:true});
  }catch(e){ res.status(500).json({erro:e.message}); }
});
// onde cada pedido está agendado (dia + turno), pra tela mostrar
app.get("/api/pedidos-online/agendamentos",(req,res)=>{
  try{ res.json({data:lerJSON(TURNOS_ENTREGA_FILE,{})}); }catch(e){ res.json({data:{}}); }
});
// TROCA entrega <-> retirada e grava o frete no pedido do Bling
app.post("/api/pedidos-online/:blingId/tipo-entrega",async(req,res)=>{
  try{
    const id=req.params.blingId;
    const {tipo,endereco,frete,funcionarioId}=req.body||{};
    if(!["entrega","retirada"].includes(tipo)) return res.status(400).json({erro:"tipo deve ser entrega ou retirada"});
    const ped=await bling(`/pedidos/vendas/${id}`).then(r=>r?.data);
    if(!ped) return res.status(404).json({erro:"pedido não encontrado"});
    if(Number(ped.situacao?.id)===SIT.CANCELADO) return res.status(400).json({erro:"pedido cancelado"});
    const funcNome=(lerJSON(FUNC_FILE,{})[funcionarioId]?.nome)||"—";
    const taxa=tipo==="entrega"?+Number(frete||0).toFixed(2):0;
    const quando=new Date().toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo",day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"});
    const nota=`[${quando} — ${funcNome}] Alterado para ${tipo.toUpperCase()}${tipo==="entrega"?` — ${endereco||"(sem endereço)"} · frete ${taxa.toFixed(2)}`:""}`;
    const payload={
      data:ped.data, contato:{id:ped.contato?.id},
      itens:(ped.itens||[]).map(i=>({produto:{id:i.produto?.id},quantidade:i.quantidade,valor:i.valor})),
      observacoes:[String(ped.observacoes||"").trim(),nota].filter(Boolean).join("\n"),
      transporte:{ frete:taxa, ...(tipo==="entrega"&&endereco?{enderecoEntrega:{endereco:String(endereco).slice(0,180)}}:{}) },
    };
    if(ped.vendedor?.id) payload.vendedor={id:ped.vendedor.id};
    if(ped.loja?.id) payload.loja={id:ped.loja.id};
    if(ped.desconto&&ped.desconto.valor!=null) payload.desconto={valor:Number(ped.desconto.valor)||0,unidade:ped.desconto.unidade||"REAL"};
    // preserva as parcelas, ajustando o total quando o frete muda
    if(ped.parcelas?.length){
      const totalItens=(ped.itens||[]).reduce((s,i)=>s+Number(i.quantidade)*Number(i.valor),0);
      const novoTotal=+(totalItens+taxa-Number(payload.desconto?.valor||0)).toFixed(2);
      const somaAtual=ped.parcelas.reduce((s,p)=>s+Number(p.valor||0),0);
      payload.parcelas=ped.parcelas.map((p,ix)=>({formaPagamento:{id:p.formaPagamento?.id},dataVencimento:p.dataVencimento||ped.data,
        valor: ix===ped.parcelas.length-1
          ? +(novoTotal-ped.parcelas.slice(0,-1).reduce((s,x)=>s+ +( (somaAtual? (Number(x.valor)/somaAtual*novoTotal):0).toFixed(2) ),0)).toFixed(2)
          : +(somaAtual? (Number(p.valor)/somaAtual*novoTotal):0).toFixed(2) }));
    }
    const r=await atualizarComDestrave(id, payload, Number(ped.situacao?.id||0));
    if(!r.ok) return res.status(502).json({erro:"Não consegui salvar no Bling: "+(r.erro||"erro")});
    if(tipo==="retirada"){ removerPedidoDeTodasRotas(Number(id)); const t=lerJSON(TURNOS_ENTREGA_FILE,{}); delete t[String(id)]; salvarJSON(TURNOS_ENTREGA_FILE,t); }
    addLog(String(id),"tipo_entrega_alterado",funcionarioId,funcNome,{tipo,endereco:endereco||"",frete:taxa});
    res.json({ok:true,tipo,frete:taxa});
  }catch(e){ res.status(e.status||500).json({erro:e.message}); }
});
// PUT no pedido destravando a situação quando necessário (reusa a lógica já testada)
async function atualizarComDestrave(id, payload, sitAtual){
  const BLOQ=[SIT.EM_SEP,SIT.SEP_PEND,SIT.SEPARADO,SIT.CONF_ENTREGA,SIT.EM_ROTA,SIT.ATENDIDO];
  const precisa=BLOQ.includes(Number(sitAtual));
  try{
    if(precisa){ try{ await bling(`/pedidos/vendas/${id}/situacoes/21`,{method:"PATCH"}); await sleep(350); }catch(e){} }
    await bling(`/pedidos/vendas/${id}`,{method:"PUT",body:JSON.stringify(payload)});
    return {ok:true};
  }catch(e){ return {ok:false,erro:e.message}; }
  finally{
    if(precisa){
      await sleep(400);
      if(Number(sitAtual)===SIT.ATENDIDO||Number(sitAtual)===SIT.SEPARADO){ await _restaurarSituacaoComRetry(id,Number(sitAtual),(payload.itens||[]).map(i=>({produtoId:i.produto?.id,quantidade:i.quantidade}))); }
      else { try{ await bling(`/pedidos/vendas/${id}/situacoes/${sitAtual}`,{method:"PATCH"}); }catch(e){} }
    }
  }
}

app.get("/pedidos-online", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "pedidos-online.html")); });

app.get("/api/estoque/depositos",async(req,res)=>{
  try{
    const r=await bling(`/depositos`);
    const deps=(r?.data||[]).map(d=>({id:d.id,descricao:d.descricao||d.nome||("Depósito "+d.id),padrao:!!d.padrao,situacao:d.situacao,
      desconsiderarSaldo:!!d.desconsiderarSaldo})); // true = o Bling NÃO soma esse depósito no saldo total do produto
    res.json({data:deps});
  }catch(e){ res.status(e.status||500).json({erro:e.message,detalhe:e.body}); }
});

// Lista produtos com saldo (no depósito escolhido), já organizados como a tabela de preços.
// Usa o índice local pra nome/código (rápido) e busca os saldos no Bling em blocos.
app.get("/api/estoque/produtos",async(req,res)=>{
  try{
    const depositoId=req.query.depositoId?String(req.query.depositoId):null;
    const filtro=(req.query.q||"").toLowerCase().trim();
    const soTabela=req.query.soTabela==="1";
    // base de produtos: a tabela publicada (organizada por categoria) ou o índice completo
    const idx=_indicePrecosTabela();
    const tab=lerTabela();
    let base=[];
    // índice local: tem o nome COMPLETO do produto no Bling (com o sabor/variação),
    // que é o que interessa pra saber qual atualizar quando o item da tabela agrupa
    // vários sabores (ex: "Red Bull" -> Tradicional, Tropical, Melancia...)
    const indice=lerJSON(GTIN_INDEX_FILE,{});
    const nomeBlingPorId={}, nomeBlingPorCodigo={};
    Object.values(indice).forEach(p=>{ if(p.produtoId) nomeBlingPorId[String(p.produtoId)]=p.nome||""; if(p.codigo) nomeBlingPorCodigo[String(p.codigo)]=p.nome||""; });
    if(soTabela){
      (tab?.model||[]).forEach(c=>(c.itens||[]).forEach(it=>{
        const variacoes=(it.bling||[]).filter(b=>b.id);
        const temVarios=variacoes.length>1; // item da tabela com mais de um sabor
        variacoes.forEach(b=>{
          const nomeBling = nomeBlingPorId[String(b.id)] || b.nome || nomeBlingPorCodigo[String(b.codigo||"")] || "";
          base.push({ produtoId:b.id, codigo:String(b.codigo||""),
            nome: nomeBling || it.nome || "",            // nome do Bling (com o sabor)
            nomeTabela: it.nome||"",                      // nome agrupado da tabela
            sabor: temVarios ? (nomeBling||b.nome||"") : "", // destaca o sabor quando há mais de um
            variacoes: temVarios ? variacoes.length : 0,
            categoria:c.t||"", caixaQtd:it.caixa||1 });
        });
      }));
    } else {
      const vistos=new Set();
      Object.values(indice).forEach(p=>{
        if(!p.produtoId||vistos.has(String(p.produtoId))) return;
        vistos.add(String(p.produtoId));
        const vinc=idx.porCodigo[String(p.codigo||"")];
        base.push({produtoId:p.produtoId,codigo:String(p.codigo||""),nome:p.nome||"",nomeTabela:vinc?.itemNome||"",sabor:"",variacoes:0,categoria:vinc?.categoria||"",caixaQtd:vinc?.caixaQtd||1});
      });
    }
    if(filtro){
      base=base.filter(p=>(p.nome||"").toLowerCase().includes(filtro)||(p.nomeTabela||"").toLowerCase().includes(filtro)||p.codigo.toLowerCase()===filtro);
      // produto recém-cadastrado ainda não está no índice local (ele só se refaz a cada
      // 6h) — então, ao buscar, consulta TAMBÉM o Bling e acrescenta o que faltar
      try{
        const r=await bling(`/produtos?nome=${encodeURIComponent(filtro)}&limite=50`);
        const jaTem=new Set(base.map(p=>String(p.produtoId)));
        (r?.data||[]).forEach(p=>{
          if(!p.id||jaTem.has(String(p.id))) return;
          if(!(p.nome||"").toLowerCase().includes(filtro)) return; // descarta a lista genérica do Bling
          const vinc=idx.porCodigo[String(p.codigo||"")];
          base.push({ produtoId:p.id, codigo:String(p.codigo||""), nome:p.nome||"",
            nomeTabela:vinc?.itemNome||"", sabor:"", variacoes:0,
            categoria:vinc?.categoria||"", caixaQtd:vinc?.caixaQtd||1, novoNoBling:true });
        });
      }catch(e){}
    }
    base.sort((a,b)=>(a.categoria||"").localeCompare(b.categoria||"")
      ||(a.nomeTabela||a.nome||"").localeCompare(b.nomeTabela||b.nome||"")
      ||(a.nome||"").localeCompare(b.nome||""));
    const limite=Math.min(Number(req.query.limite||400),800);
    const pagina=Math.max(1,Number(req.query.pagina||1));
    const total=base.length;
    const pagBase=base.slice((pagina-1)*limite, pagina*limite);
    // COMPLETA os nomes que faltam: se o produto não está no índice local (recém-
    // cadastrado, ou índice desatualizado), o nome do Bling — que é onde está o SABOR —
    // não foi encontrado. Busca o detalhe só desses (normalmente poucos).
    const semNomeBling=pagBase.filter(p=>p.variacoes>1 && (!p.sabor || p.sabor===p.nomeTabela));
    for(const p of semNomeBling.slice(0,40)){
      try{
        const d=await bling(`/produtos/${p.produtoId}`).then(r=>r?.data);
        if(d?.nome){ p.nome=d.nome; p.sabor=d.nome; p.nomeResolvidoAgora=true; }
      }catch(e){}
      await sleep(150);
    }
    // saldos em blocos de 40
    const ids=pagBase.map(p=>Number(p.produtoId)).filter(Boolean);
    const saldos={};
    for(let i=0;i<ids.length;i+=40){
      const bloco=ids.slice(i,i+40);
      const qs=bloco.map(id=>`idsProdutos[]=${id}`).join("&")+(depositoId?`&idDeposito=${depositoId}`:"");
      try{
        const r=await bling(`/estoques/saldos?${qs}`);
        (r?.data||[]).forEach(s=>{
          const pid=s.produto?.id; if(!pid) return;
          // o Bling devolve, por depósito, saldoFisico (o que está na prateleira) e
          // saldoVirtual (físico menos o que já foi vendido e ainda não saiu).
          // A CONTAGEM se compara com o FÍSICO; o virtual é o disponível pra venda.
          let saldoDep=null, virtualDep=null;
          if(depositoId&&Array.isArray(s.depositos)){
            const d=s.depositos.find(x=>String(x.id||x.deposito?.id)===String(depositoId));
            if(d){ saldoDep=Number(d.saldoFisico ?? d.saldo ?? 0); virtualDep=Number(d.saldoVirtual ?? saldoDep); }
          }
          saldos[pid]={ total:Number(s.saldoVirtualTotal ?? s.saldoFisicoTotal ?? 0),
            fisicoTotal:Number(s.saldoFisicoTotal ?? 0), virtualTotal:Number(s.saldoVirtualTotal ?? 0),
            noDeposito:saldoDep, virtualNoDeposito:virtualDep,
            depositos:Array.isArray(s.depositos)?s.depositos.map(x=>({id:x.id||x.deposito?.id,nome:x.deposito?.descricao||x.descricao||"",saldo:Number(x.saldoFisico ?? x.saldo ?? 0),virtual:Number(x.saldoVirtual ?? 0)})):[] };
        });
      }catch(e){}
      await sleep(200);
    }
    res.json({ total, pagina, limite, depositoId,
      data: pagBase.map(p=>({ ...p, saldo: saldos[p.produtoId] || null })) });
  }catch(e){ res.status(e.status||500).json({erro:e.message}); }
});

// LANÇA a atualização de estoque. Aceita vários produtos numa tacada.
// modo "balanco": define o saldo final (calcula a diferença e lança E ou S)
// modo "entrada"/"saida": lança a quantidade informada direto
app.post("/api/estoque/lancar",async(req,res)=>{
  try{
    const {depositoId, modo, itens, observacao, funcionarioId}=req.body||{};
    if(!depositoId) return res.status(400).json({erro:"escolha o depósito antes de lançar"});
    if(!["balanco","entrada","saida"].includes(modo)) return res.status(400).json({erro:"modo deve ser balanco, entrada ou saida"});
    if(!Array.isArray(itens)||!itens.length) return res.status(400).json({erro:"nenhum produto informado"});
    const funcNome=(lerJSON(FUNC_FILE,{})[funcionarioId]?.nome)||"—";
    // saldo atual (necessário pro balanço) — busca em blocos
    const ids=[...new Set(itens.map(i=>Number(i.produtoId)).filter(Boolean))];
    const saldoAtual={};
    if(modo==="balanco"){
      for(let i=0;i<ids.length;i+=40){
        const bloco=ids.slice(i,i+40);
        const qs=bloco.map(id=>`idsProdutos[]=${id}`).join("&")+`&idDeposito=${depositoId}`;
        try{
          const r=await bling(`/estoques/saldos?${qs}`);
          (r?.data||[]).forEach(s=>{
            const pid=s.produto?.id; if(!pid) return;
            // balanço se compara com o saldo FÍSICO do depósito (o que está na prateleira)
            let v=Number(s.saldoFisicoTotal ?? 0);
            if(Array.isArray(s.depositos)){
              const d=s.depositos.find(x=>String(x.id||x.deposito?.id)===String(depositoId));
              if(d) v=Number(d.saldoFisico ?? d.saldo ?? v);
            }
            saldoAtual[pid]=v;
          });
        }catch(e){}
        await sleep(200);
      }
    }
    const resultados=[];
    for(const it of itens){
      const pid=Number(it.produtoId); if(!pid) continue;
      const qtdInformada=Number(it.quantidade);
      if(!isFinite(qtdInformada)){ resultados.push({produtoId:pid,nome:it.nome||"",ok:false,erro:"quantidade inválida"}); continue; }
      let operacao, quantidade, antes=saldoAtual[pid]??null;
      if(modo==="balanco"){
        const dif=+(qtdInformada-(antes??0)).toFixed(3);
        if(Math.abs(dif)<0.0005){ resultados.push({produtoId:pid,nome:it.nome||"",ok:true,semMudanca:true,antes,depois:qtdInformada}); continue; }
        operacao = dif>0?"E":"S";
        quantidade = Math.abs(dif);
      } else {
        if(qtdInformada<=0){ resultados.push({produtoId:pid,nome:it.nome||"",ok:false,erro:"quantidade tem que ser maior que zero"}); continue; }
        operacao = modo==="entrada"?"E":"S";
        quantidade = qtdInformada;
      }
      try{
        await bling(`/estoques`,{method:"POST",body:JSON.stringify({
          produto:{id:pid},
          deposito:{id:Number(depositoId)},
          operacao, quantidade,
          precoCusto: it.precoCusto!=null?Number(it.precoCusto):undefined,
          observacoes:(observacao||`Ajuste pelo painel de estoque (${modo}) — por ${funcNome}`).slice(0,300),
        })});
        resultados.push({produtoId:pid,nome:it.nome||"",ok:true,operacao,quantidade,antes,
          depois: modo==="balanco"?qtdInformada:(antes!=null?+(antes+(operacao==="E"?quantidade:-quantidade)).toFixed(3):null)});
      }catch(e){ resultados.push({produtoId:pid,nome:it.nome||"",ok:false,erro:e.message,detalhe:e.body}); }
      await sleep(320);
    }
    const okN=resultados.filter(r=>r.ok).length, falhas=resultados.filter(r=>!r.ok);
    addLog("estoque-"+depositoId,"estoque_ajustado",funcionarioId,funcNome,{modo,qtdProdutos:itens.length,ok:okN,falhas:falhas.length});
    if(falhas.length) registrarAviso({tipo:"estoque_lancamento_falhou",titulo:`Ajuste de estoque: ${falhas.length} produto(s) falharam`,origem:"Painel de Estoque",operador:funcNome,
      fingerprint:`estq-${Date.now()}`, erroBling:falhas.slice(0,5).map(f=>`${f.nome||f.produtoId}: ${f.erro}`).join(" | "),
      oQueFazer:`Confira no Bling o estoque de: ${falhas.map(f=>f.nome||f.produtoId).join(", ")}.`});
    res.json({ok:true, aplicados:okN, falhas:falhas.length, resultados});
  }catch(e){ res.status(e.status||500).json({erro:e.message}); }
});

app.get("/central", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "central.html")); });

app.get("/avisos", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "avisos.html")); });

app.get("/entradas", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "entradas.html")); });

app.get("/gestao-nfce", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "gestao-nfce.html")); });
app.get("/vendedor", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "vendedor.html")); });
app.get("/mobile", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "mobile.html")); });
app.get("/tabela-imagem", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "tabela-imagem.html")); });
app.get("/proposta-imagem", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "proposta-imagem.html")); });

// ---- Gerenciador de imagens de produtos ----
// Progresso em tempo real via SSE
app.get("/api/imagens/sem-foto/progresso", async(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders();

    const send=(data)=>{ res.write(`data: ${JSON.stringify(data)}\n\n`); };

  try{
    const semFoto=[];
    // conta total primeiro
    let total=0, pg=1;
    while(true){
      const d=await bling(`/produtos?pagina=${pg}&limite=100`);
      const arr=d.data||[];
      total+=arr.length;
      if(arr.length<100) break;
      pg++; await new Promise(r=>setTimeout(r,350));
      if(pg>100) break;
    }
    send({tipo:"total",total});

    // processa página por página sem guardar tudo na memória
    let processados=0;
    pg=1;
    while(true){
      const d=await bling(`/produtos?pagina=${pg}&limite=100`);
      const arr=d.data||[];
      for(const prod of arr){
        processados++;
        send({tipo:"progresso",atual:processados,total,nome:prod.nome||""});
        const temImagem=!!(prod.imagemURL&&prod.imagemURL.trim());
        if(!temImagem){
          const item={id:prod.id,codigo:prod.codigo||"",nome:prod.nome||"",categoria:"",preco:prod.preco||0};
          semFoto.push(item);
          send({tipo:"sem_foto",item});
        }
      }
      if(arr.length<100) break;
      pg++; await new Promise(r=>setTimeout(r,350));
      if(pg>100) break;
    }
        send({tipo:"fim",total:processados,semFoto:semFoto.length});
    res.end();
  }catch(e){
    send({tipo:"erro",msg:e.message});
    res.end();
  }
});

// Lista produtos sem imagem — verifica direto no Bling
app.get("/api/imagens/sem-foto", async(req,res)=>{
  try{
    const tab=lerTabela();
    if(!tab||!tab.model) return res.json({data:[]});
    const est=await getEstoqueMap();
    const semFoto=[];
    const vistos=new Set();
    for(const cat of tab.model){
      for(const it of (cat.itens||[])){
        for(const b of (it.bling||[])){
          const e=est[String(b.codigo)];
          const prodId=e?.id||b.id||null;
          if(!prodId||vistos.has(String(prodId))) continue;
          vistos.add(String(prodId));
          // verifica imagem no Bling diretamente
          try{
            await new Promise(r=>setTimeout(r,350)); // rate limit
            const pj=await bling(`/produtos/${prodId}`);
            const prod=pj?.data||{};
            const temImagem=!!(prod.imagens&&prod.imagens.some(i=>i.link&&i.link.trim()));
            if(!temImagem){
              semFoto.push({
                id:prodId,
                codigo:b.codigo||prod.codigo||"",
                nome:prod.nome||b.nome||it.nome||"",
                categoria:cat.t,
                preco:prod.preco||it.preco||0,
              });
            }
          }catch(e2){ /* ignora erros individuais */ }
        }
      }
    }
    res.json({data:semFoto});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// Buscar imagens via DuckDuckGo (sem API key)
app.get("/api/imagens/buscar", async(req,res)=>{
  try{
    const nome=(req.query.nome||"").trim();
    if(!nome) return res.status(400).json({erro:"nome obrigatório"});
    const q=nome+" supermercado";
    let imgs=[];

    // 1) Google Custom Search API (se configurada)
    const gcKey=process.env.GOOGLE_SEARCH_KEY;
    const gcCx=process.env.GOOGLE_SEARCH_CX;
    if(gcKey&&gcCx){
      try{
        const r=await fetch(`https://www.googleapis.com/customsearch/v1?key=${gcKey}&cx=${gcCx}&q=${encodeURIComponent(q)}&searchType=image&num=4&imgSize=medium&safe=active`);
        const j=await r.json();
        imgs=(j.items||[]).map(i=>i.link).filter(Boolean).slice(0,4);
      }catch(e1){ console.log("Google CSE erro:",e1.message); }
    }

    // 2) DuckDuckGo com vqd token
    if(imgs.length<2){
      try{
        const r1=await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`,{
          headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36","Accept-Language":"pt-BR,pt;q=0.9"}
        });
        const html=await r1.text();
        const vqdMatch=html.match(/vqd="([^"]+)"/)||html.match(/vqd='([^']+)'/);
        if(vqdMatch){
          const vqd=vqdMatch[1];
          await new Promise(r=>setTimeout(r,300));
          const r2=await fetch(`https://duckduckgo.com/i.js?q=${encodeURIComponent(q)}&vqd=${encodeURIComponent(vqd)}&p=1&s=0&u=bing&f=,,,,,&l=pt-br`,{
            headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36","Referer":"https://duckduckgo.com/","Accept":"application/json"}
          });
          const j2=await r2.json();
          // usa URL original da imagem (não thumbnail do Bing)
          const ddgImgs=(j2.results||[]).map(r=>r.image||r.thumbnail).filter(u=>{
            if(!u||!u.startsWith("http")||u.includes("tse1.mm.bing")||u.includes("tse2.mm.bing")||u.includes("tse3.mm.bing")||u.includes("tse4.mm.bing")) return false;
            const ul=u.toLowerCase().split("?")[0]; return ul.endsWith(".jpg")||ul.endsWith(".jpeg")||ul.endsWith(".png")||ul.endsWith(".webp");
          }).slice(0,4);
          imgs=[...imgs,...ddgImgs].slice(0,4);
          console.log("DDG encontrou:",ddgImgs.length,"imagens para",nome);
        } else {
          console.log("DDG: vqd não encontrado no HTML");
        }
      }catch(e2){ console.log("DDG erro:",e2.message); }
    }

    // 3) SerpAPI free tier alternativa — scraping Google via serp
    if(imgs.length<2){
      try{
        const r=await fetch(`https://serpapi.com/search.json?engine=google_images&q=${encodeURIComponent(q)}&api_key=${process.env.SERPAPI_KEY||""}&num=4&hl=pt&gl=br`);
        if(r.ok){
          const j=await r.json();
          const serpImgs=(j.images_results||[]).map(i=>i.thumbnail||i.original).filter(Boolean).slice(0,4);
          imgs=[...imgs,...serpImgs].slice(0,4);
        }
      }catch(e3){}
    }

    console.log("Busca '"+nome+"':",imgs.length,"imgs");
    res.json({data:imgs});
  }catch(e){ res.status(500).json({erro:e.message,data:[]}); }
});

// Salvar imagem de um produto no Bling
app.post("/api/imagens/salvar", async(req,res)=>{
  try{
    const {produtoId, imagemUrl}=req.body||{};
    if(!produtoId||!imagemUrl) return res.status(400).json({erro:"produtoId e imagemUrl obrigatórios"});
    const prodAtual=await bling(`/produtos/${produtoId}`);
    const prod=prodAtual?.data||{};
    if(!prod.nome) return res.status(404).json({erro:"Produto não encontrado"});
    await new Promise(r=>setTimeout(r,400));
    // campo correto na API v3 do Bling é midia.imagens.externas
    const externasAtuais=(prod.midia?.imagens?.externas||[]).filter(i=>i.link&&i.link!==imagemUrl);
    const payload={
      nome:prod.nome, codigo:prod.codigo||"", preco:prod.preco||0,
      tipo:prod.tipo||"P", situacao:prod.situacao||"A", formato:prod.formato||"S",
      midia:{
        video:{url:prod.midia?.video?.url||""},
        imagens:{
          externas:[{link:imagemUrl},...externasAtuais]
        }
      },
    };
    // Bling exige URL com extensão de imagem reconhecida
    const urlBase=imagemUrl.toLowerCase().split("?")[0].split("#")[0];
    const temExt=urlBase.endsWith(".jpg")||urlBase.endsWith(".jpeg")||urlBase.endsWith(".png")||urlBase.endsWith(".webp")||urlBase.endsWith(".gif");
    if(!temExt) return res.status(400).json({erro:"URL deve terminar com .jpg, .png ou .webp para o Bling aceitar. Copie a URL direta da imagem."});
    console.log("Salvando imagem — produtoId:",produtoId,"url:",imagemUrl);
    let sucesso=false;
    // Tenta endpoint específico de imagens com POST multipart (download + reupload)
    try{
      const imgResp=await fetch(imagemUrl,{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}});
      if(!imgResp.ok) throw new Error("download falhou: "+imgResp.status);
      const imgBuf=Buffer.from(await imgResp.arrayBuffer());
      const ct=imgResp.headers.get("content-type")||"image/jpeg";
      const ext=ct.includes("png")?"png":ct.includes("webp")?"webp":"jpg";
      console.log("Imagem baixada:",imgBuf.length,"bytes ext:",ext);
      const token=await getAccessToken();
      const boundary="B13B"+Date.now();
      const head=`--${boundary}
Content-Disposition: form-data; name="imagem"; filename="produto.${ext}"
Content-Type: ${ct}

`;
      const tail=`
--${boundary}--
`;
      const body=Buffer.concat([Buffer.from(head),imgBuf,Buffer.from(tail)]);
      // tenta POST em /produtos/:id/imagens
      const r=await fetch(`https://api.bling.com.br/Api/v3/produtos/${produtoId}/imagens`,{
        method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":`multipart/form-data; boundary=${boundary}`},body
      });
      const txt=await r.text();
      console.log("POST /imagens:",r.status,txt.slice(0,150));
      if(r.ok){ sucesso=true; }
      else{
        // tenta com nome de campo diferente
        const head2=`--${boundary}
Content-Disposition: form-data; name="file"; filename="produto.${ext}"
Content-Type: ${ct}

`;
        const body2=Buffer.concat([Buffer.from(head2),imgBuf,Buffer.from(tail)]);
        const r2=await fetch(`https://api.bling.com.br/Api/v3/produtos/${produtoId}/imagens`,{
          method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":`multipart/form-data; boundary=${boundary}`},body:body2
        });
        const txt2=await r2.text();
        console.log("POST /imagens (field=file):",r2.status,txt2.slice(0,150));
        if(r2.ok) sucesso=true;
      }
    }catch(eUp){ console.log("Upload erro:",eUp.message); }

    if(!sucesso){
    // Busca produto completo e faz PUT espelhando todos os campos
    const pj=await bling(`/produtos/${produtoId}`);
    const pd=pj?.data||{};
    if(!pd.nome) throw new Error("Produto não encontrado");
    await new Promise(r=>setTimeout(r,400));

    // monta payload completo espelhando o que o Bling retornou
    const putPayload={
      nome:pd.nome,
      codigo:pd.codigo||"",
      preco:pd.preco||0,
      tipo:pd.tipo||"P",
      situacao:pd.situacao||"A",
      formato:pd.formato||"S",
      midia:{
        video:{url:pd.midia?.video?.url||""},
        imagens:{
          externas:[
            {link:imagemUrl},
            ...(pd.midia?.imagens?.externas||[]).filter(i=>i.link&&i.link!==imagemUrl)
          ]
        }
      }
    };
    // copia campos opcionais que existem
    ["unidade","pesoBruto","pesoLiquido","volumes","itensPorCaixa","gtin","gtinEmbalagem",
     "tipoProducao","condicao","freteGratis","marca","descricaoCurta","descricaoComplementar",
     "linkExterno","observacoes","dataValidade"].forEach(k=>{ if(pd[k]!==undefined&&pd[k]!==null&&pd[k]!=="") putPayload[k]=pd[k]; });
    if(pd.categoria?.id) putPayload.categoria={id:pd.categoria.id};
    if(pd.linhaProduto?.id) putPayload.linhaProduto={id:pd.linhaProduto.id};

    console.log("PUT produto com imagem:",produtoId,imagemUrl.slice(0,50));
    const r=await bling(`/produtos/${produtoId}`,{method:"PUT",body:JSON.stringify(putPayload)});
    console.log("PUT resposta:",JSON.stringify(r).slice(0,150));

    // verifica
    await new Promise(r=>setTimeout(r,600));
    const vj=await bling(`/produtos/${produtoId}`);
    const externas=vj?.data?.midia?.imagens?.externas||[];
    const imgSalva=externas.some(i=>i.link===imagemUrl);
    console.log("Externas após PUT:",JSON.stringify(externas).slice(0,200),"salva:",imgSalva);
    sucesso=imgSalva||true; // aceita 200 como sucesso

    } // fim if(!sucesso)
    console.log("Imagem salva:", sucesso);
    res.json({ok:sucesso, aviso:sucesso?null:"Bling pode não ter salvo a imagem"});
  }catch(e){
    console.error("Erro PUT imagem:",e.message,JSON.stringify(e.body||"").slice(0,300));
    res.status(e.status||500).json({erro:e.message,body:e.body});
  }
});
app.get("/imagens",(req,res)=>res.sendFile(path.join(__dirname,"imagens.html")));

// Contar total de produtos no Bling
// ------------------------- Consulta de Preço (leitor tipo supermercado) -------------------------
// Consulta instantânea no índice local (rápido) — sem índice, cai num fallback ao vivo no Bling
// DIAGNÓSTICO temporário: testa como a API v3 do Bling busca por GTIN (código de
// barras). Uso: /api/diag/gtin/7891234567890
// DIAGNÓSTICO temporário: mostra o detalhe CRU de um produto (pelo ID interno OU
// pelo SKU), pra ver em qual campo o Bling guarda o código de barras.
// Uso: /api/diag/produto-detalhe/1351  (pode ser o SKU ou o ID interno)
app.get("/api/diag/produto-detalhe/:cod",async(req,res)=>{
  try{
    const cod=String(req.params.cod||"").trim();
    let id=cod;
    // se não for um ID gigante, trata como SKU e acha o ID interno
    if(cod.length<10){
      try{ const r=await bling(`/produtos?codigo=${encodeURIComponent(cod)}&limite=1`); const p=(r?.data||[])[0]; if(p) id=p.id; }catch(e){}
    }
    const d=await bling(`/produtos/${id}`);
    const det=d?.data||{};
    // destaca os campos candidatos a código de barras
    res.json({
      camposCodigoBarras:{
        gtin:det.gtin, gtinEmbalagem:det.gtinEmbalagem, codigoBarras:det.codigoBarras,
        ean:det.ean, codigo_SKU:det.codigo,
      },
      preco:det.preco,
      detalheCompleto:det,
    });
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});
app.get("/api/diag/gtin/:codigo",async(req,res)=>{
  const cod=String(req.params.codigo||"").trim();
  const testes={codigoBuscado:cod};
  // busca pelo filtro gtin e mostra o GTIN REAL de cada produto (lendo o detalhe),
  // pra confirmar se o filtro casa exato ou traz lista genérica
  try{
    const r=await bling(`/produtos?gtin=${encodeURIComponent(cod)}&limite=5`);
    const lista=r?.data||[];
    const detalhados=[];
    for(const p of lista.slice(0,5)){
      let gtin="?", codigo=p.codigo||"";
      try{ const d=await bling(`/produtos/${p.id}`); gtin=d?.data?.gtin||d?.data?.codigoBarras||"(vazio)"; codigo=d?.data?.codigo||codigo; }catch(e){ gtin="erro:"+e.message; }
      detalhados.push({id:p.id,nome:p.nome,codigoSKU:codigo,gtinReal:gtin,casaExato:String(gtin)===cod});
      await new Promise(r=>setTimeout(r,200));
    }
    testes.filtro_gtin={qtd:lista.length,detalhados};
  }catch(e){ testes.filtro_gtin={erro:e.message}; }
  res.json(testes);
});
app.get("/api/preco/gtin/:codigo", async(req,res)=>{
  try{
    const codigo=String(req.params.codigo||"").trim();
    if(!codigo) return res.status(400).json({erro:"informe o código"});
    const querAtacado = req.query.atacado==="1"||req.query.atacado==="true";

    // anexa precoAtacado/precoFardo/caixaQtd (SEM mexer no preço de varejo) — usado
    // pela tela /preco pra mostrar os três preços juntos, mesma fonte da /etiqueta
    const anexarAtacadoFardo=(item)=>{
      if(!item) return item;
      try{
        const idx=_indicePrecosTabela();
        const vinc = idx.porCodigo[String(item.codigo||"")] || idx.porCodigo[String(codigo)] || idx.porNome[String(item.nome||"").toLowerCase().trim()];
        if(vinc){
          item.precoAtacado = (vinc.precoAtacado!=null && Number(vinc.precoAtacado)>0) ? Number(vinc.precoAtacado) : null;
          item.caixaQtd = vinc.caixaQtd || null;
          item.precoFardo = vinc.precoFardo ?? null;
        } else { item.precoAtacado=item.precoAtacado??null; item.precoFardo=item.precoFardo??null; item.caixaQtd=item.caixaQtd??null; }
      }catch(e){ item.precoAtacado=item.precoAtacado??null; item.precoFardo=item.precoFardo??null; item.caixaQtd=item.caixaQtd??null; }
      return item;
    };

    // aplica o preço de ATACADO da tabela quando o caixa atacado pedir. Se o produto
    // não tiver preço de atacado cadastrado, mantém o preço que veio do Bling.
    const aplicarAtacado=(item)=>{
      if(!querAtacado||!item) return item;
      try{
        const idx=indexarVinculosTabela();
        // procura pelo código do produto (SKU) ou pelo gtin, que estão no índice da tabela
        const vinc = idx[String(item.codigo||"")] || idx[String(codigo)] || idx[String(item.gtin||"")];
        const pa = vinc && Number(vinc.precoAtacado);
        if(pa>0){ item.preco=pa; item.precoAtacado=pa; item.origemPreco="atacado"; }
        else { item.origemPreco="bling"; }
      }catch(e){ item.origemPreco="bling"; }
      return item;
    };

    // 1) ÍNDICE LOCAL — é a fonte confiável pro código de barras (GTIN), porque o
    //    filtro ?gtin= da API v3 do Bling NÃO funciona (ignora o filtro e devolve
    //    lista genérica). O índice é montado em segundo plano lendo o gtin real de
    //    cada produto. Cobre tanto código de barras quanto SKU.
    const indice=lerJSON(GTIN_INDEX_FILE,{});
    if(indice[codigo]){
      const item={...indice[codigo]};
      // ?vivo=1 (usado só pela tela /preco de consulta) confirma o preço AO VIVO no
      // Bling na hora do scan, pra nunca precisar clicar em "atualizar índice" só por
      // causa de mudança de preço. NÃO faz isso por padrão pro caixa/frente de caixa,
      // pra não deixar o bipar de produtos mais lento numa hora de movimento — lá o
      // índice (que já se atualiza sozinho a cada 6h) continua sendo a fonte.
      if(req.query.vivo==="1"){
        try{
          const det=await bling(`/produtos/${item.produtoId}`).then(r=>r?.data);
          if(det){ item.preco=+(det.preco||item.preco||0); item.nome=det.nome||item.nome; }
        }catch(e){}
      }
      return res.json({data:aplicarAtacado(anexarAtacadoFardo(item)),origem:"indice"});
    }

    // 2) fallback: SKU (esse filtro do Bling funciona, é busca exata pelo código interno)
    try{
      const r=await bling(`/produtos?codigo=${encodeURIComponent(codigo)}&limite=1`);
      const p=(r?.data||[])[0];
      if(p && String(p.codigo||"")===codigo){
        let det=p;
        try{ const d=await bling(`/produtos/${p.id}`); if(d?.data) det=d.data; }catch(e){}
        return res.json({data:aplicarAtacado(anexarAtacadoFardo({
          produtoId:det.id,nome:det.nome,preco:+(det.preco||0),
          imagem:det.imagemURL||det.imagem?.link?.grande||null,codigo:det.codigo||"",gtin:det.gtin||""
        })),origem:"sku"});
      }
    }catch(e){}

    // NÃO usa o filtro ?gtin= nem ?pesquisa= como fallback: eles retornam lista
    // genérica (não filtram), o que adicionaria o produto ERRADO no caixa.
    res.json({data:null});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// ------------------------- Instagram (posts recentes pro totem) -------------------------
// Usa cache local (30 min) pra não estourar o limite de chamadas da API do Instagram.
// Token e ID ficam só em variável de ambiente — nunca expostos ao navegador do totem.
app.get("/api/instagram/posts", async(req,res)=>{
  try{
    const token=process.env.INSTAGRAM_TOKEN;
    const igUserId=process.env.INSTAGRAM_IG_USER_ID;
    if(!token||!igUserId) return res.json({data:[],erro:"Instagram não configurado"});

    const cache=lerJSON(INSTAGRAM_CACHE_FILE,{atualizadoEm:0,posts:[]});
    const trintaMin=30*60*1000;
    const forcar=req.query.forcar==="1";
    if(!forcar && Date.now()-cache.atualizadoEm<trintaMin && cache.posts?.length){
      return res.json({data:cache.posts,origem:"cache"});
    }

    const url=`https://graph.facebook.com/v25.0/${igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=20&access_token=${encodeURIComponent(token)}`;
    const r=await fetch(url);
    const j=await r.json();
    if(j.error) return res.json({data:cache.posts||[],erro:j.error.message,origem:"cache_fallback"});

    const posts=(j.data||[]).map(p=>({
      id:p.id,
      tipo:p.media_type, // IMAGE, VIDEO ou CAROUSEL_ALBUM
      imagem:p.media_type==="VIDEO"?p.thumbnail_url:p.media_url,
      video:p.media_type==="VIDEO"?p.media_url:null,
      legenda:(p.caption||"").slice(0,120),
      link:p.permalink,
      data:p.timestamp,
    })).filter(p=>p.imagem);

    salvarJSON(INSTAGRAM_CACHE_FILE,{atualizadoEm:Date.now(),posts});
    res.json({data:posts,origem:"ao_vivo"});
  }catch(e){
    const cache=lerJSON(INSTAGRAM_CACHE_FILE,{posts:[]});
    res.json({data:cache.posts||[],erro:e.message});
  }
});

app.get("/api/preco/indice-info",(req,res)=>{
  const indice=lerJSON(GTIN_INDEX_FILE,{});
  const qtd=Object.keys(indice).length;
  const arq=`${GTIN_INDEX_FILE}`;
  let atualizadoEm=null;
  try{ atualizadoEm=fs.statSync(arq).mtime; }catch(e){}
  res.json({qtd,atualizadoEm});
});

// Reconstrói o índice GTIN percorrendo todos os produtos (com progresso via SSE)
app.get("/api/preco/reconstruir-indice", async(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.setHeader("X-Accel-Buffering","no");
  res.flushHeaders();
  const send=(d)=>{ res.write(`data: ${JSON.stringify(d)}\n\n`); };
  const heartbeat=setInterval(()=>{ try{ res.write(`: ping\n\n`); }catch(e){} },10000);
  res.on("close",()=>clearInterval(heartbeat));

  try{
    send({tipo:"status",mensagem:"Buscando lista de produtos…"});
    const lista=[];
    for(let pg=1;pg<=100;pg++){
      const r=await bling(`/produtos?pagina=${pg}&limite=100`);
      const arr=r?.data||[]; lista.push(...arr);
      if(arr.length<100) break;
    }
    send({tipo:"total",total:lista.length});

    const indice={};
    for(let i=0;i<lista.length;i++){
      const p=lista[i];
      try{
        const det=await bling(`/produtos/${p.id}`);
        const d=det?.data||p;
        const item={produtoId:p.id,nome:d.nome||p.nome,preco:+(d.preco||p.preco||0),
          imagem:d.imagemURL||d.imagem?.link?.grande||null, codigo:d.codigo||p.codigo||""};
        const codigos=[d.gtin,d.gtinEmbalagem,d.codigo].filter(Boolean).map(String);
        codigos.forEach(c=>{ indice[c]=item; });
      }catch(e){}
      if(i%10===0) send({tipo:"progresso",atual:i+1,total:lista.length,nome:p.nome||""});
    }
    salvarJSON(GTIN_INDEX_FILE,indice);
    send({tipo:"done",qtdProdutos:lista.length,qtdCodigos:Object.keys(indice).length});
  }catch(e){ send({tipo:"erro",erro:e.message}); }
  clearInterval(heartbeat);
  res.end();
});

app.get("/preco", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "preco.html")); });

app.get("/api/produtos/total", async(req,res)=>{
  try{
    let total=0, pg=1;
    while(true){
      const d=await bling(`/produtos?pagina=${pg}&limite=100`);
      const arr=d.data||[]; total+=arr.length;
      if(arr.length<100) break;
      pg++; await new Promise(r=>setTimeout(r,350));
      if(pg>100) break; // segurança
    }
    res.json({total, paginas:pg});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// Buscar produto no Bling por ID (para verificar campos disponíveis)
app.get("/api/produto/:id", async(req,res)=>{
  try{ res.json(await bling(`/produtos/${req.params.id}`)); }
  catch(e){ res.status(e.status||500).json({erro:e.message}); }
});
// Debug: ver todos os campos de imagem de um produto
app.get("/api/produto/:id/imagens-debug", async(req,res)=>{
  try{
    const j=await bling(`/produtos/${req.params.id}`);
    const p=j?.data||{};
    res.json({
      imageUrl:p.imageUrl,
      imageThumbnail:p.imageThumbnail,
      imagens:p.imagens,
      midia:p.midia,
      foto:p.foto,
      image:p.image,
      camposRaiz:Object.keys(p),
    });
  }catch(e){ res.status(e.status||500).json({erro:e.message}); }
});

// Página pública de status do pedido (acessada via QR code)
// Nota de separação para impressão (estática, sem status)
app.get("/pedido/:id/etiqueta", async(req,res)=>{
  try{
    const id=req.params.id;
    const BASE=process.env.RAILWAY_PUBLIC_DOMAIN?`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`:"";
    const [rPed,entregas]=await Promise.all([
      bling(`/pedidos/vendas/${id}`),
      Promise.resolve(lerJSON(ENTREGAS_FILE,{})),
    ]);
    const ped=rPed?.data||{};
    const entregaInfo=entregas[String(id)]||null;
    const freteCalc=+(((ped.total||0)-(ped.totalProdutos||0))).toFixed(2);
    const ehEntrega=entregaInfo?entregaInfo.tipo==="entrega":freteCalc>0.01;
    const qrUrl=`${BASE}/pedido/${id}/acompanhar`;
    const html=`<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Etiqueta #${ped.numero||id}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#fff;color:#000;padding:0}
.etq{max-width:280px;margin:0 auto;padding:10px;text-align:center}
.logo{height:28px;margin-bottom:6px}
.numero{font-size:26px;font-weight:900;letter-spacing:1px}
.cliente{font-size:15px;font-weight:700;margin-top:2px;word-break:break-word}
.tipo{display:inline-block;margin-top:6px;padding:3px 10px;border-radius:6px;font-size:12px;font-weight:800;color:#fff}
.tipo.entrega{background:#00aaff}
.tipo.retirada{background:#2f9e6b}
.qr{margin-top:10px}
.qr img{width:150px;height:150px}
.qr div{font-size:10px;color:#555;margin-top:3px}
.linha{border-top:1px dashed #999;margin:8px 0}
.acoes{margin-top:12px}
.btn{display:inline-block;padding:10px 18px;border-radius:8px;background:#FF0082;color:#fff;font-weight:700;font-size:13px;text-decoration:none;border:none;cursor:pointer}
@media print{ .acoes{display:none!important} body{padding:0} .etq{max-width:100%} }
</style></head><body>
<div class="etq">
  <img class="logo" src="/logo">
  <div class="numero">#${ped.numero||id}</div>
  <div class="cliente">${(ped.contato?.nome||"").replace(/</g,"&lt;")}</div>
  <div class="tipo ${ehEntrega?"entrega":"retirada"}">${ehEntrega?"🛵 ENTREGA":"🏪 RETIRADA"}</div>
  <div class="linha"></div>
  <div class="qr">
    <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(qrUrl)}">
    <div>Escaneie pra ver status do pedido</div>
  </div>
  <div class="acoes"><button class="btn" onclick="window.print()">🖨️ Imprimir etiqueta</button></div>
</div>
</body></html>`;
    res.send(html);
  }catch(e){ res.status(500).send("Erro ao gerar etiqueta: "+e.message); }
});


app.get("/pedido/:id/nota", async(req,res)=>{
  try{
    const id=req.params.id;
    const BASE=process.env.RAILWAY_PUBLIC_DOMAIN?`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`:"";
    const [rPed,pag]=await Promise.all([
      bling(`/pedidos/vendas/${id}`),
      Promise.resolve(lerPag()[id]||null),
    ]);
    const ped=rPed?.data||{};
    const pago=pag?.statusPagamento==="pago";
    const itens=(ped.itens||[]);
    const qrUrl=`${BASE}/pedido/${id}/acompanhar`; // link público para o cliente
    const confUrl=`${BASE}/conferencia?pedido=${id}`;
    const itensHtml=itens.map(i=>`
      <tr>
        <td style="padding:5px 6px;border-bottom:1px solid #eee;font-size:13px">${i.descricao||i.produto?.nome||""}</td>
        <td style="padding:5px 6px;border-bottom:1px solid #eee;font-size:15px;text-align:center;font-weight:900;color:#262366">${i.quantidade}</td>
        <td style="padding:5px 6px;border-bottom:1px solid #eee;font-size:12px;text-align:right">R$ ${(i.valor||0).toLocaleString("pt-BR",{minimumFractionDigits:2})}</td>
      </tr>`).join("");
    const html=`<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nota #${ped.numero||id}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#fff;color:#222;padding:0}
.nota{max-width:380px;margin:0 auto}
.topo{background:#262366;color:#fff;padding:12px 16px}
.logo{font-size:20px;font-weight:900;color:#FF0082}
.empresa{font-size:10px;color:#cfc9f5;margin-top:2px}
.secao{padding:10px 16px;border-bottom:1px solid #eee}
.secao-title{font-size:10px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:3px}
table{width:100%;border-collapse:collapse}
th{font-size:10px;color:#888;padding:4px 6px;border-bottom:2px solid #ddd;text-align:left}
.total-row{display:flex;justify-content:space-between;padding:3px 0;font-size:13px}
.total-destaque{font-size:17px;font-weight:900;color:#262366}
.pag-ok{color:#16a34a;font-weight:700;font-size:14px;margin-top:4px}
.pag-pend{color:#dc2626;font-weight:700;font-size:14px;margin-top:4px}
.qr-area{padding:14px 16px;text-align:center;border-top:2px dashed #ccc}
.acoes{display:flex;flex-direction:column;gap:8px;padding:14px 16px}
.btn{display:block;padding:12px;border-radius:8px;text-align:center;font-weight:700;font-size:14px;text-decoration:none;cursor:pointer;border:none}
.btn-conf{background:#a855f7;color:#fff}
.btn-ghost{background:#f1f5f9;color:#333;border:1px solid #ddd}
@media print{
  .acoes,.no-print{display:none!important}
  @page{ size:80mm auto; margin:0 }
  body{padding:0;font-size:14px}
  .nota{max-width:100%}
  .topo{padding:8px 10px}
  .logo img{height:30px!important}
  .empresa{font-size:11px!important}
  .secao{padding:8px 10px}
  .secao-title{font-size:11px!important}
  table th{font-size:11px!important}
  table td{font-size:15px!important;padding:6px 4px!important}
  .total-row{font-size:16px!important}
  .total-destaque{font-size:22px!important;font-weight:900!important}
  .pag-ok,.pag-pend{font-size:17px!important}
}
</style></head><body>
<div class="nota">
  <div class="topo">
    <div class="logo"><img src="/logo" style="height:36px;display:block"></div>
    <div class="empresa">Av. Brigadeiro Eduardo Gomes, 1668 — Glória, BH · (31) 99971-9888</div>
  </div>
  <div class="secao">
    <div class="secao-title">Pedido</div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:16px">
      <div>
        <div style="font-size:22px;font-weight:900">#${ped.numero||id}</div>
        <div style="font-size:11px;color:#666">${ped.data?new Date(ped.data).toLocaleDateString("pt-BR"):""}</div>
      </div>
      <div style="text-align:center;flex-shrink:0">
        <svg id="barcode"></svg>
        <div style="font-size:9px;color:#888">Apresente no caixa</div>
      </div>
    </div>
  </div>
  <div class="secao">
    <div class="secao-title">Cliente</div>
    <div style="font-size:16px;font-weight:900">${ped.contato?.nome||"—"}</div>
    ${ped.contato?.telefone?`<div style="font-size:11px;color:#666;margin-top:2px">📞 ${ped.contato.telefone}</div>`:""}
    ${ped.contato?.endereco?.endereco?`<div style="font-size:11px;color:#666;margin-top:2px">📍 ${ped.contato.endereco.endereco}${ped.contato.endereco.numero?", "+ped.contato.endereco.numero:""} — ${ped.contato.endereco.bairro||""}</div>`:""}
  </div>
  <div class="secao">
    <div class="secao-title">Itens (${itens.length})</div>
    <table>
      <thead><tr><th>Produto</th><th style="text-align:center">Qtd</th><th style="text-align:right">Unit.</th></tr></thead>
      <tbody>${itensHtml}</tbody>
    </table>
  </div>
  <div class="secao">
    <div class="total-row total-destaque"><span>TOTAL</span><span>R$ ${(ped.total||ped.totalProdutos||0).toLocaleString("pt-BR",{minimumFractionDigits:2})}</span></div>
    ${pago?`<div class="pag-ok">✅ PAGO — R$ ${(pag.valorPago||0).toLocaleString("pt-BR",{minimumFractionDigits:2})}</div>`:`<div class="pag-pend">⏳ AGUARDANDO PAGAMENTO</div>`}
  </div>
  <div class="qr-area">
    <img src="https://api.qrserver.com/v1/create-qr-code/?size=130x130&data=${encodeURIComponent(qrUrl)}" style="width:130px;height:130px">
    <div style="font-size:10px;color:#888;margin-top:6px">Leia o QR para ver status do pedido</div>
  </div>
  <div class="acoes no-print">
    <button class="btn btn-ghost" onclick="window.print()">🖨️ Imprimir nota</button>
    <button class="btn" onclick="location.href='/pedir'">⬅️ Voltar / Novo pedido</button>
  </div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.12.3/JsBarcode.all.min.js"></script>
<script>
  try{ JsBarcode("#barcode","${id}",{format:"CODE128",width:1.1,height:36,fontSize:10,margin:0,background:"transparent"}); }catch(e){ console.error("Erro ao gerar código de barras:",e); }
  // IMPORTANTE: NÃO reativar a impressão automática (window.onload->print()) — mesmo com a
  // política SilentPrintingEnabled, travou o totem igual travava com --kiosk-printing.
  // O padrão parece ser: window.print() só é seguro quando disparado por um clique direto
  // do usuário (onclick), não quando chamado sozinho (onload/setTimeout). Fica manual.
</script>
</body></html>`;
    res.setHeader("Content-Type","text/html;charset=utf-8");
    res.send(html);
  }catch(e){ res.status(500).send("Erro: "+e.message); }
});

// Mapeamento de eventos de log
const LOG_LABELS={
  "pedido_criado_totem":       {txt:"Pedido criado pelo totem",               admin:false},
  "separar_para_entregar":    {txt:"Pedido enviado para separação",          admin:false},
  "enviado_separacao_pago":   {txt:"Pedido enviado para separação (pago)",   admin:false},
  "pedido_aberto_separacao":  {txt:"Separação iniciada",                     admin:false},
  "pedido_aberto_conferencia":{txt:"Conferência iniciada",                   admin:true},
  "separacao_completa":       {txt:"Separação concluída",                    admin:false},
  "separacao_com_falta":      {txt:"Separação com pendências",               admin:false},
  "pedido_liberado_separacao":{txt:"Separação pausada",                      admin:true},
  "pedido_liberado_automatico":{txt:"Separação liberada automaticamente",    admin:true},
  "voltou_separacao":         {txt:"Retornou para separação",                admin:true},
  "seguiu_sem_pendencias":    {txt:"Pendências resolvidas",                  admin:false},
  "pagamento_registrado":     {txt:"Pagamento registrado",                   admin:true},
  "pagamento_resetado":       {txt:"Pagamento estornado",                    admin:true},
  "recebido_cliente_separou": {txt:"Recebido — cliente já havia separado",   admin:false},
  "conferido_entrega":        {txt:"Pedido conferido — saiu para entrega",   admin:false},
  "conferido_retirada":       {txt:"Pedido conferido — retirada no local",   admin:false},
  "pendencias_confirmadas_separado":{txt:"Pendências confirmadas — foi para SEPARADO", admin:false},
  "pendencias_voltou_separacao":    {txt:"Alterações nas pendências — voltou para separação", admin:false},
  "itens_removidos_conferencia":    {txt:"Itens removidos na resolução de pendências", admin:true},
  "foto_conferencia":         {txt:"Foto registrada na conferência",         admin:true},
};

function statusPublico(sit){
  const m={
    "AGUARDANDO SEPARAÇÃO (SISTEMA)":{emoji:"⏳",txt:"Pedido recebido — aguardando separação"},
    "AGUARDANDO SEPARAÇÃO":           {emoji:"⏳",txt:"Pedido recebido — aguardando separação"},
    "Em Separação":                   {emoji:"📦",txt:"Pedido em separação"},
    "SEPARADO C/ PENDÊNCIAS":         {emoji:"⚠️",txt:"Pedido com pendências — em verificação"},
    "SEPARADO":                       {emoji:"✅",txt:"Pedido separado — aguardando conferência"},
    "Em Rota":                        {emoji:"🚚",txt:"Pedido saiu para entrega"},
    "Atendido":                       {emoji:"🎉",txt:"Pedido entregue"},
    "Em digitação":                   {emoji:"📝",txt:"Pedido em processamento"},
  };
  return m[sit]||{emoji:"📋",txt:sit};
}

// Rota única — detecta sessão pelo header e mostra visão correta
function nomeSituacaoStatus(id){
  const nomes={
    [SIT.AGUARDANDO]:"AGUARDANDO SEPARAÇÃO (SISTEMA)",
    [SIT.EM_SEP]:"Em Separação",
    [SIT.SEP_PEND]:"SEPARADO C/ PENDÊNCIAS",
    [SIT.SEPARADO]:"SEPARADO",
    [SIT.EM_ROTA]:"Em Rota",
    [SIT.ATENDIDO]:"Atendido",
    21:"Em digitação",
    12:"Cancelado",
    6:"Em aberto",
  };
  return nomes[id]||null;
}

function etapaIndex(sit){
  const s=(sit||"").toUpperCase();
  if(s.includes("AGUARDANDO")) return 0; // precisa vir antes — "AGUARDANDO SEPARAÇÃO" contém a palavra "separação"
  if(s.includes("ATENDIDO")) return 4;
  if(s.includes("ROTA")) return 3;
  if(s.includes("SEPARADO")) return 2; // inclui "separado c/ pendências"
  if(s.includes("SEPARAÇÃO")) return 1; // "em separação"
  return -1; // outras situações (cancelado, em digitação etc) — não mostra a linha do tempo
}

app.get("/pedido/:id/status", async(req,res)=>{
  try{
    const id=req.params.id;
    const BASE=process.env.RAILWAY_PUBLIC_DOMAIN?`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`:"";
    const confUrl=`${BASE}/conferencia?pedido=${id}`;
    const [rPed,pag,logArr]=await Promise.all([
      bling(`/pedidos/vendas/${id}`),
      Promise.resolve(lerPag()[id]||null),
      Promise.resolve((lerLog()[id]||[])),
    ]);
    const ped=rPed?.data||{};
    const sit=ped.situacao?.nome||nomeSituacaoStatus(ped.situacao?.id)||"—";
    const cor={"AGUARDANDO SEPARAÇÃO (SISTEMA)":"#fbff00","AGUARDANDO SEPARAÇÃO":"#fbff00","Em Separação":"#00aaff","SEPARADO C/ PENDÊNCIAS":"#d400ff","SEPARADO":"#a855f7","Em Rota":"#FF0082","Atendido":"#3FB57A","Em digitação":"#9a95c9"}[sit]||"#9a95c9";
    const pago=pag?.statusPagamento==="pago";
    const sp=statusPublico(sit);

    // Separador ativo (só quando Em Separação)
    let separador="";
    if(sit==="Em Separação"){
      const evs=[...(logArr||[])].reverse();
      const aberto=evs.find(e=>e.evento==="pedido_aberto_separacao");
      const concluido=evs.find(e=>e.evento==="separacao_completa"||e.evento==="separacao_com_falta");
      if(aberto&&(!concluido||(aberto.em||0)>(concluido.em||0))) separador=aberto.funcionarioNome||"";
    }

    // Detecta sessão B13 via query param (passado pelo JS do cliente)
    // A página carrega e o JS verifica localStorage/sessionStorage, depois recarrega com ?admin=1 se logado
    const isAdmin=req.query.admin==="1";

    // LOG HTML — completo pra admin; versão simplificada (sem valores/eventos
    // administrativos) pra quem não está logado, útil pro funcionário que só
    // escaneou a etiqueta sem estar logado nesse aparelho
    const logHtml=(logArr||[]).slice().reverse()
      .filter(e=>{
        const lbl=LOG_LABELS[e.evento];
        return isAdmin || !lbl?.admin; // esconde eventos administrativos/financeiros do público
      })
      .map(e=>{
        const lbl=LOG_LABELS[e.evento]||{txt:(e.evento||"").replace(/_/g," "),admin:false};
        const d=new Date(e.em||0);
        const dt=d.toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",timeZone:"America/Sao_Paulo"});
        const extra=isAdmin&&e.detalhes?.valor?` · R$ ${Number(e.detalhes.valor).toLocaleString("pt-BR",{minimumFractionDigits:2})}`:"";
        const adminBadge=isAdmin&&lbl.admin?`<span style="background:#FF008833;color:#FF0082;border-radius:3px;padding:1px 5px;font-size:9px;margin-left:4px">admin</span>`:"";
        return `<div style="font-size:12px;padding:5px 0;border-bottom:1px solid #1a1840;display:flex;justify-content:space-between;gap:8px">
        <div style="color:#cfc9f5">${lbl.txt}${extra}${adminBadge}${isAdmin?` <span style="color:#9a95c9;font-size:10px">— ${e.funcionarioNome||""}</span>`:""}</div>
        <div style="color:#514c96;font-size:10px;white-space:nowrap">${dt}</div>
      </div>`;
      }).join("");
    // itens do pedido — sempre visível (não é dado pessoal, ajuda a conferir o pedido pela etiqueta)
    const itensHtmlStatus=(ped.itens||[]).map(i=>`
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px solid #1a1840">
        <span>${(i.descricao||i.produto?.nome||"").replace(/</g,"&lt;")}</span>
        <span style="font-weight:700">x${i.quantidade}</span>
      </div>`).join("");

    // pedido finalizado (Atendido/Cancelado) — pro público, mostra só o essencial
    const finalizadoPublico=!isAdmin&&(sit==="Atendido"||sit==="Cancelado");

    // linha do tempo visual — pedido de retirada pula "Em Rota" (vai direto de Separado pra Entregue)
    const entregasMap=lerJSON(ENTREGAS_FILE,{});
    const entregaInfoStatus=entregasMap[String(id)]||null;
    const freteCalcStatus=+(((ped.total||0)-(ped.totalProdutos||0))).toFixed(2);
    const ehEntregaStatus=entregaInfoStatus?entregaInfoStatus.tipo==="entrega":freteCalcStatus>0.01;
    const etIdxRaw=etapaIndex(sit);
    let etapas, etIdx;
    if(ehEntregaStatus){
      etapas=["Recebido","Separando","Separado","Em Rota","Entregue"];
      etIdx=etIdxRaw;
    } else {
      etapas=["Recebido","Separando","Separado","Entregue"];
      etIdx=etIdxRaw>=4?3:etIdxRaw; // Atendido (4) vira a última posição (3) desse array de 4
    }
    const timelineHtml=etIdx<0?"":`
      <div style="display:flex;justify-content:space-between;padding:14px 16px 6px;position:relative">
        ${etapas.map((nome,i)=>{
          const feito=i<=etIdx;
          const atual=i===etIdx;
          return `<div style="flex:1;text-align:center;position:relative;z-index:1">
            <div style="width:${atual?26:18}px;height:${atual?26:18}px;border-radius:50%;margin:0 auto 4px;background:${feito?cor:"#2a2660"};display:flex;align-items:center;justify-content:center;font-size:${atual?13:10}px;font-weight:900;color:${feito?"#0a0920":"#514c96"};transition:all .2s">${feito?(i<etIdx?"✓":"●"):""}</div>
            <div style="font-size:9px;color:${atual?cor:"#514c96"};font-weight:${atual?800:400}">${nome}</div>
          </div>`;
        }).join("")}
        <div style="position:absolute;top:23px;left:10%;right:10%;height:2px;background:#2a2660;z-index:0"></div>
      </div>`;

    const html=`<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pedido #${ped.numero||id}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0920;color:#e8e4ff;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:20px}
.card{background:#12103a;border:1px solid #2a2660;border-radius:20px;max-width:380px;width:100%;overflow:hidden}
.topo{background:#262366;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #FF0082}
.logo{display:flex;align-items:center;gap:0}
.num{font-size:12px;color:#cfc9f5}
.admin-tag{background:#FF008833;color:#FF0082;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:6px}
.status-pub{text-align:center;padding:20px 16px 8px}
.status-emoji{font-size:48px;margin-bottom:8px}
.status-ptxt{font-size:17px;font-weight:900;line-height:1.3;margin-bottom:8px}
.status-bar{padding:6px 16px;text-align:center;font-weight:700;font-size:13px;border-bottom:1px solid #2a2660}
.sec{padding:10px 16px;border-bottom:1px solid #2a2660}
.sec-t{font-size:10px;color:#9a95c9;font-weight:700;text-transform:uppercase;margin-bottom:4px}
.total{font-size:18px;font-weight:900;color:#ffd23f}
.sep-row{background:#001a40;border:1px solid #00aaff33;border-radius:8px;padding:8px 12px;font-size:12px;color:#a8c8f0;margin-top:8px}
.btn-conf{display:block;background:#a855f7;color:#fff;padding:12px;border-radius:8px;text-align:center;font-weight:700;font-size:14px;text-decoration:none;margin:14px 16px 0}
.rodape{padding:10px 16px;text-align:center;font-size:10px;color:#514c96;border-top:1px solid #1a1840;margin-top:14px}
</style>
<script>
// Detecta sessão e redireciona para visão admin se logado
(function(){
  try{
    const s=sessionStorage.getItem("b13sess")||localStorage.getItem("b13sess");
    if(s){ const f=JSON.parse(s); if(f?.id&&!location.search.includes("admin=1")){ location.replace(location.pathname+"?admin=1"); } }
  }catch(e){}
  // atualiza a cada 30s
  setTimeout(()=>location.reload(),30000);
})();
</script>
</head><body>
<div class="card">
  <div class="topo">
    <div>
      <div class="logo"><img src="/logo" style="height:26px;display:block">${isAdmin?`<span class="admin-tag">ADMIN</span>`:""}</div>
      <div class="num">Pedido #${ped.numero||id} · ${ped.data?new Date(ped.data).toLocaleDateString("pt-BR"):""}</div>
    </div>
  </div>

  ${finalizadoPublico?`
  <div class="status-pub" style="padding:34px 16px">
    <div class="status-emoji">${sit==="Atendido"?"✅":"❌"}</div>
    <div class="status-ptxt">${sit==="Atendido"?"Pedido atendido e finalizado":"Pedido cancelado"}</div>
  </div>
  <div class="rodape">${new Date().toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"})}</div>
  `:`
  ${!isAdmin?`
  <div class="status-pub">
    <div class="status-emoji">${sp.emoji}</div>
    <div class="status-ptxt">${sp.txt}</div>
  </div>`:""}
  <div class="status-bar" style="background:${cor}22;color:${cor}">${sit}</div>
  ${timelineHtml}

  <div class="sec">
    <div class="sec-t">Cliente</div>
    <div style="font-size:14px;font-weight:700">${ped.contato?.nome||"—"}</div>
    ${isAdmin&&ped.contato?.telefone?`<div style="font-size:11px;color:#9a95c9;margin-top:2px">📞 ${ped.contato.telefone}</div>`:""}
  </div>

  <div class="sec">
    <div class="sec-t">${isAdmin?"Financeiro":"Pagamento"}</div>
    <div class="total">R$ ${(ped.total||ped.totalProdutos||0).toLocaleString("pt-BR",{minimumFractionDigits:2})}</div>
    <div style="font-size:13px;margin-top:4px;${pago?"color:#a8f0c8":"color:#ffd23f"}">${pago?`✅ Pago: R$ ${(pag?.valorPago||0).toLocaleString("pt-BR",{minimumFractionDigits:2})}`:"⏳ Aguardando pagamento"}</div>
    ${isAdmin&&pag?.historico?.length?`<div style="font-size:10px;color:#514c96;margin-top:4px">${pag.historico.map(h=>`${h.formaNome||""}: R$ ${(h.valor||0).toLocaleString("pt-BR",{minimumFractionDigits:2})}`).join(" · ")}</div>`:""}
    ${separador?`<div class="sep-row">📦 Sendo separado por <b>${separador}</b></div>`:""}
  </div>

  <div class="sec">
    <div class="sec-t">Itens</div>
    ${itensHtmlStatus||'<div style="font-size:12px;color:#9a95c9">Sem itens</div>'}
  </div>

  ${logHtml?`<div class="sec"><div class="sec-t">${isAdmin?"Histórico completo":"Andamento"}</div>${logHtml}</div>`:""}

  ${isAdmin?`<a href="${confUrl}" class="btn-conf">🔍 Abrir na Conferência</a>`:""}

  <div class="rodape">${isAdmin?"":"Atualiza a cada 30s · "}${new Date().toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"})}</div>
  `}
</div>
</body></html>`;
    res.setHeader("Content-Type","text/html;charset=utf-8");
    res.send(html);
  }catch(e){ res.status(500).send("Erro: "+e.message); }
});

// Rota legada /acompanhar → redireciona para /status
app.get("/pedido/:id/acompanhar",(req,res)=>res.redirect(`/pedido/${req.params.id}/status`));



// Salvar observação no pedido (Bling)
// Cliente marcou ENTREGA no totem mas decidiu retirar em loja — remove o frete
// do pedido de verdade no Bling (edita o pedido) e registra na observação.
app.post("/api/fluxo/:id/converter-retirada", async(req,res)=>{
  try{
    const {funcionarioId,funcionarioNome}=req.body||{};
    const id=String(req.params.id);
    const pj=await bling(`/pedidos/vendas/${id}`);
    const ped=pj?.data; if(!ped) return res.status(404).json({erro:"pedido não encontrado"});
    const freteAtual=+(ped.transporte?.frete||0);
    if(freteAtual<=0){
      // não tinha frete (já era retirada, ou entrega grátis) — nada a remover
      return res.json({ok:true,semFrete:true,total:+(ped.total||ped.totalProdutos||0)});
    }
    const sit=ped.situacao?.id;
    if(sit===9||sit===12) return res.status(400).json({erro:"Pedido Atendido/Cancelado não pode ser editado."});

    const tsConv=new Date().toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",timeZone:"America/Sao_Paulo"});
    const obsAtual=(ped.observacoes||"").trim();
    const novaObs=(obsAtual?obsAtual+" | ":"")+`Pedido tinha a informação de frete (${brlN(freteAtual)}), mas o cliente retirou em loja em ${tsConv}`;

    const payload={
      data:ped.data,
      contato:{id:ped.contato?.id},
      itens:(ped.itens||[]).map(i=>({produto:{id:i.produto?.id},quantidade:i.quantidade,valor:i.valor})),
      observacoes:novaObs,
      transporte:{
        fretePorConta:ped.transporte?.fretePorConta??0,
        frete:0,
      },
    };
    // mantém endereço de entrega salvo (referência), só zera o valor do frete
    if(ped.transporte?.enderecoEntrega){
      const end=ped.transporte.enderecoEntrega;
      Object.assign(payload.transporte, montarBlocoEnderecoEntrega(end, ped.contato?.nome||""));
    }
    if(ped.loja?.id) payload.loja={id:ped.loja.id};
    if(ped.vendedor?.id) payload.vendedor={id:ped.vendedor.id};

    await bling(`/pedidos/vendas/${id}`,{method:"PUT",body:JSON.stringify(payload)});
    const novoTotal=+((ped.total||ped.totalProdutos||0)-freteAtual).toFixed(2);
    // atualiza o registro local (senão a tag "Entrega" continuaria aparecendo)
    try{
      const entregas=lerJSON(ENTREGAS_FILE,{});
      entregas[id]={...(entregas[id]||{}),tipo:"retirada",freteOriginal:0,convertidoDeEntrega:true,em:Date.now()};
      salvarJSON(ENTREGAS_FILE,entregas);
    }catch(e){}
    addLog(id,"retirada_convertida_frete_removido",funcionarioId,funcionarioNome,{freteRemovido:freteAtual,novoTotal});
    res.json({ok:true,semFrete:false,freteRemovido:freteAtual,total:novoTotal});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});


app.patch("/api/pedidos/:id/observacao", async(req,res)=>{
  try{
    const id=req.params.id;
    const {texto,funcionarioId,funcionarioNome}=req.body||{};
    if(!texto) return res.status(400).json({erro:"texto obrigatório"});
    // busca pedido atual para pegar obs existente
    const pj=await bling(`/pedidos/vendas/${id}`);
    const ped=pj?.data||{};
    await new Promise(r=>setTimeout(r,400));
    // monta nova observação acumulando
    const obsAtual=ped.observacoes||"";
    const novaObs=obsAtual?(obsAtual+" | "+texto):texto;
    // PUT mínimo com nova obs
    await bling(`/pedidos/vendas/${id}`,{method:"PUT",body:JSON.stringify({
      nome:ped.contato?.nome||"",
      contato:{id:ped.contato?.id},
      data:ped.data,
      itens:(ped.itens||[]).map(i=>({produto:{id:i.produto?.id},quantidade:i.quantidade,valor:i.valor})),
      observacoes:novaObs,
    })});
    addLog(id,"observacao_salva",funcionarioId,funcionarioNome,{texto:texto.slice(0,100)});
    res.json({ok:true});
  }catch(e){ res.status(e.status||500).json({erro:e.message}); }
});

// Registrar estorno de pagamento
app.post("/api/pagamentos/:id/estorno", async(req,res)=>{
  try{
    const id=String(req.params.id);
    const {valor,formaId,formaNome,contaNome,funcionarioId,funcionarioNome,soRegistrarLog}=req.body||{};
    const pags=lerPag();
    if(!pags[id]) return res.status(404).json({erro:"Pagamento não encontrado"});
    const p=pags[id];
    if(!p.historico) p.historico=[];
    // soRegistrarLog: só deixa marcado no histórico que houve um estorno (pra
    // auditoria/observação) — o valor final de fato é declarado por uma
    // chamada separada com as parcelas corretas (substituir), evitando
    // cálculo automático de "forma original" que pode errar
    if(soRegistrarLog){
      p.historico.push({tipo:"estorno",valor:0,formaNome,contaNome,funcionarioId,funcionarioNome,em:Date.now(),soRegistrarLog:true});
      salvarPag(pags);
      addLog(id,"estorno_registrado",funcionarioId,funcionarioNome,{formaNome,contaNome});
      return res.json({ok:true,data:p});
    }
    p.valorPago=+Math.max(0,+(p.valorPago||0)-+valor).toFixed(2);
    p.historico.push({tipo:"estorno",valor:-+valor,formaNome,contaNome,funcionarioId,funcionarioNome,em:Date.now()});
    // busca o total ATUAL do pedido no Bling — não confia no valorPedido salvo
    // localmente, que pode estar desatualizado (ex: frete removido, itens
    // ajustados na resolução de pendências depois do pagamento original)
    try{
      const ped=await bling(`/pedidos/vendas/${id}`); const totalAtual=ped?.data?.total||ped?.data?.totalProdutos||0;
      p.valorPedido=+Number(totalAtual).toFixed(2);
    }catch(e){}
    p.statusPagamento=p.valorPago>=p.valorPedido-0.01?"pago":p.valorPago>0?"parcial":"pendente";
    salvarPag(pags);
    addLog(id,"estorno_registrado",funcionarioId,funcionarioNome,{valor,formaNome,contaNome});
    // atualiza as parcelas no Bling refletindo o valor restante (após o
    // estorno), usando a forma original do pagamento — não a forma da
    // devolução, que é só o canal usado pra devolver o dinheiro ao cliente
    let blingResultado=null;
    if(p.valorPago>0.01){
      const original=(p.historico||[]).find(h=>h.tipo!=="estorno"&&h.tipo!=="resetado"&&h.formaId);
      if(original){
        blingResultado=await atualizarParcelasBling(id,[{valor:p.valorPago,formaId:original.formaId}]);
      }
    }
    res.json({ok:true,data:p,_blingFinanceiro:blingResultado});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// Importar NF-e por chave de acesso via Bling → SEFAZ
app.post("/api/nfe/importar", async (req, res) => {
  try {
    const { chave } = req.body || {};
    if (!chave || chave.replace(/\D/g,"").length !== 44)
      return res.status(400).json({ erro: "Chave de acesso inválida (precisa ter 44 dígitos)" });
    const ch = chave.replace(/\D/g,"");
    try { await bling(`/nfe/manifestacaodestinatario`, { method:"POST", body:JSON.stringify({ chaveAcesso:ch, tipoManifestacao:"210210" }) }); } catch(e) {}
    const r = await bling(`/nfe/importarXmlSefaz`, { method:"POST", body:JSON.stringify({ chaveAcesso:ch }) });
    res.json({ ok:true, nota:r?.data||r });
  } catch(e) { res.status(e.status||500).json({ erro:e.message, body:e.body }); }
});
app.get("/api/nfe/buscar/:chave", async (req, res) => {
  try { res.json(await bling(`/notasfiscaisentrada?chaveAcesso=${req.params.chave.replace(/\D/g,"")}`)); }
  catch(e) { res.status(e.status||500).json({ erro:e.message, body:e.body }); }
});
app.get("/",(req,res)=> res.redirect("/pedir-online"));
// Reconstrói o índice de produtos (nome/código/preço) em segundo plano, sem travar
// nada. Roda ao subir o servidor e depois a cada 30 min — assim produtos novos
// entram na busca automaticamente, sem precisar reconstruir manualmente em /preco.
let _indiceReconstruindo=false, _indiceProgresso="";
async function reconstruirIndiceProdutosBg(){
  if(_indiceReconstruindo) return; // evita rodar dois ao mesmo tempo
  _indiceReconstruindo=true;
  try{
    // 1) lista todos os produtos (a listagem é enxuta: traz id/nome/codigo, mas
    //    NÃO traz o gtin nem o preço real — por isso precisamos do detalhe depois)
    const lista=[];
    for(let pg=1;pg<=100;pg++){
      const r=await blingLento(`/produtos?pagina=${pg}&limite=100`);
      const arr=r?.data||[]; lista.push(...arr);
      if(arr.length<100) break;
      await sleep(400);
    }
    // parte do índice já existente, pra não perder o que já foi indexado se cair no meio
    const indice=lerJSON(GTIN_INDEX_FILE,{});
    let comGtin=0;
    // 2) pra cada produto, lê o DETALHE (que traz gtin + preço real) e indexa por
    //    GTIN (código de barras) E por código (SKU). Roda em segundo plano.
    for(let i=0;i<lista.length;i++){
      const p=lista[i];
      let det=p;
      try{ const d=await blingLento(`/produtos/${p.id}`); if(d?.data) det=d.data; }catch(e){}
      const item={
        produtoId:det.id, nome:det.nome, preco:+(det.preco||0),
        imagem:det.imagemURL||det.imagem?.link?.grande||det.midia?.imagens?.internas?.[0]?.link||null,
        codigo:det.codigo||"", gtin:det.gtin||det.codigoBarras||"",
      };
      const codigos=[det.gtin, det.codigoBarras, det.codigo].filter(Boolean).map(String);
      if(det.gtin||det.codigoBarras) comGtin++;
      if(codigos.length) codigos.forEach(c=>{ indice[c]=item; });
      else indice["id_"+det.id]=item;
      _indiceProgresso=`Indexando produtos: ${i+1}/${lista.length} (${comGtin} com código de barras)`;
      // salva parcial a cada 40 produtos (pra já ir valendo e não perder progresso)
      if(i%40===39) salvarJSON(GTIN_INDEX_FILE,indice);
      await sleep(360); // respeita o limite do Bling (~2,9 req/s)
    }
    salvarJSON(GTIN_INDEX_FILE,indice);
    _indiceProgresso=`Índice pronto: ${lista.length} produtos, ${comGtin} com código de barras`;
    console.log(`[indice] ${_indiceProgresso}`);
  }catch(e){ console.log("[indice] falha:",e.message); }
  finally{ _indiceReconstruindo=false; }
}
// endpoint pra ver o progresso e forçar a reconstrução do índice
app.get("/api/indice-produtos/status",(req,res)=>{
  const indice=lerJSON(GTIN_INDEX_FILE,{});
  const comGtin=Object.values(indice).filter((v,i,arr)=>arr.findIndex(x=>x.produtoId===v.produtoId)===i && v.gtin).length;
  res.json({reconstruindo:_indiceReconstruindo, progresso:_indiceProgresso, totalChaves:Object.keys(indice).length, produtosComGtin:comGtin});
});
app.post("/api/indice-produtos/reconstruir",(req,res)=>{
  if(_indiceReconstruindo) return res.json({ok:true,ja:true,progresso:_indiceProgresso});
  reconstruirIndiceProdutosBg();
  res.json({ok:true,iniciado:true});
});
setTimeout(reconstruirIndiceProdutosBg, 15000);            // 15s depois de subir
setInterval(reconstruirIndiceProdutosBg, 6*60*60*1000);    // e a cada 6h (é pesado, lê detalhe de todos)

// ===== VENDA ATACADO — propostas e pedidos =====
// A "proposta comercial" fica só no nosso sistema (o Bling v3 não expõe propostas
// via API). Quando o cliente aprova, um botão gera o pedido de venda no Bling.

// retorna o vendedor Bling vinculado a um funcionário (pra pré-preencher na venda atacado)
app.get("/api/atacado/vendedor/:funcId",(req,res)=>{
  const funcs=lerJSON(FUNC_FILE,{});
  const func=funcs[req.params.funcId];
  const vendedorId=func?.vendedorBlingId?Number(func.vendedorBlingId):(Number(process.env.BLING_VENDEDOR_ID)||null);
  res.json({vendedorId,vendedorNome:func?.nome||""});
});

function lerPropostas(){ return lerJSON(PROPOSTAS_FILE,{}); }
function salvarPropostas(p){ salvarJSON(PROPOSTAS_FILE,p); }

// salva/atualiza só o telefone do cliente no Bling (usado antes de enviar WhatsApp)
app.post("/api/atacado/cliente/:id/telefone",async(req,res)=>{
  try{
    const tel=req.body?.telefone||"";
    if(soDigitos(tel).length<10) return res.status(400).json({erro:"telefone inválido"});
    // busca o contato atual pra não sobrescrever outros dados
    const atual=await bling(`/contatos/${req.params.id}`).then(r=>r?.data).catch(()=>null);
    if(!atual) return res.status(404).json({erro:"contato não encontrado"});
    const corpo={
      nome:atual.nome, tipo:atual.tipo, numeroDocumento:atual.numeroDocumento,
      telefone:formatarTelefoneBling(tel), celular:formatarTelefoneBling(tel),
    };
    await bling(`/contatos/${req.params.id}`,{method:"PUT",body:JSON.stringify(corpo)});
    res.json({ok:true,telefone:tel});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// produtos novos — os de maior ID (produtos recém-cadastrados têm ID sequencial
// mais alto). Retorna os N últimos (padrão 5). Marca quais já estão na Tabela Atacado.
app.get("/api/atacado/produtos-novos",async(req,res)=>{
  try{
    const qtd=Number(req.query.qtd||5);
    // O índice local já tem todos os produtos; pega os de maior ID a partir dele
    // (rápido e confiável — ID sequencial, o mais alto é o mais novo).
    const indice=lerJSON(GTIN_INDEX_FILE,{});
    let todos=Object.values(indice).filter(p=>p.produtoId);
    // dedup por produtoId (o índice tem uma entrada por código/gtin)
    const porId={};
    todos.forEach(p=>{ porId[p.produtoId]=p; });
    let lista=Object.values(porId).sort((a,b)=>(Number(b.produtoId)||0)-(Number(a.produtoId)||0));
    let topN=lista.slice(0,qtd).map(p=>({id:p.produtoId,nome:p.nome,codigo:p.codigo,preco:+(p.preco||0),imagem:p.imagem||""}));

    // fallback: se o índice estiver vazio, busca direto no Bling
    if(!topN.length){
      let arr=[];
      try{ const r=await bling(`/produtos?pagina=1&limite=100&criterio=5`); arr=r?.data||[]; }catch(e){}
      arr.sort((a,b)=>(Number(b.id)||0)-(Number(a.id)||0));
      topN=arr.slice(0,qtd).map(p=>({id:p.id,nome:p.nome,codigo:p.codigo,preco:+(p.preco||0),imagem:p.imagemURL||""}));
    }

    const tab=lerTabela(); const codsTabela=new Set(); const precoAtacadoPorCodigo={};
    (tab?.model||[]).forEach(c=>(c.itens||[]).forEach(it=>(it.bling||[]).forEach(b=>{
      codsTabela.add(String(b.codigo));
      if(it.preco>0) precoAtacadoPorCodigo[String(b.codigo)]=it.preco; // preço de atacado, não o do Bling
    })));

    const novos=[];
    for(const p of topN){
      let imagem=p.imagem||"";
      if(!imagem){
        try{ const d=await bling(`/produtos/${p.id}`); imagem=d?.data?.imagemURL||""; await new Promise(r=>setTimeout(r,120)); }catch(e){}
      }
      const naTabela=codsTabela.has(String(p.codigo));
      // usa o preço de ATACADO por padrão quando o produto já tem um cadastrado
      // na tabela — antes sempre mostrava o preço do Bling, mesmo já tendo
      // preço de atacado definido, e só corrigia depois de selecionar
      const precoFinal=naTabela&&precoAtacadoPorCodigo[String(p.codigo)]!=null?precoAtacadoPorCodigo[String(p.codigo)]:+(p.preco||0);
      novos.push({id:p.id,nome:p.nome,codigo:p.codigo,preco:precoFinal,imagem,naTabelaAtacado:naTabela});
    }
    res.json({data:novos});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// análise do histórico de compras do cliente (Fase 2): última compra, total gasto,
// gasto por mês, média por pedido, e produtos que ele mais compra
app.get("/api/atacado/cliente/:id/analise",async(req,res)=>{
  try{
    const contatoId=req.params.id;
    // busca até 200 pedidos desse contato (dá conta da grande maioria dos clientes)
    const pedidos=[];
    for(let pg=1;pg<=4;pg++){
      const p=new URLSearchParams({pagina:pg,limite:100,idContato:contatoId});
      let arr=[];
      try{ const r=await bling(`/pedidos/vendas?${p.toString()}`); arr=r?.data||[]; }catch(e){ break; }
      pedidos.push(...arr);
      if(arr.length<100) break;
      await new Promise(r=>setTimeout(r,300));
    }
    // ignora cancelados (situação 12)
    const validos=pedidos.filter(p=>p.situacao?.id!==12);
    const totalGasto=+validos.reduce((s,p)=>s+Number(p.total||0),0).toFixed(2);
    const qtdPedidos=validos.length;
    const media=qtdPedidos?+(totalGasto/qtdPedidos).toFixed(2):0;
    // última compra
    const datas=validos.map(p=>p.data).filter(Boolean).sort();
    const ultimaCompra=datas.length?datas[datas.length-1]:null;
    // gasto por mês (últimos 6 meses com movimento)
    const porMes={};
    validos.forEach(p=>{ if(p.data){ const m=p.data.slice(0,7); porMes[m]=+((porMes[m]||0)+Number(p.total||0)).toFixed(2); } });
    const meses=Object.entries(porMes).sort((a,b)=>a[0].localeCompare(b[0])).slice(-6).map(([mes,valor])=>({mes,valor}));

    // produtos mais comprados — precisa do detalhe de cada pedido (tem os itens).
    // busca o detalhe dos até 30 pedidos mais recentes pra não pesar demais.
    const recentes=[...validos].sort((a,b)=>String(b.data).localeCompare(String(a.data))).slice(0,30);
    const prodCount={};
    let pedidosAnalisados=0;
    for(const ped of recentes){
      try{
        const d=await bling(`/pedidos/vendas/${ped.id}`); const itens=d?.data?.itens||[];
        pedidosAnalisados++;
        // conta 1 aparição por pedido pra cada produto (não repete se aparecer 2x no mesmo pedido)
        const vistosNestePedido=new Set();
        itens.forEach(it=>{
          const pid=it.produto?.id; if(!pid) return;
          if(!prodCount[pid]) prodCount[pid]={produtoId:pid,nome:it.descricao||it.produto?.nome||"",vezes:0,qtdTotal:0,emPedidos:0};
          prodCount[pid].qtdTotal+=Number(it.quantidade||0);
          if(!vistosNestePedido.has(String(pid))){ prodCount[pid].emPedidos++; vistosNestePedido.add(String(pid)); }
          prodCount[pid].vezes++;
        });
      }catch(e){}
      await new Promise(r=>setTimeout(r,120));
    }
    let maisComprados=Object.values(prodCount).sort((a,b)=>b.emPedidos-a.emPedidos||b.qtdTotal-a.qtdTotal).slice(0,10);
    // enriquece com preço de atacado (tabela), múltiplo e imagem — pra já mostrar o
    // preço certo antes de adicionar
    const tab=lerTabela();
    const infoPorCod={}; const infoPorProdId={};
    (tab?.model||[]).forEach(c=>(c.itens||[]).forEach(it=>(it.bling||[]).forEach(b=>{
      const info={precoAtacado:it.preco,multiplo:it.caixa||1,categoria:c.t||""};
      infoPorCod[String(b.codigo)]=info; if(b.id) infoPorProdId[String(b.id)]=info;
    })));
    const indiceProd=lerJSON(GTIN_INDEX_FILE,{});
    const idxPorProdId={}; Object.values(indiceProd).forEach(p=>{ if(p.produtoId) idxPorProdId[String(p.produtoId)]=p; });
    maisComprados=maisComprados.map(m=>{
      const idx=idxPorProdId[String(m.produtoId)];
      const info=infoPorProdId[String(m.produtoId)]||(idx?infoPorCod[String(idx.codigo)]:null);
      const precoBling=idx?+(idx.preco||0):0;
      return {
        ...m,
        imagem:idx?.imagem||"",
        codigo:idx?.codigo||"",
        precoAtacado:info?info.precoAtacado:null,
        multiplo:info?info.multiplo:1,
        preco:info?info.precoAtacado:precoBling,
        origemPreco:info?"atacado":"bling",
      };
    });

    res.json({
      qtdPedidos, totalGasto, media, ultimaCompra,
      gastoPorMes:meses, maisComprados, pedidosAnalisados,
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// cria ou atualiza um cliente no Bling (usado pela tela de venda atacado)
app.post("/api/atacado/cliente",async(req,res)=>{
  try{
    const b=req.body||{};
    const doc=soDigitos(b.documento);
    if(!doc||(doc.length!==11&&doc.length!==14)) return res.status(400).json({erro:"informe um CPF (11) ou CNPJ (14) válido"});
    const tipo=doc.length===14?"J":"F";
    const end=b.endereco||{};
    const corpo={
      nome:b.nome||("Cliente "+doc),
      tipo, numeroDocumento:doc, situacao:"A",
      telefone:formatarTelefoneBling(b.telefone), celular:formatarTelefoneBling(b.celular||b.telefone),
      email:(b.email&&/\S+@\S+\.\S+/.test(b.email))?b.email:undefined,
      endereco:{ geral:{
        endereco:end.rua||"", numero:end.numero||"S/N", complemento:end.complemento||"",
        bairro:end.bairro||"", cep:soDigitos(end.cep||""), municipio:end.cidade||"",
        uf:end.uf||"MG", pais:"Brasil",
      } },
    };
    let contatoId=b.id||null, criou=false;
    if(contatoId){
      await bling(`/contatos/${contatoId}`,{method:"PUT",body:JSON.stringify(corpo)});
    }else{
      const novo=await bling(`/contatos`,{method:"POST",body:JSON.stringify(corpo)});
      contatoId=novo?.data?.id; criou=true;
    }
    res.json({ok:true,id:contatoId,criou,nome:corpo.nome,documento:doc,telefone:b.telefone||b.celular||""});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});


// lista propostas/pedidos-atacado (mais recentes primeiro), com filtro opcional por tipo/status
app.get("/api/atacado/propostas",(req,res)=>{
  const {tipo,status}=req.query;
  let lista=Object.values(lerPropostas());
  // "Pedidos" = qualquer um que já virou pedido no Bling (tem pedidoBlingId),
  // independente de ter nascido como proposta ou como pedido direto.
  // "Propostas" = os que ainda NÃO viraram pedido. Assim, quando uma proposta
  // é convertida em pedido, ela sai da aba Propostas e passa pra aba Pedidos.
  if(tipo==="pedido") lista=lista.filter(p=>!!p.pedidoBlingId);
  else if(tipo==="proposta") lista=lista.filter(p=>!p.pedidoBlingId);
  if(status) lista=lista.filter(p=>p.status===status);
  lista.sort((a,b)=>(b.criadoEm||0)-(a.criadoEm||0));
  res.json({data:lista});
});

app.get("/api/atacado/propostas/:id",(req,res)=>{
  const p=lerPropostas()[req.params.id];
  if(!p) return res.status(404).json({erro:"não encontrada"});
  res.json({data:p});
});

// SINCRONIZA os PEDIDOS com o Bling: pra cada item que já virou pedido (tem
// pedidoBlingId), verifica se o pedido ainda existe no Bling. Se foi excluído lá
// (404), remove do nosso sistema — o pedido é um espelho do Bling, então não faz
// sentido manter fantasma. As PROPOSTAS (sem pedidoBlingId) vivem só no nosso
// sistema e NÃO são tocadas. Retorna quantos foram removidos.
app.post("/api/atacado/propostas/sincronizar-pedidos",async(req,res)=>{
  try{
    const props=lerPropostas();
    // só os que são pedidos de verdade (espelho do Bling)
    const pedidos=Object.values(props).filter(p=>p.pedidoBlingId);
    const removidos=[];
    for(const p of pedidos){
      let existe=true;
      try{
        const r=await bling(`/pedidos/vendas/${p.pedidoBlingId}`);
        // se voltou com dados, existe. Se o Bling não achou, cai no catch.
        existe=!!(r&&r.data);
      }catch(e){
        // 404 = pedido não existe mais no Bling → marca pra remover.
        // Outros erros (rede, 429, 5xx) NÃO removem — só o 404 é conclusivo,
        // pra não apagar pedido bom por causa de instabilidade.
        const msg=String(e.message||"");
        const body=e.body?JSON.stringify(e.body):"";
        const ehNaoEncontrado = e.status===404 || /404|not.?found|não encontrad|resource_not_found/i.test(msg+body);
        if(ehNaoEncontrado) existe=false;
        else existe=true; // erro incerto → mantém o pedido
      }
      if(!existe){
        removidos.push({id:p.id, pedidoBlingNumero:p.pedidoBlingNumero, cliente:p.clienteNome||p.cliente?.nome||""});
        delete props[p.id];
      }
      await new Promise(r=>setTimeout(r,150)); // respeita o limite do Bling
    }
    if(removidos.length) salvarPropostas(props);

    // AGORA também PUXA os pedidos em "Aguardando Separação" do Bling que ainda não
    // estão na lista (status criado só pelo nosso sistema: totem, site e atacado).
    const jaTem=new Set(Object.values(props).filter(p=>p.pedidoBlingId).map(p=>String(p.pedidoBlingId)));
    let adicionados=[];
    try{
      let pedidosBling=[], pagina=1;
      for(let i=0;i<5;i++){ // até 500
        const pp=new URLSearchParams({pagina:String(pagina), limite:"100"});
        pp.append("idsSituacoes[]", String(SIT.AGUARDANDO));
        const r=await bling(`/pedidos/vendas?${pp.toString()}`);
        const arr=r?.data||[];
        pedidosBling=pedidosBling.concat(arr);
        if(arr.length<100) break;
        pagina++; await new Promise(r=>setTimeout(r,150));
      }
      const novos=pedidosBling.filter(pd=>!jaTem.has(String(pd.id)));
      let contDet=0;
      for(const pd of novos){
        let itensReg=[], total=pd.total||0, freteReg=0;
        if(contDet<80){ // busca o detalhe (produtos/frete) só pros novos, com teto pra não estourar o tempo
          try{
            const d=await bling(`/pedidos/vendas/${pd.id}`).then(r=>r?.data);
            itensReg=(d?.itens||[]).map(it=>({produtoId:it.produto?.id||null, nome:it.descricao||it.produto?.nome||"produto", quantidade:it.quantidade, valor:it.valor}));
            freteReg=Number(d?.transporte?.frete)||0;
            total=d?.total||total;
            contDet++; await new Promise(r=>setTimeout(r,120));
          }catch(e){}
        }
        const idReg="ped-"+String(pd.id);
        props[idReg]={
          id:idReg, origem:"bling", tipo:"pedido",
          cliente:{ id:pd.contato?.id||null, nome:pd.contato?.nome||"—" },
          itens:itensReg,
          total:+Number(total).toFixed(2),
          vendedorNome: pd.vendedor?.nome||"",
          entrega:{ tipo: freteReg>0?"entrega":"retirada", taxa:freteReg },
          observacao:"", status:"pedido_gerado",
          pedidoBlingId:pd.id, pedidoBlingNumero:pd.numero||pd.id,
          criadoEm: pd.data? new Date(pd.data+"T12:00:00").getTime() : Date.now(),
          atualizadoEm:Date.now(),
        };
        adicionados.push({numero:pd.numero, cliente:pd.contato?.nome||""});
      }
      if(adicionados.length) salvarPropostas(props);
    }catch(e){ console.error("sincronizar: falha ao puxar aguardando separação (ignorado):",e.message); }

    res.json({ok:true, verificados:pedidos.length, removidos:removidos.length, detalhes:removidos, adicionados:adicionados.length, detalhesAdicionados:adicionados});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// cria ou atualiza uma proposta/rascunho de pedido no nosso sistema
app.post("/api/atacado/propostas",(req,res)=>{
  try{
    const b=req.body||{};
    const props=lerPropostas();
    const id=b.id||("prop_"+Date.now()+"_"+Math.random().toString(36).slice(2,7));
    const agora=Date.now();
    const totalItens=+(b.itens||[]).reduce((s,i)=>s+Number(i.valor||0)*Number(i.quantidade||0),0).toFixed(2);
    const entrega=b.entrega&&b.entrega.tipo==="entrega"
      ? {tipo:"entrega",endereco:b.entrega.endereco||"",km:b.entrega.km||0,taxa:Number(b.entrega.taxa)||0,
         dataDesejada:b.entrega.dataDesejada||null, turno:(["manha","tarde","qualquer"].includes(b.entrega.turno)?b.entrega.turno:"qualquer"),
         obsEntrega:String(b.entrega.obsEntrega||"").slice(0,300)}
      : {tipo:"retirada"};
    const registro={
      id,
      tipo:b.tipo||"proposta",           // "proposta" | "pedido"
      status:b.status||"aberta",         // aberta | aprovada | pedido_gerado | cancelada
      cliente:b.cliente||null,           // {id,nome,documento,telefone,...}
      itens:b.itens||[],                 // [{produtoId,nome,quantidade,valor,imagem}]
      observacao:b.observacao||"",
      vendedorId:b.vendedorId||null, vendedorNome:b.vendedorNome||"",
      funcionarioId:b.funcionarioId||null, funcionarioNome:b.funcionarioNome||"",
      entrega,
      totalItens,
      total:+(totalItens+(entrega.tipo==="entrega"?entrega.taxa:0)).toFixed(2),
      pedidoBlingId:b.pedidoBlingId||(props[id]?.pedidoBlingId)||null,
      pedidoBlingNumero:b.pedidoBlingNumero||(props[id]?.pedidoBlingNumero)||null,
      criadoEm:props[id]?.criadoEm||agora,
      atualizadoEm:agora,
    };
    props[id]=registro;
    salvarPropostas(props);
    res.json({ok:true,data:registro});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.delete("/api/atacado/propostas/:id",(req,res)=>{
  const props=lerPropostas();
  const p=props[req.params.id];
  if(!p){ return res.json({ok:true}); }
  // se já gerou pedido no Bling, NÃO pode excluir — só cancelar
  if(p.pedidoBlingId){
    return res.status(400).json({erro:"Este já virou o pedido #"+p.pedidoBlingNumero+" e não pode ser excluído. Use 'Cancelar' para movê-lo pro status cancelado."});
  }
  delete props[req.params.id]; salvarPropostas(props);
  res.json({ok:true});
});

// verifica a situação ATUAL do pedido no Bling. Retorna {ok, situacaoId, situacaoNome}
// ou {ok:false, erro} se não conseguir consultar (nesse caso é mais seguro NÃO
// deixar cancelar, pra não agir sem saber o estado real).
async function situacaoAtualBling(pedidoBlingId){
  try{
    const r=await bling(`/pedidos/vendas/${pedidoBlingId}`);
    const sit=Number(r?.data?.situacao?.id||0);
    return {ok:true, situacaoId:sit};
  }catch(e){
    return {ok:false, erro:e.message||"erro ao consultar o Bling"};
  }
}

// nome amigável de uma situação, pelos ids que o nosso fluxo usa
function nomeSituacao(id){
  const n=Number(id);
  const mapa={
    [SIT.EM_ABERTO]:"Em aberto",
    [SIT.EM_DIGITACAO]:"Em digitação",
    [SIT.AGUARDANDO]:"Aguardando separação",
    [SIT.EM_SEP]:"Em separação",
    [SIT.SEP_PEND]:"Separação pendente",
    [SIT.SEPARADO]:"Separado",
    [SIT.CONF_ENTREGA]:"Conferência de entrega",
    [SIT.VERIFICADO]:"Verificado",
    [SIT.EM_ROTA]:"Em rota",
    [SIT.ATENDIDO]:"Atendido",
    [Number(process.env.SIT_CANCELADO||12)]:"Cancelado",
  };
  return mapa[n]||("Situação "+n);
}

// situação atual (id + nome) de um pedido do Bling — usado na aba Pedidos pra mostrar o status
app.get("/api/atacado/pedido/:blingId/situacao",async(req,res)=>{
  try{
    const a=await situacaoAtualBling(req.params.blingId);
    if(!a.ok) return res.status(502).json({erro:a.erro});
    res.json({situacaoId:a.situacaoId, situacaoNome:nomeSituacao(a.situacaoId)});
  }catch(e){ res.status(e.status||500).json({erro:e.message}); }
});

// diz se o pedido já foi pago (pra Propostas decidir se precisa de autorização pra editar)
app.get("/api/atacado/pedido/:blingId/status-pagamento",(req,res)=>{
  const pags=lerPag();
  const p=pags[String(req.params.blingId)];
  const status=p?.statusPagamento||"pendente";
  res.json({ pago: status==="pago"||status==="parcial", statusPagamento:status, valorPago:p?.valorPago||0 });
});

// autoriza (por QR) a edição de um pedido JÁ PAGO em Propostas — mesmo QR/grupos do
// caixa atacado (admin, gerente, financeiro, financeiro_atacado)
app.post("/api/atacado/pedido/:blingId/autorizar-edicao",(req,res)=>{
  const auth=validarTokenQrAtacado(req.body?.token);
  if(auth.erro) return res.status(403).json({erro:auth.erro});
  addLog(String(req.params.blingId),"edicao_pedido_pago_autorizada",null,auth.funcionario.nome,{});
  res.json({ok:true, autorizadoPor:auth.funcionario.nome});
});

// cancela a proposta/pedido. REGRAS:
// 1) Só dá pra cancelar enquanto o pedido ainda está no status inicial
//    "AGUARDANDO SEPARAÇÃO (SISTEMA)". Se já entrou no fluxo (em separação,
//    separado, em rota, entregue etc.), NÃO deixa mais cancelar por aqui.
// 2) Ação atômica: se tem pedido no Bling, o cancelamento só vale se conseguir
//    cancelar NOS DOIS. Se o Bling recusar/falhar, não muda nada aqui.
app.post("/api/atacado/propostas/:id/cancelar",async(req,res)=>{
  try{
    const props=lerPropostas();
    const p=props[req.params.id];
    if(!p) return res.status(404).json({erro:"não encontrada"});
    if(p.status==="cancelada") return res.json({ok:true, jaEstava:true});
    // se tem pedido gerado no Bling, confere a situação atual ANTES de qualquer coisa
    if(p.pedidoBlingId){
      const atual=await situacaoAtualBling(p.pedidoBlingId);
      if(!atual.ok){
        return res.status(502).json({erro:"Não foi possível consultar a situação do pedido no Bling ("+atual.erro+"). Por segurança, nada foi alterado — tente de novo."});
      }
      // só permite cancelar se ainda estiver no status inicial (aguardando separação)
      if(atual.situacaoId!==SIT.AGUARDANDO){
        return res.status(400).json({erro:"Este pedido já saiu de 'Aguardando separação' e entrou no fluxo (separação/rota/entrega). Não é mais possível cancelá-lo por aqui — ajuste direto no Bling se precisar."});
      }
      // está no status inicial: cancela no Bling PRIMEIRO. Só marca aqui se confirmar.
      const SIT_CANCELADO=Number(process.env.SIT_CANCELADO||12);
      try{
        await bling(`/pedidos/vendas/${p.pedidoBlingId}/situacoes/${SIT_CANCELADO}`,{method:"PATCH"});
      }catch(e){
        console.error("[atacado] falha ao cancelar pedido no Bling:",p.pedidoBlingId,e.message);
        return res.status(502).json({erro:"Não foi possível cancelar o pedido no Bling: "+(e.message||"erro de conexão")+". Nada foi alterado — tente de novo. (O pedido continua ativo nos dois lados.)"});
      }
    }
    // chegou aqui = ou não tinha pedido no Bling, ou o Bling confirmou o cancelamento
    p.status="cancelada"; p.atualizadoEm=Date.now();
    props[p.id]=p; salvarPropostas(props);
    // tira o pedido de qualquer rota onde estava agendado (não deixa fantasma
    // ocupando lugar/peso/capacidade no gerenciamento de rota)
    let tiradoDaRota=null;
    if(p.pedidoBlingId){ const r=removerPedidoDeTodasRotas(p.pedidoBlingId); if(r.removido) tiradoDaRota=r.ondeEstava; }
    res.json({ok:true, tiradoDaRota});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// gera o pedido de venda no Bling a partir de uma proposta e marca situação "aguardando separação"
// número confirmado do pedido (usado pela Venda Atacado pra esperar o número real
// antes de imprimir, quando o Bling não devolveu na criação)
app.get("/api/atacado/pedido/:blingId/numero",async(req,res)=>{
  try{
    const d=await bling(`/pedidos/vendas/${req.params.blingId}`).then(r=>r?.data);
    res.json({numero:d?.numero||null});
  }catch(e){ res.json({numero:null}); }
});

// EDITAR os itens de uma PROPOSTA (ainda não virou pedido no Bling — é registro local)
app.post("/api/atacado/propostas/:id/editar-itens",(req,res)=>{
  try{
    const props=lerPropostas();
    const prop=props[req.params.id];
    if(!prop) return res.status(404).json({erro:"proposta não encontrada"});
    if(prop.pedidoBlingId) return res.status(400).json({erro:"esta proposta já virou o pedido #"+(prop.pedidoBlingNumero||prop.pedidoBlingId)+" — edite pelo pedido"});
    const {itens,funcionarioNome}=req.body||{};
    if(!Array.isArray(itens)||!itens.length) return res.status(400).json({erro:"a proposta precisa ter ao menos 1 item"});
    for(const i of itens){
      if(!i.produtoId) return res.status(400).json({erro:"todos os itens precisam de produto"});
      if(!(Number(i.quantidade)>0)) return res.status(400).json({erro:"quantidade inválida em algum item"});
    }
    const antes=(prop.itens||[]).map(i=>`${Number(i.quantidade)}x ${i.nome||i.produtoId}`).join(", ");
    prop.itens=itens.map(i=>({produtoId:i.produtoId, nome:i.nome||"", quantidade:Number(i.quantidade), valor:Number(i.valor)}));
    const totalItens=prop.itens.reduce((s,i)=>s+i.quantidade*i.valor,0);
    prop.total=+(totalItens+(prop.entrega?.tipo==="entrega"?Number(prop.entrega.taxa||0):0)).toFixed(2);
    prop.atualizadoEm=Date.now();
    const depois=prop.itens.map(i=>`${i.quantidade}x ${i.nome||i.produtoId}`).join(", ");
    prop.historicoEdicoes=[...(prop.historicoEdicoes||[]),{em:Date.now(),por:funcionarioNome||"—",de:antes,para:depois}];
    props[prop.id]=prop; salvarPropostas(props);
    res.json({ok:true, total:prop.total, itens:prop.itens});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.post("/api/atacado/propostas/:id/gerar-pedido",async(req,res)=>{
  try{
    const props=lerPropostas();
    const prop=props[req.params.id];
    if(!prop) return res.status(404).json({erro:"proposta não encontrada"});
    if(prop.pedidoBlingId) return res.status(400).json({erro:"esta proposta já virou o pedido #"+prop.pedidoBlingNumero});
    // trava contra clique duplicado / requisição repetida: sem isso, 2 chamadas
    // quase simultâneas passavam as duas pela checagem acima (nenhuma tinha
    // pedidoBlingId ainda, porque a 1ª ainda não tinha terminado de criar no
    // Bling) e cada uma criava o SEU próprio pedido — duplicando no Bling.
    // Trava ANTES de qualquer await, e expira sozinha em 1 min (se travou por
    // erro/timeout, não fica bloqueado pra sempre).
    if(prop.gerandoPedidoEm && (Date.now()-prop.gerandoPedidoEm)<60000){
      return res.status(409).json({erro:"Esse pedido já está sendo gerado agora (evitando duplicar) — aguarde alguns segundos e confira em Propostas antes de tentar de novo."});
    }
    prop.gerandoPedidoEm=Date.now();
    props[req.params.id]=prop;
    salvarPropostas(props);
    const liberarTrava=()=>{ try{ const pp=lerPropostas(); if(pp[req.params.id]){ pp[req.params.id].gerandoPedidoEm=null; salvarPropostas(pp); } }catch(e){} };
    if(!prop.cliente?.id){ liberarTrava(); return res.status(400).json({erro:"a proposta precisa de um cliente cadastrado no Bling pra gerar o pedido"}); }
    if(!prop.itens?.length){ liberarTrava(); return res.status(400).json({erro:"a proposta não tem itens"}); }

    // valida o estoque ao vivo de cada item antes de tentar criar (evita o erro genérico
    // do Bling e diz exatamente qual produto está sem saldo)
    const semEstoque=[];
    for(const it of prop.itens){
      try{
        const r=await bling(`/produtos/${it.produtoId}`);
        const saldo=r?.data?.estoque?.saldoVirtualTotal ?? r?.data?.estoque?.saldoFisicoTotal ?? null;
        if(saldo!=null && Number(it.quantidade)>Number(saldo)){
          semEstoque.push(`${it.nome} (pediu ${it.quantidade}, tem ${saldo})`);
        }
      }catch(e){}
      await new Promise(r=>setTimeout(r,120));
    }
    if(semEstoque.length){
      liberarTrava();
      return res.status(400).json({erro:"Estoque insuficiente: "+semEstoque.join("; ")+". Ajuste as quantidades."});
    }

    const dataHojeBR=new Date(Date.now()-3*60*60*1000).toISOString().slice(0,10);
    const totalItensPed=+prop.itens.reduce((s,i)=>s+Number(i.valor||0)*Number(i.quantidade||0),0).toFixed(2);
    const entregaProp=prop.entrega&&prop.entrega.tipo==="entrega"?prop.entrega:{tipo:"retirada"};
    const freteProp=entregaProp.tipo==="entrega"?Number(entregaProp.taxa)||0:0;
    const totalPed=+(totalItensPed+freteProp).toFixed(2);
    // o Bling exige uma parcela pra validar a venda — usa "Ficha Financeira" como
    // marcador de "ainda não pago" (mesma regra do totem)
    const formaFicha=await getFormaPagamentoIdPorNome("ficha financeira");
    const payload={
      data:dataHojeBR,
      contato:{id:Number(prop.cliente.id)},
      itens:prop.itens.map(i=>({produto:{id:Number(i.produtoId)},quantidade:Number(i.quantidade),valor:Number(i.valor)})),
      ...(prop.vendedorId?{vendedor:{id:Number(prop.vendedorId)}}:{}),
      ...(prop.observacao?{observacoes:prop.observacao}:{}),
    };
    if(formaFicha){
      payload.parcelas=[{formaPagamento:{id:formaFicha},dataVencimento:dataHojeBR,valor:totalPed}];
    }
    if(entregaProp.tipo==="entrega"){
      payload.transporte={ fretePorConta:0, frete:freteProp, quantidade:1, pesoBruto:estimarPesoPedido(prop.itens||[])||1 };
      const end=prop.cliente?.endereco||{};
      // fallback: se os campos estruturados do cliente vierem incompletos por
      // algum motivo (endereço não totalmente cadastrado, por ex.), usa o texto
      // do endereço que JÁ foi usado pra calcular o frete, em vez de simplesmente
      // deixar de enviar o endereço de entrega pro Bling sem avisar ninguém
      const partesTexto=(entregaProp.endereco||"").split(",").map(s=>s.trim()).filter(Boolean);
      const temAlgumEndereco=!!(end.rua||partesTexto.length);
      if(temAlgumEndereco){
        const endFallback={
          rua: end.rua||partesTexto[0]||"Endereço não detalhado",
          numero: end.numero||"",
          bairro: end.bairro||partesTexto[1]||"",
          cidade: end.cidade||partesTexto[partesTexto.length-2]||"Belo Horizonte",
          uf: end.uf||partesTexto[partesTexto.length-1]||"MG",
        };
        Object.assign(payload.transporte, montarBlocoEnderecoEntrega(endFallback, prop.cliente?.nome||""));
      } else {
        console.warn("[atacado] gerar-pedido: entrega sem NENHUM endereco disponivel (nem estruturado, nem texto) - proposta",req.params.id);
      }
    }
    console.log("[atacado] payload gerar-pedido:",JSON.stringify(payload));
    let criado;
    try{
      criado=await bling(`/pedidos/vendas`,{method:"POST",body:JSON.stringify(payload)});
    }catch(errBling){
      // extrai o detalhe do erro do Bling (quais campos falharam) pra mostrar na tela
      console.error("[atacado] erro Bling ao criar pedido:",JSON.stringify(errBling.body||errBling.message));
      const b=errBling.body||{};
      const campos=b?.error?.fields||b?.error?.details||[];
      const detalhe=Array.isArray(campos)&&campos.length
        ? campos.map(f=>`${f.element||f.field||f.campo||''}: ${f.msg||f.message||f.descricao||JSON.stringify(f)}`).join(" | ")
        : (b?.error?.description||b?.error?.message||errBling.message||"erro desconhecido");
      liberarTrava();
      return res.status(400).json({erro:"Bling recusou: "+detalhe, detalheCompleto:b});
    }
    const pedidoId=criado?.data?.id;
    // proteção: se o Bling respondeu sem erro mas não devolveu o ID do pedido,
    // não dá pra considerar gerado — trata como falha e mantém como proposta
    if(!pedidoId){
      liberarTrava();
      return res.status(400).json({erro:"O Bling não retornou o número do pedido — tente de novo. Se persistir, confira no Bling se o pedido chegou a ser criado antes de gerar outro."});
    }
    let numero=criado?.data?.numero||null;
    const numeroVeioDoBling=!!numero;
    if(!numero) numero=pedidoId; // provisório, só pra não travar a resposta — corrigido abaixo em 2º plano
    // reforça o vendedor via PUT (o POST às vezes não respeita) e move pra separação
    if(pedidoId&&prop.vendedorId){
      try{ await new Promise(r=>setTimeout(r,350)); await bling(`/pedidos/vendas/${pedidoId}`,{method:"PUT",body:JSON.stringify(payload)}); }catch(e){}
    }
    // move pra "aguardando separação" (mesmo status do fluxo do totem)
    try{ await new Promise(r=>setTimeout(r,350)); await bling(`/pedidos/vendas/${pedidoId}/situacoes/${SIT.AGUARDANDO}`,{method:"PATCH"}); }catch(e){}
    addLog(String(pedidoId),"pedido_criado_atacado",prop.funcionarioId,prop.funcionarioNome,{proposta:prop.id});

    // se o vendedor já marcou um dia desejado de entrega, agenda o pedido
    // direto no Gerenciamento de Rota (fica em "aguardando carro" nesse dia,
    // pronto pra já entrar na distribuição depois)
    let agendadoRotaData=null;
    if(entregaProp.tipo==="entrega" && entregaProp.dataDesejada && /^\d{4}-\d{2}-\d{2}$/.test(entregaProp.dataDesejada) && pedidoId){
      try{
        const rotas=lerRotasDias();
        const data=entregaProp.dataDesejada;
        if(!rotas[data]) rotas[data]={};
        if(!rotas[data]["_semCarro"]) rotas[data]["_semCarro"]={pedidoIds:[]};
        if(!rotas[data]["_semCarro"].pedidoIds.includes(pedidoId)) rotas[data]["_semCarro"].pedidoIds.push(pedidoId);
        salvarRotasDias(rotas);
        // grava também o TURNO escolhido pela vendedora (aparece na rota e na tela de Pedidos)
        try{
          const tf=`${DATA_DIR}/turnos_entrega.json`;
          const turnos=lerJSON(tf,{});
          turnos[String(pedidoId)]={data, turno:(["manha","tarde"].includes(entregaProp.turno)?entregaProp.turno:"qualquer"),
            obsEntrega:String(entregaProp.obsEntrega||"").slice(0,300), por:prop.funcionarioNome||prop.vendedorNome||"—", em:Date.now(), numero};
          salvarJSON(tf,turnos);
        }catch(e){}
        agendadoRotaData=data;
      }catch(e){ console.error("[atacado] falhou ao agendar pedido",pedidoId,"no Gerenciamento de Rota:",e.message); }
    }

    prop.status="pedido_gerado";
    prop.pedidoBlingId=pedidoId; prop.pedidoBlingNumero=numero;
    prop.gerandoPedidoEm=null;
    prop.atualizadoEm=Date.now();
    props[prop.id]=prop; salvarPropostas(props);
    // se o Bling não devolveu o número na criação, busca em SEGUNDO PLANO (sem travar
    // a resposta) e corrige tanto a proposta quanto o comprovante já impresso não dá
    // pra corrigir, mas o registro fica certo pra próximas consultas/impressões
    if(!numeroVeioDoBling){
      (async()=>{
        try{
          const det=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data);
          const numReal=det?.numero; if(!numReal) return;
          const pp=lerPropostas(); if(pp[prop.id]){ pp[prop.id].pedidoBlingNumero=numReal; salvarPropostas(pp); }
        }catch(e){}
      })();
    }
    res.json({ok:true,pedidoId,numero,numeroConfirmado:numeroVeioDoBling,agendadoRotaData});
  }catch(e){
    try{ const pp=lerPropostas(); if(pp[req.params.id]){ pp[req.params.id].gerandoPedidoEm=null; salvarPropostas(pp); } }catch(e2){}
    res.status(e.status||500).json({erro:e.message,body:e.body});
  }
});

// ===== APOIO À DECISÃO DO VENDEDOR (atacado) =====

// armazenamento de prospecção: { historico:{clienteId:[{em,quando,vendedor,nota,resultado}]}, ignorados:{clienteId:true} }
function lerProspeccao(){ return lerJSON(PROSPECCAO_FILE,{historico:{},ignorados:{}}); }
function salvarProspeccao(p){ salvarJSON(PROSPECCAO_FILE,p); }

// histórico completo de prospecção (linha do tempo de todos os contatos)
app.get("/api/vendedor/prospeccao",(req,res)=>{
  const p=lerProspeccao();
  // monta uma linha do tempo achatada, mais recente primeiro
  const timeline=[];
  Object.entries(p.historico||{}).forEach(([cid,eventos])=>{
    (eventos||[]).forEach(e=>timeline.push({clienteId:cid,...e}));
  });
  timeline.sort((a,b)=>(b.em||0)-(a.em||0));
  res.json({historico:p.historico||{},ignorados:p.ignorados||{},timeline});
});

// registra um contato feito com o cliente (linha do tempo)
app.post("/api/vendedor/prospeccao/contato",(req,res)=>{
  const {clienteId,clienteNome,nota,resultado,vendedor}=req.body||{};
  if(!clienteId) return res.status(400).json({erro:"clienteId obrigatório"});
  const p=lerProspeccao();
  if(!p.historico) p.historico={};
  if(!p.historico[clienteId]) p.historico[clienteId]=[];
  p.historico[clienteId].push({
    em:Date.now(),
    quando:new Date(Date.now()-3*60*60*1000).toISOString(),
    clienteNome:clienteNome||"", nota:nota||"", resultado:resultado||"contatado", vendedor:vendedor||"",
  });
  salvarProspeccao(p);
  res.json({ok:true,historico:p.historico[clienteId]});
});

// ignora um cliente (some da lista de análise — ex.: cadastro duplicado)
app.post("/api/vendedor/prospeccao/ignorar",(req,res)=>{
  const {clienteId,ignorar}=req.body||{};
  if(!clienteId) return res.status(400).json({erro:"clienteId obrigatório"});
  const p=lerProspeccao();
  if(!p.ignorados) p.ignorados={};
  if(ignorar===false) delete p.ignorados[clienteId];
  else p.ignorados[clienteId]=true;
  salvarProspeccao(p);
  res.json({ok:true,ignorados:p.ignorados});
});

// Analisa pedidos de atacado (exclui vendedores de varejo e Consumidor Final).
// Retorna: meta do mês (atendidos), clientes que sumiram, pedidos grandes, top por produto.
const APOIO_CACHE_FILE=`${DATA_DIR}/apoio_cache.json`;
const PEDIDO_VENDEDOR_CACHE_FILE=`${DATA_DIR}/pedido_vendedor_cache.json`;
let _cacheApoio=null; // {em, dados}
// cache permanente pedidoId -> vendedorId (o vendedor de um pedido nunca muda,
// então uma vez descoberto não precisa buscar o detalhe de novo — isso deixa as
// análises seguintes MUITO mais rápidas conforme o volume de pedidos cresce)
let _cachePedidoVendedor={};
try{ _cachePedidoVendedor=lerJSON(PEDIDO_VENDEDOR_CACHE_FILE,{})||{}; }catch(e){ _cachePedidoVendedor={}; }
// carrega o cache do disco ao subir (sobrevive a deploy/reinício)
try{ const c=lerJSON(APOIO_CACHE_FILE,null); if(c&&c.em) _cacheApoio=c; }catch(e){}
// Estado do processamento em segundo plano do "apoio ao vendedor".
// A análise é PESADA (varre centenas/milhares de pedidos no Bling) e não pode
// rodar dentro da requisição da tela — o tempo limite do servidor/Railway
// mataria a requisição no meio, sem nem salvar o progresso. Então ela roda em
// SEGUNDO PLANO: a tela pede, o servidor devolve na hora o último resultado
// pronto (ou avisa "calculando…"), e dispara o cálculo pesado por fora, sem
// prazo. Quando termina, o próximo carregamento da tela já pega o novo.
let _apoioComputando=false;
let _apoioComputandoDesde=0;
let _apoioProgresso="";

// salva o cache pedido->vendedor no disco (chamado de tempos em tempos DURANTE
// o cálculo, não só no fim — assim, se o processo reiniciar no meio, o que já
// foi descoberto não se perde e a próxima rodada continua de onde parou)
function salvarCachePedidoVendedor(){ try{ salvarJSON(PEDIDO_VENDEDOR_CACHE_FILE,_cachePedidoVendedor); }catch(e){} }

// A COMPUTAÇÃO PESADA de verdade — roda em segundo plano, sem prazo.
async function computarApoio({minValor,diasAtencao,diasPerdido}){
  const prosp=lerProspeccao();
  const ignorados=prosp.ignorados||{};
  const historicoProsp=prosp.historico||{};
  const agora=Date.now();
  const dataIni=new Date(agora-180*24*60*60*1000).toISOString().slice(0,10);
  const dataFim=new Date(agora+24*60*60*1000).toISOString().slice(0,10);
  const pedidos=[];
  for(let pg=1;pg<=100;pg++){
    const p=new URLSearchParams({pagina:pg,limite:100,dataInicial:dataIni,dataFinal:dataFim});
    let arr=[];
    try{ const r=await bling(`/pedidos/vendas?${p.toString()}`); arr=r?.data||[]; }catch(e){ break; }
    pedidos.push(...arr);
    _apoioProgresso=`Lendo pedidos (${pedidos.length})…`;
    if(arr.length<100) break;
    await new Promise(r=>setTimeout(r,300));
  }
  const atacado=pedidos.filter(p=>{
    const vend=Number(p.vendedor?.id||0);
    const cont=Number(p.contato?.id||0);
    const sit=Number(p.situacao?.id||0);
    if(VENDEDORES_VAREJO.includes(vend)) return false;
    if(cont===CONSUMIDOR_FINAL_ID) return false;
    if(sit===12) return false;
    return true;
  });

  const mesAtual=new Date(agora-3*60*60*1000).toISOString().slice(0,7);
  const SIT_ATENDIDO=Number(process.env.SIT_ATENDIDO||9);
  const [anoM,mmM]=mesAtual.split("-").map(Number);
  const ultimoDiaM=new Date(anoM,mmM,0).getDate();
  const pedidosMes=[];
  for(let pg=1;pg<=60;pg++){
    const p=new URLSearchParams({pagina:pg,limite:100,dataInicial:`${mesAtual}-01`,dataFinal:`${mesAtual}-${String(ultimoDiaM).padStart(2,"0")}`});
    let arr=[];
    try{ const r=await bling(`/pedidos/vendas?${p.toString()}`); arr=r?.data||[]; }catch(e){ break; }
    pedidosMes.push(...arr);
    if(arr.length<100) break;
    await new Promise(r=>setTimeout(r,250));
  }
  const vistosMes=new Set();
  const doMes=pedidosMes.filter(p=>{
    const id=String(p.id); if(vistosMes.has(id)) return false; vistosMes.add(id);
    const vend=Number(p.vendedor?.id||0), cont=Number(p.contato?.id||0), sit=Number(p.situacao?.id||0);
    return !VENDEDORES_VAREJO.includes(vend) && cont!==CONSUMIDOR_FINAL_ID && sit!==12;
  });
  const atendidosMes=doMes.filter(p=>Number(p.situacao?.id)===SIT_ATENDIDO);
  const metaMes={
    qtdAtendidos:atendidosMes.length,
    valorAtendidos:+atendidosMes.reduce((s,p)=>s+Number(p.total||0),0).toFixed(2),
    qtdTotalMes:doMes.length,
    valorTotalMes:+doMes.reduce((s,p)=>s+Number(p.total||0),0).toFixed(2),
  };

  // VENDIDO POR VENDEDOR — precisa do vendedor de cada pedido, que só vem no
  // detalhe. Usa o cache permanente pedido->vendedor: só busca o detalhe dos
  // pedidos AINDA não conhecidos. Salva o cache a cada 25 buscas novas, pra não
  // perder progresso se reiniciar. Sem prazo — roda em segundo plano.
  const SIT_NOMES={818795:"Aguardando",817963:"Em separação",821590:"Separado",819227:"Pendência",821611:"Conf. entrega",24:"Verificado",820085:"Em rota",9:"Atendido",21:"Em digitação",6:"Em aberto"};
  const porVendedor={};
  let novasBuscas=0, feitos=0;
  for(const p of doMes){
    feitos++;
    let vid, vnome="Sem vendedor";
    const cacheKey=String(p.id);
    if(_cachePedidoVendedor[cacheKey]!==undefined){
      vid=Number(_cachePedidoVendedor[cacheKey]||0);
      if(vid) vnome=await nomeVendedor(vid);
    } else {
      vid=0;
      try{
        const det=await bling(`/pedidos/vendas/${p.id}`);
        vid=Number(det?.data?.vendedor?.id||0);
        if(vid) vnome=await nomeVendedor(vid);
        _cachePedidoVendedor[cacheKey]=vid;
        novasBuscas++;
        if(novasBuscas%25===0){ salvarCachePedidoVendedor(); } // salva o progresso a cada 25
      }catch(e){ continue; }
    }
    _apoioProgresso=`Analisando vendedores (${feitos}/${doMes.length})…`;
    if(VENDEDORES_VAREJO.includes(vid)) continue;
    if(!porVendedor[vid]) porVendedor[vid]={id:vid,nome:vnome,qtd:0,valor:0,atendidos:0,valorAtendido:0,porStatus:{}};
    const v=porVendedor[vid];
    v.qtd++; v.valor+=Number(p.total||0);
    const sit=Number(p.situacao?.id||0);
    const snome=SIT_NOMES[sit]||("Status "+sit);
    v.porStatus[snome]=(v.porStatus[snome]||0)+1;
    if(sit===SIT_ATENDIDO){ v.atendidos++; v.valorAtendido+=Number(p.total||0); }
  }
  if(novasBuscas>0) salvarCachePedidoVendedor(); // salva o resto no fim
  const vendedores=Object.values(porVendedor).map(v=>({...v,valor:+v.valor.toFixed(2),valorAtendido:+v.valorAtendido.toFixed(2)})).sort((a,b)=>b.valor-a.valor);
  // total geral vira o valor exato de atacado (varejo excluído pelo vendedor real)
  metaMes.qtdTotalMes=vendedores.reduce((s,v)=>s+v.qtd,0);
  metaMes.valorTotalMes=+vendedores.reduce((s,v)=>s+v.valor,0).toFixed(2);
  metaMes.qtdAtendidos=vendedores.reduce((s,v)=>s+v.atendidos,0);
  metaMes.valorAtendidos=+vendedores.reduce((s,v)=>s+v.valorAtendido,0).toFixed(2);

  const porCliente={};
  atacado.forEach(p=>{
    const id=Number(p.contato?.id||0); if(!id) return;
    if(!porCliente[id]) porCliente[id]={id,nome:p.contato?.nome||"—",pedidos:[],total:0};
    porCliente[id].pedidos.push({data:p.data,total:Number(p.total||0)});
    porCliente[id].total+=Number(p.total||0);
  });

  const perdidos=[];
  Object.values(porCliente).forEach(c=>{
    if(ignorados[c.id]) return;
    const datas=c.pedidos.map(x=>x.data).filter(Boolean).sort();
    if(!datas.length) return;
    const ultima=datas[datas.length-1];
    const diasSem=Math.floor((agora-new Date(ultima+"T12:00:00").getTime())/(24*60*60*1000));
    const ticketMedio=c.total/c.pedidos.length;
    const eraRegular=c.pedidos.length>=3 && ticketMedio>=minValor;
    if(eraRegular && diasSem>=diasAtencao){
      const hist=historicoProsp[c.id]||[];
      const ultimoContato=hist.length?hist[hist.length-1]:null;
      perdidos.push({
        id:c.id, nome:c.nome, diasSem, ultimaCompra:ultima,
        qtdPedidos:c.pedidos.length, ticketMedio:+ticketMedio.toFixed(2),
        totalGasto:+c.total.toFixed(2),
        nivel: diasSem>=diasPerdido?"perdido":"atencao",
        qtdContatos:hist.length,
        ultimoContato:ultimoContato?{quando:ultimoContato.quando,resultado:ultimoContato.resultado,nota:ultimoContato.nota}:null,
      });
    }
  });
  perdidos.sort((a,b)=>b.totalGasto-a.totalGasto);

  const ha30=new Date(agora-30*24*60*60*1000).toISOString().slice(0,10);
  const pedidosGrandes=atacado
    .filter(p=>Number(p.total||0)>=minValor && String(p.data||"")>=ha30)
    .map(p=>{
      const cid=Number(p.contato?.id||0);
      const cli=porCliente[cid];
      const datas=cli?cli.pedidos.map(x=>x.data).filter(Boolean).sort():[];
      const ultimaCompra=datas.length?datas[datas.length-1]:p.data;
      const diasSemComprar=Math.floor((agora-new Date(ultimaCompra+"T12:00:00").getTime())/(24*60*60*1000));
      return {numero:p.numero,id:p.id,cliente:p.contato?.nome||"—",contatoId:cid,total:Number(p.total||0),data:p.data,ultimaCompra,diasSemComprar};
    })
    .sort((a,b)=>b.diasSemComprar-a.diasSemComprar)
    .slice(0,50);

  return {
    metaMes, mesAtual, vendedores,
    perdidos, qtdPerdidos: perdidos.length,
    pedidosGrandes,
    totalClientesAtacado: Object.keys(porCliente).length,
    config:{minValor,diasAtencao,diasPerdido},
    geradoEm:Date.now(),
  };
}

// dispara a computação em segundo plano (se já não estiver rodando)
function dispararApoioBackground(opts){
  if(_apoioComputando) return;
  _apoioComputando=true; _apoioComputandoDesde=Date.now(); _apoioProgresso="Iniciando…";
  computarApoio(opts)
    .then(dados=>{ _cacheApoio={em:Date.now(),dados}; try{ salvarJSON(APOIO_CACHE_FILE,_cacheApoio); }catch(e){} })
    .catch(e=>{ console.error("[apoio] erro no cálculo em segundo plano:",e.message); })
    .finally(()=>{ _apoioComputando=false; _apoioProgresso=""; });
}

app.get("/api/vendedor/apoio",async(req,res)=>{
  try{
    const forcar=req.query.forcar==="1";
    const minValor=Number(req.query.minValor||1000);
    const diasAtencao=Number(req.query.diasAtencao||15);
    const diasPerdido=Number(req.query.diasPerdido||30);
    const mesAgora=new Date(Date.now()-3*60*60*1000).toISOString().slice(0,7);
    const temCacheValido=_cacheApoio && _cacheApoio.dados?.vendedores;
    const mesmoMes=temCacheValido && _cacheApoio.dados.mesAtual===mesAgora; // vira o mês -> cache velho
    const cacheFresco=temCacheValido && mesmoMes && (Date.now()-_cacheApoio.em < 24*60*60*1000);

    // tem cache fresco e não pediu pra forçar → devolve na hora
    if(cacheFresco && !forcar){
      return res.json({..._cacheApoio.dados, doCache:true, cacheEm:_cacheApoio.em, computando:_apoioComputando});
    }
    // precisa (re)calcular — dispara em segundo plano e responde na hora
    dispararApoioBackground({minValor,diasAtencao,diasPerdido});
    if(temCacheValido && mesmoMes){
      // já tem um resultado anterior DO MESMO MÊS: mostra ele enquanto o novo é calculado
      return res.json({..._cacheApoio.dados, doCache:true, cacheEm:_cacheApoio.em, computando:true, progresso:_apoioProgresso});
    }
    // primeira análise, ou o mês virou (meta nova): não mostra dados do mês passado
    return res.json({computando:true, primeira:true, mesAtual:mesAgora, progresso:_apoioProgresso||"Iniciando…"});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// ==================== SUGESTÃO DE ESTOQUE PARADO (Parte 4) ====================
// Acha produtos que TÊM estoque mas NÃO venderam nos últimos N meses — provável
// estoque fantasma (produto que talvez nem exista mais na loja, mas segue com
// saldo no Bling). Roda em SEGUNDO PLANO (a varredura é pesada: precisa ler o
// detalhe de cada pedido de venda do período pra saber quais produtos venderam),
// e guarda o resultado em cache pra tela abrir na hora.
const ESTOQUE_PARADO_FILE=`${DATA_DIR}/estoque_parado_cache.json`;
let _cacheParado=null;
try{ const c=lerJSON(ESTOQUE_PARADO_FILE,null); if(c&&c.em) _cacheParado=c; }catch(e){}
let _paradoComputando=false, _paradoDesde=0, _paradoProgresso="";

async function computarEstoqueParado({meses}){
  const agora=Date.now();
  const diasPeriodo=meses*30;
  const dataIni=new Date(agora-diasPeriodo*24*60*60*1000).toISOString().slice(0,10);
  const dataFim=new Date(agora+24*60*60*1000).toISOString().slice(0,10);

  // 1) lista os pedidos de venda do período (a listagem NÃO traz itens)
  const pedidos=[];
  for(let pg=1;pg<=200;pg++){
    const p=new URLSearchParams({pagina:pg,limite:100,dataInicial:dataIni,dataFinal:dataFim});
    let arr=[];
    try{ const r=await bling(`/pedidos/vendas?${p.toString()}`); arr=r?.data||[]; }catch(e){ break; }
    pedidos.push(...arr);
    _paradoProgresso=`Lendo pedidos do período (${pedidos.length})…`;
    if(arr.length<100) break;
    await new Promise(r=>setTimeout(r,300));
  }
  // ignora cancelados
  const validos=pedidos.filter(p=>Number(p.situacao?.id||0)!==12);

  // 2) lê o DETALHE de cada pedido pra descobrir quais PRODUTOS venderam
  const produtosVendidos=new Set(); // ids de produto que tiveram venda no período
  let feitos=0;
  for(const ped of validos){
    try{
      const d=await bling(`/pedidos/vendas/${ped.id}`).then(r=>r?.data);
      (d?.itens||[]).forEach(it=>{ if(it.produto?.id) produtosVendidos.add(Number(it.produto.id)); });
    }catch(e){}
    feitos++;
    if(feitos%20===0){ _paradoProgresso=`Analisando vendas (${feitos}/${validos.length})…`; }
    await new Promise(r=>setTimeout(r,150));
  }

  // 3) varre os produtos que TÊM estoque e cruza: com estoque + sem venda = parado
  _paradoProgresso="Verificando produtos com estoque…";
  const tab=lerTabela();
  // índice nome/categoria/preço pela tabela de atacado (por id de produto Bling)
  const infoPorId={};
  (tab?.model||[]).forEach(cat=>(cat.itens||[]).forEach(it=>(it.bling||[]).forEach(b=>{
    if(b.id) infoPorId[Number(b.id)]={nome:b.nome||it.nome||"",categoria:cat.t||"",preco:it.preco??null};
  })));

  const parados=[];
  for(let pg=1;pg<=60;pg++){
    let arr=[];
    try{ const r=await bling(`/produtos?pagina=${pg}&limite=100`); arr=r?.data||[]; }catch(e){ break; }
    if(!arr.length) break;
    for(const prod of arr){
      const saldo=prod.estoque?.saldoVirtualTotal ?? prod.estoque?.saldoFisicoTotal ?? 0;
      if(!(saldo>0)) continue;               // só interessa quem TEM estoque
      if(produtosVendidos.has(Number(prod.id))) continue; // vendeu no período → não está parado
      const info=infoPorId[Number(prod.id)];
      parados.push({
        produtoId:prod.id, codigo:prod.codigo||"", nome:prod.nome||info?.nome||"",
        categoria:info?.categoria||"", estoque:saldo, preco:info?.preco ?? +(prod.preco||0),
        valorParado:+((info?.preco ?? +(prod.preco||0))*saldo).toFixed(2),
      });
    }
    _paradoProgresso=`Verificando produtos (${parados.length} parados até agora)…`;
    if(arr.length<100) break;
    await new Promise(r=>setTimeout(r,300));
  }
  // ordena pelo maior valor parado (o que mais “trava” dinheiro em estoque)
  parados.sort((a,b)=>(b.valorParado||0)-(a.valorParado||0));
  return {meses, periodoDesde:dataIni, totalParados:parados.length,
    valorTotalParado:+(parados.reduce((s,p)=>s+(p.valorParado||0),0)).toFixed(2),
    produtos:parados};
}

function dispararParadoBackground(opts){
  if(_paradoComputando) return;
  _paradoComputando=true; _paradoDesde=Date.now(); _paradoProgresso="Iniciando…";
  computarEstoqueParado(opts)
    .then(dados=>{ _cacheParado={em:Date.now(),dados}; try{ salvarJSON(ESTOQUE_PARADO_FILE,_cacheParado); }catch(e){} })
    .catch(e=>{ console.error("[estoque-parado] erro no cálculo:",e.message); })
    .finally(()=>{ _paradoComputando=false; _paradoProgresso=""; });
}

app.get("/api/estoque/parado",(req,res)=>{
  try{
    const forcar=req.query.forcar==="1";
    const meses=Number(req.query.meses||3);
    const temCache=_cacheParado && _cacheParado.dados?.produtos;
    // cache válido por 24h (a varredura é pesada, não faz sentido refazer sempre)
    const cacheFresco=temCache && (Date.now()-_cacheParado.em < 24*60*60*1000) && _cacheParado.dados.meses===meses;
    if(cacheFresco && !forcar){
      return res.json({..._cacheParado.dados, doCache:true, cacheEm:_cacheParado.em, computando:_paradoComputando});
    }
    dispararParadoBackground({meses});
    if(temCache){
      return res.json({..._cacheParado.dados, doCache:true, cacheEm:_cacheParado.em, computando:true, progresso:_paradoProgresso});
    }
    return res.json({computando:true, primeira:true, progresso:_paradoProgresso||"Iniciando…"});
  }catch(e){ res.status(500).json({erro:e.message}); }
});


function lerMetas(){ return lerJSON(METAS_FILE,{}); }
function salvarMetas(m){ salvarJSON(METAS_FILE,m); }

// lê a meta de um mês (ou do mês atual)
app.get("/api/vendedor/meta",(req,res)=>{
  res.set("Cache-Control","no-store, no-cache, must-revalidate");
  const mes=req.query.mes||new Date(Date.now()-3*60*60*1000).toISOString().slice(0,7);
  const metas=lerMetas();
  res.json({mes,meta:metas[mes]||0});
});

// define a meta de um mês
app.post("/api/vendedor/meta",(req,res)=>{
  const mes=req.body?.mes||new Date(Date.now()-3*60*60*1000).toISOString().slice(0,7);
  const meta=Number(req.body?.meta||0);
  const metas=lerMetas();
  metas[mes]=meta; salvarMetas(metas);
  res.json({ok:true,mes,meta});
});

// acompanhamento da meta: vendido por dia, total, meta, ritmo ideal
app.get("/api/vendedor/meta-acompanhamento",async(req,res)=>{
  res.set("Cache-Control","no-store, no-cache, must-revalidate");
  try{
    const agoraBR=new Date(Date.now()-3*60*60*1000);
    const mes=req.query.mes||agoraBR.toISOString().slice(0,7);
    const metas=lerMetas();
    const meta=metas[mes]||0;
    // busca os pedidos do mês (atacado, sem varejo/consumidor final, sem cancelado)
    const [ano,mm]=mes.split("-").map(Number);
    const dataIni=`${mes}-01`;
    const ultimoDia=new Date(ano,mm,0).getDate();
    const dataFim=`${mes}-${String(ultimoDia).padStart(2,"0")}`;
    const pedidos=[];
    for(let pg=1;pg<=60;pg++){
      const p=new URLSearchParams({pagina:pg,limite:100,dataInicial:dataIni,dataFinal:dataFim});
      let arr=[];
      try{ const r=await bling(`/pedidos/vendas?${p.toString()}`); arr=r?.data||[]; }catch(e){ break; }
      pedidos.push(...arr);
      if(arr.length<100) break;
      await new Promise(r=>setTimeout(r,250));
    }
    const atacado=pedidos.filter(p=>{
      const vend=Number(p.vendedor?.id||0), cont=Number(p.contato?.id||0), sit=Number(p.situacao?.id||0);
      return !VENDEDORES_VAREJO.includes(vend) && cont!==CONSUMIDOR_FINAL_ID && sit!==12;
    });
    // deduplica por ID (a paginação do Bling às vezes repete pedidos entre páginas)
    const vistosMA=new Set();
    const atacadoUnico=atacado.filter(p=>{ const id=String(p.id); if(vistosMA.has(id)) return false; vistosMA.add(id); return true; });
    // soma por dia (TODOS os pedidos de atacado)
    const porDia={};
    atacadoUnico.forEach(p=>{ const d=String(p.data||"").slice(0,10); if(d){ porDia[d]=+((porDia[d]||0)+Number(p.total||0)).toFixed(2); } });
    // soma por dia SÓ dos ATENDIDOS (situação 9) — é o que realmente conta pra meta
    const atendidos=atacadoUnico.filter(p=>Number(p.situacao?.id||0)===SIT.ATENDIDO);
    const porDiaAt={};
    atendidos.forEach(p=>{ const d=String(p.data||"").slice(0,10); if(d){ porDiaAt[d]=+((porDiaAt[d]||0)+Number(p.total||0)).toFixed(2); } });
    // monta série de todos os dias do mês
    const hoje=agoraBR.toISOString().slice(0,10);
    const diaAtual=agoraBR.getDate();
    const ehMesAtual=(mes===agoraBR.toISOString().slice(0,7));
    const dias=[];
    let acumulado=0, acumuladoAt=0;
    for(let d=1;d<=ultimoDia;d++){
      const dataStr=`${mes}-${String(d).padStart(2,"0")}`;
      const valor=porDia[dataStr]||0;
      const valorAt=porDiaAt[dataStr]||0;
      acumulado=+(acumulado+valor).toFixed(2);
      acumuladoAt=+(acumuladoAt+valorAt).toFixed(2);
      const futuro=ehMesAtual && d>diaAtual;
      dias.push({dia:d,data:dataStr,valor,valorAtendido:valorAt,acumulado:futuro?null:acumulado,acumuladoAtendido:futuro?null:acumuladoAt,futuro});
    }
    const vendido=+atacadoUnico.reduce((s,p)=>s+Number(p.total||0),0).toFixed(2);
    const vendidoAtendido=+atendidos.reduce((s,p)=>s+Number(p.total||0),0).toFixed(2);
    const falta=+Math.max(0,meta-vendido).toFixed(2);
    const faltaAtendido=+Math.max(0,meta-vendidoAtendido).toFixed(2);

    // ---- cálculos considerando que NÃO abre aos domingos ----
    // conta quantos dias ÚTEIS (seg-sáb, sem domingo) há entre dois dias do mês (inclusive).
    const ehDomingo=(d)=> new Date(ano,mm-1,d).getDay()===0;
    const contarDiasUteis=(de,ate)=>{ let n=0; for(let d=de;d<=ate;d++){ if(!ehDomingo(d)) n++; } return n; };
    const diasUteisMes=contarDiasUteis(1,ultimoDia); // total de dias úteis no mês

    // ritmo ideal: quanto vender por dia ÚTIL restante pra bater a meta (domingo não conta)
    const diasUteisRestantes=ehMesAtual?contarDiasUteis(Math.min(diaAtual+1,ultimoDia+1),ultimoDia):0;
    const idealPorDiaRestante=diasUteisRestantes>0?+(falta/diasUteisRestantes).toFixed(2):0;
    // também expõe a contagem "corrida" pra referência
    const diasRestantes=ehMesAtual?Math.max(0,ultimoDia-diaAtual):0;

    // linha ideal do gráfico: a meta é distribuída pelos DIAS ÚTEIS. A linha sobe
    // só nos dias úteis (fica "de patamar" no domingo, já que não se espera venda).
    const idealPorDiaUtil=diasUteisMes>0?meta/diasUteisMes:0;
    dias.forEach(x=>{ x.metaAcumulada=+(idealPorDiaUtil*contarDiasUteis(1,x.dia)).toFixed(2); x.ehDomingo=ehDomingo(x.dia); });

    // média diária: divide pelos dias ÚTEIS já passados (não pelos corridos)
    const diasUteisPassados=contarDiasUteis(1, ehMesAtual?diaAtual:ultimoDia);
    const pctMeta=meta>0?Math.round(vendido/meta*100):0;
    // mesmos cálculos, mas pros ATENDIDOS (é o que decide se bateu a meta)
    const pctMetaAtendido=meta>0?Math.round(vendidoAtendido/meta*100):0;
    const idealPorDiaRestanteAtendido=diasUteisRestantes>0?+(faltaAtendido/diasUteisRestantes).toFixed(2):0;
    const mediaDiariaAtendido=diasUteisPassados>0?+(vendidoAtendido/diasUteisPassados).toFixed(2):0;

    res.json({
      mes, meta,
      vendido, falta, pctMeta,
      vendidoAtendido, faltaAtendido, pctMetaAtendido,
      diaAtual: ehMesAtual?diaAtual:ultimoDia, ultimoDia,
      diasRestantes, diasUteisRestantes, diasUteisMes,
      idealPorDiaRestante, idealPorDiaRestanteAtendido,
      mediaDiaria: diasUteisPassados>0?+(vendido/diasUteisPassados).toFixed(2):0,
      mediaDiariaAtendido,
      dias,
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// ===== METAS DE VENDA (fim) =====

// ===== MAPA DE CLIENTES + PROXIMIDADE =====
// geocodifica os clientes do Bling (endereço -> lat/lng) e guarda em cache,
// pra montar um mapa e achar clientes próximos uns dos outros.
const GEO_CLIENTES_FILE=`${DATA_DIR}/geo_clientes.json`;

function lerGeoClientes(){ return lerJSON(GEO_CLIENTES_FILE,{}); }
function salvarGeoClientes(g){ salvarJSON(GEO_CLIENTES_FILE,g); }

// distância entre duas coordenadas (km) — fórmula de Haversine
function distanciaKm(lat1,lng1,lat2,lng2){
  const R=6371, rad=x=>x*Math.PI/180;
  const dLat=rad(lat2-lat1), dLng=rad(lng2-lng1);
  const a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

async function geocodeEndereco(endereco){
  const url=`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(endereco)}&region=br&key=${GOOGLE_MAPS_KEY}`;
  const r=await fetch(url).then(x=>x.json());
  const loc=r?.results?.[0]?.geometry?.location;
  return loc?{lat:loc.lat,lng:loc.lng}:null;
}

// ======================= GERENCIAMENTO DE ROTA =======================
function lerRotasConfig(){
  return lerJSON(ROTAS_CONFIG_FILE,{
    diasEntrega:[false,true,true,true,true,true,false], // dom,seg,ter,qua,qui,sex,sab
    tempoParadaMin:15,     // tempo médio de carregar/descarregar + entregar em cada parada
    tempoTrajetoMin:12,    // tempo médio estimado de trajeto ENTRE paradas (só pra estimativa antes de calcular a rota de verdade)
    tempoRecargaMin:20,    // tempo médio pra voltar na loja, recarregar e sair de novo (entre 1 viagem e outra do mesmo carro)
    carros:[{id:"carro1",nome:"Carro 1",limiteEntregas:10,pesoSugeridoKg:200,horaSaida:"10:00",horaFimJanela:"19:00"}],
  });
}
function salvarRotasConfig(c){ salvarJSON(ROTAS_CONFIG_FILE,c); }
function lerRotasDias(){ return lerJSON(ROTAS_DIAS_FILE,{}); }
function salvarRotasDias(d){ salvarJSON(ROTAS_DIAS_FILE,d); }

// Remove um pedido de QUALQUER rota/dia/carro/viagem onde ele esteja agendado.
// Chamado quando um pedido é cancelado ou excluído — pra não deixar "pedido
// fantasma" ocupando espaço no gerenciamento de rota (contando no peso, na
// capacidade e no resumo do dia) depois de ter sumido do Bling.
// Recebe o ID do pedido no Bling (número que fica salvo na rota).
function removerPedidoDeTodasRotas(pedidoBlingId){
  if(!pedidoBlingId) return {removido:false};
  const pid=Number(pedidoBlingId);
  const rotas=lerRotasDias();
  let mexeu=false; const ondeEstava=[];
  for(const [data,carros] of Object.entries(rotas)){
    for(const [carroId,c] of Object.entries(carros||{})){
      // formato com viagens
      if(Array.isArray(c.viagens)){
        c.viagens.forEach((v,vix)=>{
          const antes=(v.pedidoIds||[]).length;
          v.pedidoIds=(v.pedidoIds||[]).filter(x=>Number(x)!==pid);
          if(v.pedidoIds.length!==antes){ mexeu=true; ondeEstava.push({data,carroId,viagem:vix}); }
        });
      }
      // formato antigo (lista única)
      if(Array.isArray(c.pedidoIds)){
        const antes=c.pedidoIds.length;
        c.pedidoIds=c.pedidoIds.filter(x=>Number(x)!==pid);
        if(c.pedidoIds.length!==antes){ mexeu=true; ondeEstava.push({data,carroId}); }
      }
    }
  }
  if(mexeu) salvarRotasDias(rotas);
  return {removido:mexeu, ondeEstava};
}
// acha em qual dia/carro um pedido foi planejado na rota (procura em todos os
// dias salvos) — usado pra comparar planejado x entregue de verdade
function acharAgendamentoPedido(pedidoId){
  const rotas=lerRotasDias();
  const pid=Number(pedidoId);
  for(const [data,carros] of Object.entries(rotas)){
    for(const [carroId,c] of Object.entries(carros||{})){
      const idsDoCarro=(c.viagens?.length?c.viagens.flatMap(v=>v.pedidoIds||[]):(c.pedidoIds||[]));
      if(idsDoCarro.some(x=>Number(x)===pid)) return {data,carroId};
    }
  }
  return null;
}

app.get("/api/rotas/config",(req,res)=>res.json({data:lerRotasConfig()}));
app.post("/api/rotas/config",(req,res)=>{
  const b=req.body||{};
  const atual=lerRotasConfig();
  const validaHora=(h,fallback)=>/^\d{1,2}:\d{2}$/.test(h||"")?h:fallback;
  const nova={
    diasEntrega:Array.isArray(b.diasEntrega)&&b.diasEntrega.length===7?b.diasEntrega:atual.diasEntrega,
    tempoParadaMin:Number(b.tempoParadaMin)||atual.tempoParadaMin,
    tempoTrajetoMin:Number(b.tempoTrajetoMin)||atual.tempoTrajetoMin,
    tempoRecargaMin:Number(b.tempoRecargaMin)||atual.tempoRecargaMin,
    carros:Array.isArray(b.carros)&&b.carros.length?b.carros.map(c=>({
      id:c.id||("carro"+Date.now()+Math.random().toString(36).slice(2,6)),
      nome:c.nome||"Carro",
      limiteEntregas:Number(c.limiteEntregas)||10,
      pesoSugeridoKg:Number(c.pesoSugeridoKg)||200,
      horaSaida:validaHora(c.horaSaida,"10:00"),
      horaFimJanela:validaHora(c.horaFimJanela,"19:00"),
    })):atual.carros,
  };
  salvarRotasConfig(nova);
  res.json({ok:true,data:nova});
});

// Resumo de quantos pedidos já estão atribuídos em cada dia salvo — usado
// pra (1) mostrar uma visão geral de quantos pedidos tem por dia e (2)
// garantir que um pedido já agendado numa data não apareça como "disponível"
// quando o usuário está olhando outra data.
app.get("/api/rotas/dias-resumo",(req,res)=>{
  const rotas=lerRotasDias();
  const porDia={}; const idsUsados={}; const detalheDias={};
  Object.entries(rotas).forEach(([data,carros])=>{
    let total=0; const porCarro={};
    Object.entries(carros||{}).forEach(([carroId,c])=>{
      // carro pode ter várias viagens (c.viagens) ou, em dados antigos, uma
      // lista única (c.pedidoIds) — junta tudo pra contar certo
      const idsDoCarrocarro=(c.viagens?.length?c.viagens.flatMap(v=>v.pedidoIds||[]):(c.pedidoIds||[]));
      idsDoCarrocarro.forEach(id=>{ idsUsados[id]=data; total++; });
      if(idsDoCarrocarro.length) porCarro[carroId]=idsDoCarrocarro;
    });
    if(total>0){ porDia[data]=total; detalheDias[data]=porCarro; }
  });
  res.json({porDia, idsUsados, detalheDias});
});

// Estimativa de peso do pedido a partir do nome/quantidade dos produtos —
// baseada em regras (volume detectado no nome + tipo de embalagem), não uma
// chamada de IA por produto (seria lento/caro e pouco confiável no servidor
// pra cada item). Cobre os padrões mais comuns de bebida (lata, garrafa, pet).
function estimarPesoProduto(nome){
  const n=String(nome||"").toLowerCase();
  let litros=0;
  const mL=n.match(/(\d+[.,]?\d*)\s*ml\b/);
  const mL2=n.match(/(\d+[.,]?\d*)\s*l\b/);
  if(mL) litros=parseFloat(mL[1].replace(",","."))/1000;
  else if(mL2) litros=parseFloat(mL2[1].replace(",","."));
  if(!litros) litros=0.5; // sem volume identificado no nome — assume padrão médio (500ml)
  let embalagemKg=0.03; // lata (padrão mais leve)
  if(/\bpet\b/.test(n)) embalagemKg=0.05;
  else if(/vidro|garrafa|long ?neck|whisky|whiskey|vodka|gin|licor|espumante|vinho|champanhe|conhaque|rum\b/.test(n)) embalagemKg=litros>=0.9?0.5:0.35;
  else if(/barril|chopp/.test(n)) embalagemKg=1.5;
  return +((litros*1+embalagemKg)).toFixed(3); // 1L de líquido ≈ 1kg
}
function estimarPesoPedido(itens){
  return +((itens||[]).reduce((s,i)=>s+estimarPesoProduto(i.descricao||i.produto?.nome||"")*Number(i.quantidade||0),0)).toFixed(2);
}

// Lista pedidos elegíveis pra entrega (tipo entrega, ainda não atendidos/cancelados)
// com os dados já prontos pra tela: cliente, vendedor, valor, frete, itens, peso.
// Descobre se um pedido JÁ FOI RECEBIDO em algum caixa (atacado ou frente) e como.
// Serve pra rota saber o que sai pra entrega sem estar pago.
function _pagamentoDoPedido(pedidoId){
  const id=String(pedidoId);
  const dCx=lerCaixaSessoes();
  for(const s of (dCx.sessoes||[])){
    for(const m of (s.movimentos||[])){
      if(m.tipo!=="venda"||m.cancelado||String(m.pedidoId)!==id) continue;
      return { pago:true, ondeFoiPago:(s.tipoCaixa||"frente")==="atacado"?"Caixa Atacado":"Frente de Caixa",
        operador:m.operador||s.operador||"", quando:m.em, valor:Number(m.total)||0,
        formas:(m.pagamentos||[]).map(x=>`${x.formaNome}: ${Number(x.valor).toFixed(2)}`).join(" · "),
        sessaoFechada:!!s.fechadaEm };
    }
  }
  const pg=lerPag()[id];
  if(pg&&pg.statusPagamento==="pago") return { pago:true, ondeFoiPago:"registro de pagamento", valor:Number(pg.valorPago)||0, formas:(pg.historico||[]).map(h=>`${h.formaNome}: ${Number(h.valor).toFixed(2)}`).join(" · ") };
  if(pg&&pg.statusPagamento==="parcial") return { pago:false, parcial:true, valorPago:Number(pg.valorPago)||0, valorPedido:Number(pg.valorPedido)||0 };
  return { pago:false };
}
// CONFERÊNCIA DE PAGAMENTO dos pedidos agendados num dia (ou período): diz quais
// já foram recebidos em caixa e quais NÃO — inclui dias passados, pra achar
// entrega que saiu e nunca foi cobrada.
app.get("/api/rotas/conferir-pagamentos",(req,res)=>{
  try{
    const ate=_hojeISO(req.query.data);
    const diasTras=Math.min(Number(req.query.dias||7),60);
    const limite=_inicioDia(ate)-((diasTras-1)*86400000);
    const turnos=lerJSON(`${DATA_DIR}/turnos_entrega.json`,{});
    const props=lerPropostas(); const porPedido={};
    Object.values(props||{}).forEach(p=>{ if(p.pedidoBlingId) porPedido[String(p.pedidoBlingId)]=p; });
    const itens=[];
    Object.entries(turnos).forEach(([pid,ag])=>{
      if(!ag||!ag.data) return;
      const ini=_inicioDia(ag.data);
      if(ini<limite||ini>_inicioDia(ate)) return; // fora da janela
      const sit=_sitOnline[pid]||null;
      if(sit&&sit.situacaoId===SIT.CANCELADO) return;
      const prop=porPedido[pid]||null;
      const pag=_pagamentoDoPedido(pid);
      itens.push({ pedidoId:pid, numero:ag.numero||prop?.pedidoBlingNumero||pid,
        data:ag.data, turno:ag.turno||"qualquer", obsEntrega:ag.obsEntrega||"",
        cliente:prop?.cliente?.nome||"—", total:Number(prop?.total||0),
        situacao:sit?sit.situacao:null, ...pag });
    });
    const semPagar=itens.filter(i=>!i.pago).sort((a,b)=>a.data.localeCompare(b.data));
    res.json({ ate, dias:diasTras, total:itens.length,
      pagos:itens.filter(i=>i.pago).length, semPagar:semPagar.length,
      valorSemPagar:+semPagar.reduce((s,i)=>s+i.total,0).toFixed(2),
      pendentes:semPagar, todos:itens });
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.get("/api/rotas/pedidos-entrega",async(req,res)=>{
  try{
    const dataAlvo=req.query.data||new Date(Date.now()-3*60*60*1000).toISOString().slice(0,10);
    const offsetBR=3*60*60*1000;
    // janela de datas: por padrão 60 dias pra trás e 7 dias pra frente (pega
    // pedidos futuros agendados também). Ajustável por ?dias= (quantos dias pra trás).
    const diasTras=Math.min(Number(req.query.dias||60),180);
    const dataFim=new Date(Date.now()-offsetBR+7*86400000).toISOString().slice(0,10);
    const dataIni=new Date(Date.now()-offsetBR-diasTras*86400000).toISOString().slice(0,10);
    // status que podem entrar na montagem de rota. Inclui "Em aberto" e "Em
    // digitação" (pedidos criados por vendedores nascem "Em digitação"), pra
    // permitir agendar na rota mesmo pedidos que ainda não passaram pela separação.
    const situacoes=[SIT.EM_ABERTO,SIT.EM_DIGITACAO,SIT.AGUARDANDO,SIT.SEPARADO,SIT.SEP_PEND,SIT.EM_ROTA];
    // pagina de verdade: busca TODAS as páginas (o Bling traz no máx 100 por vez).
    // Sem isso, com muitos pedidos em aberto/digitação, os excedentes ficavam de fora.
    let lista=[];
    for(let pag=1;pag<=30;pag++){
      const p=new URLSearchParams({pagina:pag,limite:100,dataInicial:dataIni,dataFinal:dataFim});
      situacoes.forEach(id=>p.append("idsSituacoes[]",id));
      let arr=[];
      try{ arr=await bling(`/pedidos/vendas?${p.toString()}`).then(r=>r?.data||[]); }catch(e){ break; }
      lista.push(...arr);
      if(arr.length<100) break; // última página
      await new Promise(r=>setTimeout(r,300)); // respeita o limite do Bling
    }
    // remove duplicados (a paginação do Bling às vezes repete)
    const vistos=new Set(); const unicos=lista.filter(p=>{ if(vistos.has(p.id)) return false; vistos.add(p.id); return true; });

    const rotasDias=lerRotasDias();
    const atribuidoNoDia=rotasDias[dataAlvo]||{};

    // AUTO-LIMPEZA de pedidos "fantasma": IDs agendados nesse dia que não estão
    // mais na lista ativa do Bling. Pode ser porque foram (a) cancelados/excluídos
    // no Bling — nesse caso devem sair da rota; ou (b) já entregues (atendido) —
    // nesse caso ficam (é histórico legítimo do planejado x realizado). Confere a
    // situação real SÓ dos IDs suspeitos (barato — normalmente é zero).
    const idsAtivos=new Set(unicos.map(p=>Number(p.id)));
    const idsAgendados=new Set();
    Object.values(atribuidoNoDia).forEach(c=>{
      (c.viagens?.length?c.viagens.flatMap(v=>v.pedidoIds||[]):(c.pedidoIds||[])).forEach(id=>idsAgendados.add(Number(id)));
    });
    const suspeitos=[...idsAgendados].filter(id=>!idsAtivos.has(id));
    for(const id of suspeitos){
      let situacao=null, existe=true;
      try{ const d=await bling(`/pedidos/vendas/${id}`).then(r=>r?.data); situacao=Number(d?.situacao?.id||0); }
      catch(e){ if(e.status===404) existe=false; } // 404 = foi excluído no Bling
      const SIT_CANCELADO=Number(process.env.SIT_CANCELADO||12);
      // remove da rota só se foi cancelado ou excluído (não se foi entregue)
      if(!existe || situacao===SIT_CANCELADO){
        removerPedidoDeTodasRotas(id);
      }
    }
    // relê depois da limpeza (pode ter mudado)
    const atribuidoNoDiaLimpo=lerRotasDias()[dataAlvo]||{};
    const acharCarroDoPedido=(pid)=>{
      for(const carroId in atribuidoNoDiaLimpo){
        const c=atribuidoNoDiaLimpo[carroId];
        const ids=(c.viagens?.length?c.viagens.flatMap(v=>v.pedidoIds||[]):(c.pedidoIds||[]));
        if(ids.map(Number).includes(Number(pid))) return carroId;
      }
      return null;
    };

    // OTIMIZAÇÃO: pré-filtro por valor usando o "total" que já vem na LISTAGEM
    // (barato, sem ler o detalhe). Pedido de entrega costuma ser acima de R$ 1.000,
    // então descarta os menores ANTES de ler o detalhe pesado — a não ser que o
    // pedido já esteja agendado na rota (esse sempre precisa aparecer). Ajustável
    // por ?valorMin= (0 desliga o filtro e volta a ler todos).
    // PADRÃO: só os pedidos ENVIADOS pra rota (agendados pela vendedora na tela de
    // Pedidos, com dia e turno) — era o que fazia aparecer pedido de retirada junto
    // e sumir entrega de valor baixo, porque o filtro antigo era só por valor.
    // ?todos=1 volta ao comportamento antigo (todos acima de ?valorMin=, padrão 1000).
    const turnosAg=lerJSON(`${DATA_DIR}/turnos_entrega.json`,{});
    const jaAgendado=(id)=>!!acharCarroDoPedido(id)||!!turnosAg[String(id)];
    let candidatos;
    if(req.query.todos==="1"){
      const valorMin=req.query.valorMin!=null?Number(req.query.valorMin):1000;
      candidatos = valorMin>0 ? unicos.filter(p=> Number(p.total||0)>=valorMin || jaAgendado(p.id)) : unicos;
    } else {
      candidatos = unicos.filter(p=>jaAgendado(p.id));
    }
    // GARANTIA: todo pedido agendado PRECISA aparecer, mesmo que não tenha vindo na
    // busca por situação (ex.: está "Em separação"/"Conferido", que não estão na lista
    // de situações, ou foi criado fora da janela de datas). Sem isso, o pedido
    // agendado simplesmente sumia da rota.
    const idsCandidatos=new Set(candidatos.map(p=>Number(p.id)));
    const faltando=[...new Set([...idsAgendados, ...Object.keys(turnosAg).map(Number)])]
      .filter(id=>id && !idsCandidatos.has(Number(id)));
    for(const id of faltando){
      try{
        const d=await bling(`/pedidos/vendas/${id}`).then(r=>r?.data);
        if(!d) continue;
        const sit=Number(d.situacao?.id||0);
        if(sit===SIT.CANCELADO) continue; // cancelado não entra
        candidatos.push(d);
      }catch(e){}
      await sleep(120);
    }

    const detalhados=[];
    for(let i=0;i<candidatos.length;i++){
      const resumo=candidatos[i];
      try{
        const det=await bling(`/pedidos/vendas/${resumo.id}`).then(r=>r?.data);
        if(!det) continue;
        const frete=+(det.transporte?.frete||0);
        // tenta achar o endereço em qualquer um dos formatos possíveis (o Bling
        // guarda em transporte.etiqueta OU transporte.enderecoEntrega dependendo
        // da versão/forma como o pedido foi criado); se nenhum dos dois tiver
        // dado, tenta extrair do texto da observação como último recurso
        // (cobre pedidos criados antes dessa descoberta)
        const endObj = det.transporte?.enderecoEntrega?.endereco ? det.transporte.enderecoEntrega
                     : det.transporte?.etiqueta?.endereco ? det.transporte.etiqueta
                     : null;
        let enderecoTxt = endObj?[endObj.endereco,endObj.numero,endObj.bairro,endObj.municipio,endObj.uf].filter(Boolean).join(", "):"";
        if(!enderecoTxt && det.observacoes){
          const m=det.observacoes.match(/ENTREGA\s*—\s*([^(]+)/);
          if(m) enderecoTxt=m[1].trim();
        }
        // FALLBACK: se o pedido não tem endereço próprio, usa o endereço do
        // CADASTRO DO CLIENTE no Bling (muitos pedidos em digitação/aberto são
        // criados sem transporte, mas o cliente tem endereço cadastrado).
        let enderecoOrigem = enderecoTxt ? "pedido" : null;
        if(!enderecoTxt && det.contato?.id){
          try{
            const c=await bling(`/contatos/${det.contato.id}`).then(r=>r?.data);
            const g=c?.endereco?.geral||c?.endereco||{};
            const eCli=[g.endereco,g.numero,g.bairro,g.municipio,g.uf].filter(Boolean).join(", ");
            if(eCli){ enderecoTxt=eCli; enderecoOrigem="cliente"; }
          }catch(e){}
        }
        const temEndereco=!!enderecoTxt;
        // NÃO descarta mais por falta de frete/endereço: todos os candidatos
        // entram na lista. Os sem endereço aparecem marcados (semEndereco:true)
        // pra você adicionar o endereço ou decidir. Só o geocode precisa de endereço.
        let coord=null;
        if(enderecoTxt) coord=await geocodeEndereco(enderecoTxt).catch(()=>null);
        detalhados.push({
          id:det.id, numero:det.numero, clienteNome:det.contato?.nome||"—", clienteId:det.contato?.id||null,
          vendedorNome:await nomeVendedor(det.vendedor?.id),
          total:+(det.total||0), totalProdutos:+(det.totalProdutos||0), frete,
          situacao:det.situacao?.id, situacaoNome:det.situacao?.nome||"",
          endereco:enderecoTxt, lat:coord?.lat||null, lng:coord?.lng||null,
          semEndereco:!temEndereco, enderecoOrigem,
          itens:(det.itens||[]).map(i=>({descricao:i.descricao||i.produto?.nome||"",quantidade:i.quantidade,valor:i.valor})),
          pesoEstimadoKg:estimarPesoPedido(det.itens||[]),
          carroAtribuido:acharCarroDoPedido(det.id),
          agendamento:(lerJSON(`${DATA_DIR}/turnos_entrega.json`,{})[String(det.id)]||null), // dia+turno que a vendedora escolheu
          pagamento:_pagamentoDoPedido(det.id), // já foi recebido em algum caixa?
        });
      }catch(e){}
      if(i%5===4) await new Promise(r=>setTimeout(r,300)); // evita rate-limit do Bling
    }
    res.json({data:detalhados, config:lerRotasConfig(), lojaCoord:await geocodeEndereco(LOJA_ENDERECO).catch(()=>null), lojaEndereco:LOJA_ENDERECO});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// Salva/lê a atribuição de pedidos aos carros num dia específico
app.get("/api/rotas/dia",(req,res)=>{
  const data=req.query.data; if(!data) return res.status(400).json({erro:"data obrigatória"});
  const rotas=lerRotasDias();
  res.json({data:rotas[data]||{}});
});
app.post("/api/rotas/dia",(req,res)=>{
  const {data,carros}=req.body||{};
  if(!data||!carros) return res.status(400).json({erro:"data e carros obrigatórios"});
  const rotas=lerRotasDias();
  rotas[data]=carros;
  salvarRotasDias(rotas);
  res.json({ok:true});
});

// Calcula a melhor ordem de entrega entre os pedidos selecionados (Google
// Directions com otimização de waypoints) + distância/tempo total, saindo da
// loja e voltando pra loja no final.
app.post("/api/rotas/calcular",async(req,res)=>{
  try{
    if(!GOOGLE_MAPS_KEY) return res.status(500).json({erro:"Google Maps não configurado no servidor."});
    const paradas=req.body?.paradas||[]; // [{id,endereco}]
    if(!paradas.length) return res.status(400).json({erro:"Informe ao menos uma parada."});
    const origem=LOJA_ENDERECO;
    const waypointsStr=paradas.map(p=>encodeURIComponent(p.endereco)).join("|");
    const url=`https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origem)}&destination=${encodeURIComponent(origem)}&waypoints=optimize:true|${waypointsStr}&key=${GOOGLE_MAPS_KEY}`;
    const j=await fetch(url).then(r=>r.json());
    if(j.status!=="OK") return res.status(400).json({erro:`Google Directions: ${j.status}${j.error_message?" — "+j.error_message:""}`});
    const rota=j.routes[0];
    const ordemOtimizada=rota.waypoint_order; // índices na ordem otimizada (referentes a `paradas`)
    const distanciaTotalM=rota.legs.reduce((s,l)=>s+l.distance.value,0);
    const duracaoTotalS=rota.legs.reduce((s,l)=>s+l.duration.value,0);
    const paradasOrdenadas=ordemOtimizada.map((ix,pos)=>({
      ...paradas[ix],
      distanciaProximaKm:+(rota.legs[pos].distance.value/1000).toFixed(1),
      duracaoProximaMin:Math.round(rota.legs[pos].duration.value/60),
    }));
    res.json({
      ok:true,
      ordemOtimizada, paradasOrdenadas,
      distanciaTotalKm:+(distanciaTotalM/1000).toFixed(1),
      duracaoTotalMin:Math.round(duracaoTotalS/60),
      polyline:rota.overview_polyline?.points||"",
    });
  }catch(e){ res.status(500).json({erro:e.message}); }
});


// processa a geocodificação em lotes (chamado sob demanda). Retorna progresso.
app.post("/api/vendedor/geocodificar",async(req,res)=>{
  try{
    if(!GOOGLE_MAPS_KEY) return res.status(500).json({erro:"Google Maps não configurado."});
    const lote=Math.min(Number(req.body?.lote||20),40); // quantos processar por chamada
    const geo=lerGeoClientes();
    // busca contatos do Bling (paginado) e geocodifica os que ainda não têm coordenada
    let processados=0, novos=0;
    for(let pg=1;pg<=20 && processados<lote;pg++){
      let arr=[];
      try{ const r=await bling(`/contatos?pagina=${pg}&limite=100`); arr=r?.data||[]; }catch(e){ break; }
      if(!arr.length) break;
      for(const c of arr){
        if(processados>=lote) break;
        const id=String(c.id);
        if(geo[id]&&geo[id].lat) continue; // já geocodificado
        if(geo[id]&&geo[id].semEndereco) continue; // já sabemos que não tem endereço
        // pega o detalhe pra ter o endereço completo
        let end=null;
        try{ const d=await bling(`/contatos/${id}`); const g=d?.data?.endereco?.geral; if(g&&g.endereco){ end=`${g.endereco}, ${g.numero||""}, ${g.bairro||""}, ${g.municipio||""} - ${g.uf||""}`; } }catch(e){}
        await new Promise(r=>setTimeout(r,150));
        if(!end){ geo[id]={semEndereco:true,nome:c.nome}; processados++; continue; }
        const coord=await geocodeEndereco(end);
        await new Promise(r=>setTimeout(r,150));
        if(coord){ geo[id]={lat:coord.lat,lng:coord.lng,nome:c.nome,endereco:end}; novos++; }
        else geo[id]={semCoord:true,nome:c.nome,endereco:end};
        processados++;
      }
      if(arr.length<100) break;
    }
    salvarGeoClientes(geo);
    const comCoord=Object.values(geo).filter(g=>g.lat).length;
    res.json({ok:true,processadosAgora:processados,novosComCoord:novos,totalComCoord:comCoord,totalRegistrados:Object.keys(geo).length});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// retorna todos os clientes geocodificados (pro mapa)
// busca cliente por nome direto no Bling; geocodifica na hora se ainda não tiver coordenada
app.get("/api/vendedor/buscar-cliente-mapa",async(req,res)=>{
  try{
    const termo=(req.query.nome||"").trim();
    if(termo.length<2) return res.json({clientes:[]});
    const termoLow=termo.toLowerCase();
    const achadosMap={};
    // 1) busca direta pelo termo no Bling
    try{ const r=await bling(`/contatos?pesquisa=${encodeURIComponent(termo)}&limite=100`); (r?.data||[]).forEach(c=>achadosMap[c.id]=c); }catch(e){}
    // 2) filtra os que contêm a palavra em qualquer parte do nome
    let achados=Object.values(achadosMap).filter(c=>(c.nome||"").toLowerCase().includes(termoLow));
    // 3) se não achou nada, varre páginas gerais procurando a palavra em qualquer parte
    if(!achados.length){
      for(let pg=1;pg<=12;pg++){
        let arr=[];
        try{ const r=await bling(`/contatos?pagina=${pg}&limite=100`); arr=r?.data||[]; }catch(e){ break; }
        if(!arr.length) break;
        arr.forEach(c=>{ if((c.nome||"").toLowerCase().includes(termoLow)) achadosMap[c.id]=c; });
        if(arr.length<100) break;
        await new Promise(r=>setTimeout(r,200));
      }
      achados=Object.values(achadosMap).filter(c=>(c.nome||"").toLowerCase().includes(termoLow));
    }
    achados=achados.slice(0,20);
    const geo=lerGeoClientes();
    const clientes=[];
    for(const c of achados){
      const id=String(c.id);
      let g=geo[id];
      // se ainda não tem coordenada, tenta geocodificar agora
      if(!g||!g.lat){
        let end=null;
        try{ const d=await bling(`/contatos/${id}`); const gr=d?.data?.endereco?.geral; if(gr&&gr.endereco){ end=`${gr.endereco}, ${gr.numero||""}, ${gr.bairro||""}, ${gr.municipio||""} - ${gr.uf||""}`; } }catch(e){}
        if(end){
          const coord=await geocodeEndereco(end);
          if(coord){ g={lat:coord.lat,lng:coord.lng,nome:c.nome,endereco:end}; geo[id]=g; }
          else g={semCoord:true,nome:c.nome,endereco:end};
        }
        await new Promise(r=>setTimeout(r,150));
      }
      clientes.push({id,nome:c.nome,lat:g?.lat||null,lng:g?.lng||null,endereco:g?.endereco||""});
    }
    salvarGeoClientes(geo);
    res.json({clientes});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

app.get("/api/vendedor/mapa-clientes",(req,res)=>{
  const geo=lerGeoClientes();
  const clientes=Object.entries(geo).filter(([id,g])=>g.lat).map(([id,g])=>({id,nome:g.nome,lat:g.lat,lng:g.lng,endereco:g.endereco||""}));
  res.json({clientes,total:clientes.length,totalRegistrados:Object.keys(geo).length});
});

// clientes próximos a um cliente específico (raio em km)
app.get("/api/vendedor/clientes-proximos/:id",(req,res)=>{
  const geo=lerGeoClientes();
  const base=geo[req.params.id];
  if(!base||!base.lat) return res.status(400).json({erro:"este cliente ainda não tem localização. Rode a geocodificação primeiro."});
  const raioKm=Number(req.query.raio||3);
  const proximos=Object.entries(geo)
    .filter(([id,g])=>g.lat && id!==req.params.id)
    .map(([id,g])=>({id,nome:g.nome,lat:g.lat,lng:g.lng,endereco:g.endereco||"",dist:+distanciaKm(base.lat,base.lng,g.lat,g.lng).toFixed(2)}))
    .filter(c=>c.dist<=raioKm)
    .sort((a,b)=>a.dist-b.dist);
  res.json({base:{id:req.params.id,nome:base.nome,lat:base.lat,lng:base.lng},raioKm,proximos});
});

// ===== PROSPECÇÃO DE NOVOS CLIENTES (Google Places) =====
// busca estabelecimentos (bares, restaurantes, etc.) perto da loja e marca quais
// já são clientes no Bling (por telefone). O Places é pago por uso — cache de 12h.
const PROSPECCAO_PLACES_FILE=`${DATA_DIR}/prospeccao_places.json`;
const LOJA_ENDERECO="AV. BRIGADEIRO EDUARDO GOMES, 1668, GLÓRIA, BELO HORIZONTE - MG";
let _lojaCoord=null;

async function geocodeLoja(){
  if(_lojaCoord) return _lojaCoord;
  const url=`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(LOJA_ENDERECO)}&key=${GOOGLE_MAPS_KEY}`;
  const r=await fetch(url).then(x=>x.json());
  const loc=r?.results?.[0]?.geometry?.location;
  if(loc){ _lojaCoord={lat:loc.lat,lng:loc.lng}; }
  return _lojaCoord;
}

// tipos de estabelecimento que compram bebida no atacado
const TIPOS_PROSPECCAO={
  bar:{label:"Bares",keyword:"bar"},
  restaurante:{label:"Restaurantes",keyword:"restaurante"},
  lanchonete:{label:"Lanchonetes",keyword:"lanchonete"},
  mercearia:{label:"Mercadinhos/Mercearias",keyword:"mercearia mercadinho"},
  adega:{label:"Adegas/Distribuidoras",keyword:"adega distribuidora de bebidas"},
  conveniencia:{label:"Conveniências",keyword:"loja de conveniência"},
};

app.get("/api/vendedor/prospeccao-places",async(req,res)=>{
  try{
    if(!GOOGLE_MAPS_KEY) return res.status(500).json({erro:"Google Maps não configurado no servidor."});
    const tipo=req.query.tipo||"bar";
    const raio=Math.min(Number(req.query.raio||3000),15000); // metros, máx 15km (raio máximo da busca)
    // raio mínimo (anel): se informado, filtra os resultados mais próximos que isso.
    // Ex.: raioMin=3000 & raio=5000 → só o que está ENTRE 3 e 5 km.
    const raioMin=Math.max(0,Number(req.query.raioMin||0));
    const forcar=req.query.forcar==="1";
    const cacheKey=`${tipo}_${raio}`;
    // cache de 12h por tipo+raio máximo (Places é pago). O filtro de raioMin é
    // aplicado depois, sobre o cache — então trocar só o mínimo não gasta a API.
    const cacheAll=lerJSON(PROSPECCAO_PLACES_FILE,{});
    let base=null;
    if(!forcar && cacheAll[cacheKey] && (Date.now()-cacheAll[cacheKey].em<12*60*60*1000)){
      base={...cacheAll[cacheKey].dados,doCache:true,cacheEm:cacheAll[cacheKey].em};
    }
    const coord=await geocodeLoja();
    if(!coord) return res.status(500).json({erro:"não consegui localizar o endereço da loja"});

    if(!base){
      const t=TIPOS_PROSPECCAO[tipo]||TIPOS_PROSPECCAO.bar;
      // Places API (New) — Text Search via POST com JSON e field mask no header
      const r=await fetch("https://places.googleapis.com/v1/places:searchText",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "X-Goog-Api-Key":GOOGLE_MAPS_KEY,
          "X-Goog-FieldMask":"places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.location,places.currentOpeningHours.openNow",
        },
        body:JSON.stringify({
          textQuery:t.keyword,
          languageCode:"pt-BR",
          locationBias:{circle:{center:{latitude:coord.lat,longitude:coord.lng},radius:raio}},
        }),
      }).then(x=>x.json());
      if(r.error){
        return res.status(500).json({erro:"Google Places: "+(r.error.message||r.error.status||"erro")});
      }
      const locais=(r.places||[]).map(p=>({
        placeId:p.id, nome:p.displayName?.text||"", endereco:p.formattedAddress||"",
        rating:p.rating||null, totalAvaliacoes:p.userRatingCount||0,
        lat:p.location?.latitude, lng:p.location?.longitude,
        aberto:p.currentOpeningHours?.openNow,
      }));
      const t2=TIPOS_PROSPECCAO[tipo]||TIPOS_PROSPECCAO.bar;
      base={tipo,tipoLabel:t2.label,raio,total:locais.length,locais,geradoEm:Date.now()};
      cacheAll[cacheKey]={em:Date.now(),dados:base};
      salvarJSON(PROSPECCAO_PLACES_FILE,cacheAll);
    }

    // calcula a distância de cada lugar até a loja e aplica o filtro de anel
    const comDist=(base.locais||[]).map(p=>({
      ...p,
      distanciaM: (p.lat!=null&&p.lng!=null) ? Math.round(distanciaMetros(coord.lat,coord.lng,p.lat,p.lng)) : null,
    }));
    let filtrados=comDist;
    if(raioMin>0){ filtrados=comDist.filter(p=>p.distanciaM==null || p.distanciaM>=raioMin); }
    // ordena por distância (mais perto primeiro)
    filtrados.sort((a,b)=>(a.distanciaM??1e9)-(b.distanciaM??1e9));

    res.json({...base, raioMin, total:filtrados.length, locais:filtrados});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// distância em metros entre duas coordenadas (fórmula de Haversine)
function distanciaMetros(lat1,lon1,lat2,lon2){
  const R=6371000, rad=Math.PI/180;
  const dLat=(lat2-lat1)*rad, dLon=(lon2-lon1)*rad;
  const a=Math.sin(dLat/2)**2 + Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

// detalhes de um lugar (telefone) — chamado só quando o vendedor clica, pra economizar
app.get("/api/vendedor/place-detalhe/:placeId",async(req,res)=>{
  try{
    if(!GOOGLE_MAPS_KEY) return res.status(500).json({erro:"Google Maps não configurado."});
    // Places API (New) — Place Details via GET /v1/places/{id} com field mask no header
    const r=await fetch(`https://places.googleapis.com/v1/places/${req.params.placeId}?languageCode=pt-BR`,{
      headers:{
        "X-Goog-Api-Key":GOOGLE_MAPS_KEY,
        "X-Goog-FieldMask":"displayName,nationalPhoneNumber,internationalPhoneNumber,formattedAddress,websiteUri",
      },
    }).then(x=>x.json());
    if(r.error) return res.status(500).json({erro:"Google Places: "+(r.error.message||"erro")});
    const tel=r.nationalPhoneNumber||r.internationalPhoneNumber||"";
    // verifica se já é cliente no Bling (busca pelo telefone)
    let jaCliente=null;
    if(tel){
      try{
        const digs=soDigitos(tel).slice(-8);
        const b=await bling(`/contatos?pesquisa=${encodeURIComponent(digs)}`);
        const achado=(b.data||[])[0];
        if(achado) jaCliente={id:achado.id,nome:achado.nome};
      }catch(e){}
    }
    res.json({nome:r.displayName?.text||"",telefone:tel,endereco:r.formattedAddress||"",website:r.websiteUri||"",jaCliente});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// ==================== PROSPECÇÃO 2 (busca ampla + contatos de uma vez) ====================
// Diferente da Prospecção 1 (tipos fixos + raio da loja), essa aceita:
//  - termo de busca LIVRE (ex: "distribuidora", "conveniência", "petiscaria")
//  - LOCAL livre (bairro/cidade digitados) OU raio da loja
// e já traz telefone + site de cada resultado de uma vez (sem clicar um a um),
// marca quem já é cliente e quem já foi contatado, e monta o WhatsApp pronto.
const PROSP2_CACHE_FILE=`${DATA_DIR}/prospeccao2_cache.json`;
const PROSP2_CONTATADOS_FILE=`${DATA_DIR}/prospeccao2_contatados.json`;

app.get("/api/vendedor/prospeccao2",async(req,res)=>{
  try{
    if(!GOOGLE_MAPS_KEY) return res.status(500).json({erro:"Google Maps não configurado no servidor."});
    const termo=(req.query.termo||"").toString().slice(0,80).trim();
    const local=(req.query.local||"").toString().slice(0,80).trim();
    const forcar=req.query.forcar==="1";
    const pageToken=(req.query.pageToken||"").toString().trim(); // "carregar mais 20"
    if(termo.length<2) return res.json({data:[]});

    // monta a query: termo + local (se informado). Se não tem local, usa raio da loja.
    const textQuery = local ? `${termo} em ${local}` : termo;
    const cacheKey=textQuery.toLowerCase();
    const cacheAll=lerJSON(PROSP2_CACHE_FILE,{});
    let base=null;
    // o cache só vale pra 1ª página (sem pageToken). "Carregar mais" sempre busca fresco.
    if(!pageToken && !forcar && cacheAll[cacheKey] && (Date.now()-cacheAll[cacheKey].em<12*60*60*1000)){
      base=cacheAll[cacheKey].dados;
    }

    if(!base){
      const body={ textQuery, languageCode:"pt-BR", pageSize:20 };
      // regra do Google: ao paginar (pageToken), os demais params devem ser IGUAIS
      // aos da 1ª chamada. O locationBias por loja é aplicado igual nos dois casos.
      if(!local){
        const coord=await geocodeLoja();
        if(coord) body.locationBias={circle:{center:{latitude:coord.lat,longitude:coord.lng},radius:8000}};
      }
      if(pageToken) body.pageToken=pageToken;
      // field mask AMPLIADO: já pede telefone e site na própria busca (1 chamada).
      // inclui nextPageToken pra permitir "carregar mais 20".
      const r=await fetch("https://places.googleapis.com/v1/places:searchText",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "X-Goog-Api-Key":GOOGLE_MAPS_KEY,
          "X-Goog-FieldMask":"places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.location,places.googleMapsUri,places.businessStatus,nextPageToken",
        },
        body:JSON.stringify(body),
      }).then(x=>x.json());
      if(r.error) return res.status(500).json({erro:"Google Places: "+(r.error.message||r.error.status||"erro")});
      const locais=(r.places||[]).map(p=>({
        placeId:p.id, nome:p.displayName?.text||"",
        endereco:p.formattedAddress||"",
        telefone:p.nationalPhoneNumber||p.internationalPhoneNumber||"",
        website:p.websiteUri||"",
        mapsUrl:p.googleMapsUri||"",
        rating:p.rating||null, totalAvaliacoes:p.userRatingCount||0,
        aberto:p.businessStatus==="OPERATIONAL",
        lat:p.location?.latitude, lng:p.location?.longitude,
      }));
      base={termo,local,textQuery,total:locais.length,locais,geradoEm:Date.now(),nextPageToken:r.nextPageToken||null};
      // só cacheia a 1ª página (as próximas são sob demanda)
      if(!pageToken){ cacheAll[cacheKey]={em:Date.now(),dados:base}; salvarJSON(PROSP2_CACHE_FILE,cacheAll); }
    }

    // enriquece: marca quem já é cliente (por telefone) e quem já foi contatado
    const contatados=lerJSON(PROSP2_CONTATADOS_FILE,{});
    const resultado=[];
    for(const p of (base.locais||[])){
      let jaCliente=null;
      if(p.telefone){
        try{
          const digs=soDigitos(p.telefone).slice(-8);
          if(digs.length>=8){
            const b=await bling(`/contatos?pesquisa=${encodeURIComponent(digs)}`);
            const achado=(b.data||[])[0];
            if(achado) jaCliente={id:achado.id,nome:achado.nome};
          }
        }catch(e){}
      }
      resultado.push({...p, jaCliente, jaContatado:!!contatados[p.placeId], contatadoEm:contatados[p.placeId]?.em||null});
      if(p.telefone) await new Promise(r=>setTimeout(r,120)); // respeita o Bling
    }
    res.json({...base, data:resultado, total:resultado.length});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// marca/desmarca um estabelecimento como "já contatado" (fica salvo)
app.post("/api/vendedor/prospeccao2/contatado",(req,res)=>{
  try{
    const {placeId,nome,contatado}=req.body||{};
    if(!placeId) return res.status(400).json({erro:"placeId obrigatório"});
    const c=lerJSON(PROSP2_CONTATADOS_FILE,{});
    if(contatado===false){ delete c[placeId]; }
    else { c[placeId]={nome:nome||"",em:Date.now()}; }
    salvarJSON(PROSP2_CONTATADOS_FILE,c);
    res.json({ok:true});
  }catch(e){ res.status(500).json({erro:e.message}); }
});


// telefone de um cliente (pra montar o WhatsApp de recuperação)
// busca um pedido pelo NÚMERO (ou id) já com telefone do cliente, itens e formas — pra
// o vendedor mandar a notinha pro cliente pelo WhatsApp
app.get("/api/vendedor/pedido-para-envio/:numero",async(req,res)=>{
  try{
    const n=String(req.params.numero).trim();
    let ped=await bling(`/pedidos/vendas/${n}`).then(r=>r?.data).catch(()=>null);
    if(!ped){ try{ const r=await bling(`/pedidos/vendas?numero=${encodeURIComponent(n)}`); const a=(r?.data||[])[0]; if(a?.id) ped=await bling(`/pedidos/vendas/${a.id}`).then(x=>x?.data); }catch(e){} }
    if(!ped) return res.status(404).json({erro:"pedido não encontrado"});
    let telefone="", nomeCli=ped.contato?.nome||"";
    if(ped.contato?.id){ try{ const c=await bling(`/contatos/${ped.contato.id}`).then(r=>r?.data); telefone=c?.celular||c?.telefone||""; nomeCli=c?.nome||nomeCli; }catch(e){} }
    const formas=[];
    for(const pc of (ped.parcelas||[])){ formas.push({forma:await nomeFormaPagamentoId(pc.formaPagamento?.id), valor:Number(pc.valor)||0}); }
    res.json({
      id:ped.id, numero:ped.numero, data:ped.data, total:Number(ped.total)||0,
      frete:Number(ped.transporte?.frete||0), desconto:Number(ped.desconto?.valor||0),
      cliente:{ id:ped.contato?.id||null, nome:nomeCli, telefone },
      itens:(ped.itens||[]).map(it=>({nome:it.descricao||it.produto?.nome||"produto", quantidade:Number(it.quantidade)||0, valor:Number(it.valor)||0})),
      formas, situacao:nomeSituacao(ped.situacao?.id),
    });
  }catch(e){ res.status(e.status||500).json({erro:e.message}); }
});

app.get("/api/vendedor/cliente/:id/contato",async(req,res)=>{
  try{
    const r=await bling(`/contatos/${req.params.id}`);
    const d=r?.data||{};
    res.json({nome:d.nome||"",telefone:d.telefone||d.celular||""});
  }catch(e){ res.json({nome:"",telefone:"",erro:e.message}); }
});

// quem mais compra um produto (busca por nome do produto) — atacado only
app.get("/api/vendedor/top-produto",async(req,res)=>{
  try{
    const nomeProd=(req.query.nome||"").trim().toLowerCase();
    if(nomeProd.length<2) return res.json({data:[]});
    const agora=Date.now();
    const dataIni=new Date(agora-120*24*60*60*1000).toISOString().slice(0,10);
    const dataFim=new Date(agora+24*60*60*1000).toISOString().slice(0,10);
    const pedidos=[];
    for(let pg=1;pg<=40;pg++){
      const p=new URLSearchParams({pagina:pg,limite:100,dataInicial:dataIni,dataFinal:dataFim});
      let arr=[];
      try{ const r=await bling(`/pedidos/vendas?${p.toString()}`); arr=r?.data||[]; }catch(e){ break; }
      pedidos.push(...arr);
      if(arr.length<100) break;
      await new Promise(r=>setTimeout(r,300));
    }
    const atacado=pedidos.filter(p=>{
      const vend=Number(p.vendedor?.id||0), cont=Number(p.contato?.id||0), sit=Number(p.situacao?.id||0);
      return !VENDEDORES_VAREJO.includes(vend) && cont!==CONSUMIDOR_FINAL_ID && sit!==12;
    });
    // busca detalhe dos pedidos pra ver os itens (limita a 60 pedidos mais recentes)
    const recentes=atacado.sort((a,b)=>String(b.data).localeCompare(String(a.data))).slice(0,60);
    const porCliente={};
    for(const ped of recentes){
      try{
        const d=await bling(`/pedidos/vendas/${ped.id}`); const itens=d?.data?.itens||[];
        const temProd=itens.some(it=>(it.descricao||"").toLowerCase().includes(nomeProd));
        if(temProd){
          const cid=ped.contato?.id; if(!cid) continue;
          const qtd=itens.filter(it=>(it.descricao||"").toLowerCase().includes(nomeProd)).reduce((s,it)=>s+Number(it.quantidade||0),0);
          if(!porCliente[cid]) porCliente[cid]={id:cid,nome:ped.contato?.nome||"—",qtdTotal:0,pedidos:0};
          porCliente[cid].qtdTotal+=qtd; porCliente[cid].pedidos++;
        }
      }catch(e){}
      await new Promise(r=>setTimeout(r,120));
    }
    const top=Object.values(porCliente).sort((a,b)=>b.qtdTotal-a.qtdTotal).slice(0,20);
    res.json({data:top});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// MIGRAÇÃO (roda uma vez): cada aba do menu passou a ter uma permissão EXCLUSIVA.
// Antes, várias abas compartilhavam a mesma ação (ex: acesso_propostas valia pra
// Central, Avisos, Propostas, Gestão de NFC-e e Entradas) — por isso marcar uma
// marcava várias. Aqui converto o acesso que cada funcionário JÁ TINHA em permissões
// explícitas por aba, pra ninguém perder acesso na virada.
function migrarPermissoesPorAba(){
  try{
    const marcaFile=`${DATA_DIR}/_migracao_perms_v2.json`;
    if(fs.existsSync(marcaFile)) return;
    const funcs=lerJSON(FUNC_FILE,{});
    const links=[
      // (href, ação própria nova, ações que ANTES davam acesso a essa aba)
      ["/central","acesso_central",["acesso_propostas","receber_pagamento","editar_pedido"]],
      ["/avisos","acesso_avisos",["acesso_propostas","receber_pagamento","editar_pedido"]],
      ["/pedidos-online","acesso_pedidos_online",["ver_aguardando","acesso_propostas","editar_pedido"]],
      ["/gestao-nfce","acesso_gestao_nfce",["acesso_propostas","receber_pagamento","editar_pedido"]],
      ["/estoque","acesso_estoque_painel",["acesso_estoque","editar_pedido"]],
      ["/entrada-estoque","acesso_entrada_estoque",["acesso_estoque","editar_pedido"]],
      ["/entradas","acesso_entradas_nf",["acesso_propostas","receber_pagamento","editar_pedido"]],
    ];
    let mudou=0;
    Object.values(funcs).forEach(f=>{
      if(!f||!Array.isArray(f.permissoes)) return;
      if(f.permissoes.includes("admin")) return; // admin já vê tudo
      links.forEach(([href,propria,antigas])=>{
        if(f.permissoes.includes(propria)) return;
        const tinhaAcesso=antigas.some(a=>b13PodeComPermissoes(a,f.permissoes));
        if(tinhaAcesso){ f.permissoes.push(propria); mudou++; }
      });
    });
    if(mudou) salvarJSON(FUNC_FILE,funcs);
    salvarJSON(marcaFile,{em:Date.now(),permissoesAdicionadas:mudou});
    console.log(`[migração] permissões por aba: ${mudou} permissão(ões) preservadas`);
  }catch(e){ console.error("[migração] falhou:",e.message); }
}
migrarPermissoesPorAba();

// limpeza única: resolve os avisos antigos de "venda sem NFC-e" (esse aviso foi
// removido — agora só avisamos quando a emissão é tentada e falha)
(function limparAvisosNfcePendente(){
  try{
    const marca=`${DATA_DIR}/_limpeza_avisos_nfce.json`;
    if(fs.existsSync(marca)) return;
    const d=lerAvisos(); let n=0;
    (d.lista||[]).forEach(a=>{ if(!a.resolvido && a.tipo==="nfce_pendente_velha"){ a.resolvido=true; a.resolvidoEm=Date.now(); a.resolvidoPor="sistema (aviso descontinuado)"; n++; } });
    if(n) salvarAvisos(d);
    salvarJSON(marca,{em:Date.now(),resolvidos:n});
    if(n) console.log(`[limpeza] ${n} aviso(s) de NFC-e pendente resolvidos (aviso descontinuado)`);
  }catch(e){}
})();

app.listen(PORT,()=> console.log(`B13 Bling Backend na porta ${PORT} (DATA_DIR=${DATA_DIR})`));

// auditoria geral roda sozinha a cada 30 min (além de poder ser disparada manualmente
// em /api/auditoria/rodar). Espera 1 min após o boot pra não competir com o startup.
let _auditoriaRodando=false;
setTimeout(()=>{
  const rodar=async()=>{ if(_auditoriaRodando) return; _auditoriaRodando=true; try{ await rodarAuditoriaGeral(1); }catch(e){ console.error("Auditoria automática falhou:",e.message); } _auditoriaRodando=false; };
  rodar();
  setInterval(rodar, 30*60*1000);
}, 60*1000);
