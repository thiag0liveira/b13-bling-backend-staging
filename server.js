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
let _blingFila=Promise.resolve();
const BLING_INTERVALO_MIN=340; // ms entre quaisquer duas chamadas ao Bling (~2,9/s, o limite documentado é 3/s)
let _blingUltimaChamada=0;
function bling(path,options={}){
  const rodar=async()=>{
    const espera=Math.max(0,_blingUltimaChamada+BLING_INTERVALO_MIN-Date.now());
    if(espera>0) await new Promise(r=>setTimeout(r,espera));
    _blingUltimaChamada=Date.now();
    return blingRaw(path,options);
  };
  const resultado=_blingFila.then(rodar,rodar);
  _blingFila=resultado.catch(()=>{}); // não deixa um erro travar a fila pros próximos
  return resultado;
}
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
  {href:"/operacional",label:"⚙️ Operacional",acoes:["acesso_operacional","ver_aguardando","ver_separacao","conferir"]},
  {href:"/painel-pedidos",label:"📺 Painel de Pedidos",acoes:["acesso_painel_pedidos","ver_aguardando","ver_separacao","conferir"]},
  {href:"/caixa",label:"💳 Caixa",acoes:["acesso_caixa","receber_pagamento"]},
  {href:"/caixa-diario",label:"📅 Relatório Diário",acoes:["acesso_caixa_diario","receber_pagamento"]},
  {href:"/frente-caixa",label:"🧾 Frente de Caixa",acoes:["acesso_frente_caixa","receber_pagamento"]},
  {href:"/caixa-atacado",label:"🧾 Caixa Atacado",acoes:["acesso_caixa_atacado","receber_pagamento"]},
  {href:"/gestao-caixas",label:"🗃️ Gestão de Caixas",acoes:["acesso_gestao_caixas"]},
  {href:"/venda-atacado",label:"🛒 Venda Atacado",acoes:["acesso_venda_atacado","receber_pagamento","editar_pedido"]},
  {href:"/propostas",label:"📄 Propostas",acoes:["acesso_propostas","receber_pagamento","editar_pedido"]},
  {href:"/vendedor",label:"🎯 Apoio ao Vendedor",acoes:["acesso_vendedor","receber_pagamento","editar_pedido"]},
  {href:"/lista-fardo",label:"📋 Lista de Fardo",acoes:["acesso_lista_fardo","editar_pedido"]},
  {href:"/etiquetas",label:"🏷 Etiquetas",acoes:["acesso_etiquetas","editar_pedido"]},
  {href:"/listas-extras",label:"📂 Listas Extras",acoes:["acesso_listas_extras","editar_pedido"]},
  {href:"/expedicao",label:"🚚 Expedição",acoes:["acesso_expedicao","ver_separacao"]},
  {href:"/conferencia",label:"🔍 Conferência",acoes:["acesso_conferencia","conferir"]},
  {href:"/dashboard",label:"📊 Dashboard",acoes:["acesso_dashboard","ver_dashboard"]},
  {href:"/perdas",label:"📉 Perdas (danif./não entregue)",acoes:["acesso_perdas","ver_dashboard"]},
  {href:"/gestao",label:"📋 Gestão",acoes:["acesso_gestao","editar_pedido"]},
  {href:"/rotas",label:"🗺️ Gerenciamento de Rota",acoes:["acesso_rotas","editar_pedido"]},
  {href:"/estoque",label:"📦 Ajuste de Estoque",acoes:["acesso_estoque","editar_pedido","admin"]},
  {href:"/movimentacoes",label:"🔄 Movimentações",acoes:["acesso_movimentacoes","editar_pedido","admin"]},
  {href:"/tabela-atacado",label:"🗂️ Tabela Atacado",acoes:["acesso_tabela","ver_listas"]},
  {href:"/listas",label:"📄 Listas de Preço",acoes:["acesso_listas_preco","ver_listas"]},
  {href:"/funcionarios",label:"👥 Funcionários",acoes:["ver_funcionarios"]},
  {href:"/imagens",label:"📷 Imagens",acoes:["acesso_imagens","admin"]},
];

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
      <div style="flex:1;text-align:right;font-size:13px;color:#fff;font-weight:700">\${nomeTopo} <span style="color:#9a95c9;font-weight:400;font-size:11px">· \${f.nivel}</span></div>
    </div>
    <div id="b13nav" style="position:fixed;top:0;left:0;bottom:0;width:200px;background:linear-gradient(180deg,#2b2870,#262366);border-right:2px solid #FF0082;display:flex;flex-direction:column;z-index:100;transform:translateX(-100%);transition:.25s">
    <div style="padding:14px 12px;border-bottom:1px solid rgba(255,0,130,.3)">
      <div style="font-weight:900;font-size:13px;color:#fff">\${f.nome}</div>
      <div style="font-size:11px;color:#9a95c9">\${f.nivel}</div>
    </div>
    <nav style="flex:1;padding:8px 0;overflow-y:auto">
      \${links.map(l=>\`<a href="\${l.href}" style="display:flex;align-items:center;gap:8px;padding:11px 14px;color:\${l.href===ativo?'#fff':'#cfc9f5'};text-decoration:none;font-weight:700;font-size:13px;border-left:3px solid \${l.href===ativo?'#FF0082':'transparent'};background:\${l.href===ativo?'rgba(255,0,130,.1)':'transparent'}">\${l.label}</a>\`).join('')}
    </nav>
    <div style="padding:10px 12px;border-top:1px solid rgba(255,0,130,.3)">
      <button onclick="b13Logout()" style="width:100%;padding:8px;border:1px solid #514c96;border-radius:8px;background:transparent;color:#9a95c9;cursor:pointer;font-size:12px">Sair</button>
    </div>
  </div>
  <button onclick="b13ToggleNav()" style="position:fixed;top:6px;left:12px;z-index:101;background:#262366;border:1px solid #FF0082;border-radius:8px;color:#fff;padding:6px 10px;cursor:pointer;font-size:18px">☰</button>
  <div id="b13navOverlay" onclick="b13ToggleNav()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99"></div>
  <div id="b13qrModal"></div>\`;
}

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
async function atualizarParcelasBling(id,parcelas,opts={}){
  const SIT_EM_DIGITACAO=21;
  const STATUS_BLOQUEADOS=[SIT.EM_SEP,SIT.SEP_PEND,SIT.SEPARADO,SIT.CONF_ENTREGA,SIT.EM_ROTA,SIT.ATENDIDO];
  try{
    const rPed=await bling(`/pedidos/vendas/${id}`);
    const ped=rPed?.data; if(!ped) return {ok:false,erro:"pedido não encontrado"};
    const sitAtual=ped.situacao?.id;
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

    let resultado, fezUnlock=false;
    try{
      resultado=await bling(`/pedidos/vendas/${id}`,{method:"PUT",body:JSON.stringify(payload)});
    }catch(e1){
      // qualquer erro na 1ª tentativa, se o pedido estava numa situação bloqueada,
      // tenta o caminho de desbloquear/editar/restaurar — antes só tentava quando
      // o erro vinha com status exatamente 400, mas o Bling nem sempre retorna
      // esse código pra "situação bloqueada", o que fazia falhar silenciosamente
      // (o pagamento ficava salvo aqui no sistema, mas não ia pro Bling)
      if(!precisaUnlock) throw e1;
      // situação bloqueada — desbloqueia via Em Digitação, edita, depois restaura
      await bling(`/pedidos/vendas/${id}/situacoes/${SIT_EM_DIGITACAO}`,{method:"PATCH"});
      fezUnlock=true;
      await new Promise(r=>setTimeout(r,400));
      try{
        resultado=await bling(`/pedidos/vendas/${id}`,{method:"PUT",body:JSON.stringify(payload)});
      }finally{
        // sempre restaura a situação original, mesmo se o PUT falhar
        await new Promise(r=>setTimeout(r,400));
        for(let t=0;t<3;t++){
          try{
            if(sitAtual===SIT.ATENDIDO){
              // não pula direto pra Atendido: caminha Separado -> Atendido
              await bling(`/pedidos/vendas/${id}/situacoes/${SIT.SEPARADO}`,{method:"PATCH"});
              await new Promise(r=>setTimeout(r,400));
              await bling(`/pedidos/vendas/${id}/situacoes/${SIT.ATENDIDO}`,{method:"PATCH"});
            }else{
              await bling(`/pedidos/vendas/${id}/situacoes/${sitAtual}`,{method:"PATCH"});
            }
            break;
          }
          catch(e){ await new Promise(r=>setTimeout(r,600*(t+1))); }
        }
      }
    }
    return {ok:true,resposta:resultado,fezUnlock};
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
        porId[p.produtoId]={id:p.produtoId,nome:p.nome,codigo:p.codigo,estoque:null};
      }
    });

    // 2) SEMPRE consulta o Bling também — assim produtos cadastrados depois da
    //    última reconstrução do índice já aparecem, sem precisar atualizar nada.
    //    Filtra pelo termo pra descartar a lista genérica que o Bling devolve.
    try{
      const d=await bling(`/produtos?nome=${encodeURIComponent(nome)}&limite=100`);
      (d.data||[]).forEach(p=>{ if((p.nome||"").toLowerCase().includes(t)) porId[p.id]={id:p.id,nome:p.nome,codigo:p.codigo,estoque:p.estoque?.saldoVirtualTotal ?? null}; });
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
        const sabores=(it.bling||[]).map(b=>{ const e=est[String(b.codigo)];
          return {codigo:b.codigo, id:(e&&e.id)||b.id||null, nome:b.nome||(e&&e.nome)||"", estoque:e?e.estoque:(b.estoque??null), imagem:(e&&e.imagem)||""}; });
        const estoqueTotal = sabores.length ? sabores.reduce((s,x)=>s+(x.estoque||0),0) : null;
        const imagem = (sabores.find(s=>s.imagem)||{}).imagem || "";
        // usa o id interno da tabela + primeiro código Bling como id único do produto
        const prodId = it.id + "_" + (sabores[0]?.codigo||"0");
        cats[c.t].produtos.push({id:prodId,nome:it.nome,obs:it.obs||"",preco:it.preco,un:it.caixa||1,sabores,estoqueTotal,imagem});
      });
    });
    res.json({categorias:Object.values(cats), meta:tab.meta||{}, atualizadoEm:tab.publicadoEm||null});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

// ------------------------- Contatos / Pedido -------------------------
app.get("/api/contatos/:id",async(req,res)=>{
  try{ res.json(await bling(`/contatos/${req.params.id}`)); }
  catch(e){ res.status(e.status||500).json({erro:e.message}); }
});
app.get("/api/contatos",rateLimit({janelaMs:60000,max:8,prefixo:"contatos"}),async(req,res)=>{
  try{ const doc=soDigitos(req.query.doc); if(!doc) return res.status(400).json({erro:"?doc=CPF_ou_CNPJ"});
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
      for(const m of (s.movimentos||[])){
        if(m.tipo==="venda" && String(m.pedidoId)===idStr){
          m.alterado=true;
          if(opts.cancelado) m.cancelado=true;
          m.alteracoes=[...(m.alteracoes||[]), alteracao];
          if(Array.isArray(novosPagamentos)&&novosPagamentos.length) m.pagamentos=novosPagamentos;
          achou=true;
        }
      }
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
  const {tipo,valor,motivo,operador,funcionarioId,tipoCaixa}=req.body||{};
  if(!["sangria","suprimento"].includes(tipo)) return res.status(400).json({erro:"tipo deve ser sangria ou suprimento"});
  const v=+Number(valor||0).toFixed(2);
  if(!(v>0)) return res.status(400).json({erro:"informe um valor maior que zero"});
  const d=lerCaixaSessoes();
  const tc=tipoCaixa||"frente";
  const sessao=(d.sessoes||[]).find(s=>!s.fechadaEm&&s.funcionarioId===funcionarioId&&(s.tipoCaixa||"frente")===tc);
  if(!sessao) return res.status(400).json({erro:"Nenhum caixa aberto pra esse usuário"});
  sessao.movimentos.push({tipo,valor:v,motivo:motivo||"",operador:operador||"—",em:Date.now()});
  salvarCaixaSessoes(d);
  res.json({ok:true,resumo:resumoSessaoCaixa(sessao)});
});

// fecha o caixa, comparando o contado com o esperado (conferência)
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
    const info={itemId:it.id, categoria:cat.t||"", precoAtacado:it.preco??null,
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
    const totalPedido=Number(ped.total||0);

    // descrição do pagamento ANTES: usa o histórico local (tem nome+valor); senão, as parcelas do Bling
    const pags=lerPag(); const idStr=String(pedidoId); const antigo=pags[idStr]||null;
    let descAntes="";
    if(antigo&&Array.isArray(antigo.historico)&&antigo.historico.length){
      descAntes=antigo.historico.map(h=>`${h.formaNome||"?"}: ${fmt(h.valor)}`).join(" · ");
    }else{
      descAntes=(ped.parcelas||[]).map(p=>`${p.formaPagamento?.nome||"?"}: ${fmt(p.valor)}`).join(" · ");
    }
    descAntes=descAntes||"—";

    // troca as parcelas no Bling (substitui). atualizarParcelasBling sabe destravar
    // o SEPARADO (via Em Digitação), editar e restaurar a situação.
    const funcsNome=(lerJSON(FUNC_FILE,{})[funcionarioId]?.nome)||"—";
    const quando=new Date().toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"});
    const descDepoisPre=linhas.map(p=>`${p.formaNome||"?"}: ${fmt(p.valor)}`).join(" · ");
    const notaObs=`[Alteração ${quando} — ${funcsNome}, autoriz. ${auth.funcionario.nome}] Pagamento: ${descAntes} -> ${descDepoisPre}`;
    const rBling=await atualizarParcelasBling(pedidoId, linhas.map(p=>({valor:Number(p.valor),formaId:p.formaId})), {obsExtra:notaObs});
    if(!rBling.ok) return res.status(502).json({erro:"Falha ao atualizar no Bling: "+(rBling.erro||"desconhecido")});

    // atualiza registro local de pagamento (mantém pago)
    const somaNova=+linhas.reduce((s,p)=>s+Number(p.valor),0).toFixed(2);
    const historico=linhas.map(p=>({em:Date.now(),valor:+Number(p.valor).toFixed(2),formaNome:p.formaNome||"",tipo:"caixa_atacado_edit"}));
    const valorPedido=(antigo&&antigo.valorPedido)?antigo.valorPedido:totalPedido;
    pags[idStr]={
      ...(antigo||{}), pedidoId:idStr, valorPago:somaNova, valorPedido, historico,
      statusPagamento: somaNova>=valorPedido-0.05?"pago":(somaNova>0?"parcial":"pendente"),
    };
    salvarJSON(PAG_FILE,pags);

    // marca o movimento no histórico do caixa (vermelho, com o que mudou)
    const funcs=lerJSON(FUNC_FILE,{});
    const descDepois=linhas.map(p=>`${p.formaNome||"?"}: ${fmt(p.valor)}`).join(" · ");
    const alteracao={
      em:Date.now(), tipo:"pagamento",
      autorizadoPor:auth.funcionario.nome,
      por:(funcs[funcionarioId]?.nome)||"—",
      de:descAntes, para:descDepois,
    };
    const achouMov=marcarMovimentoAlterado(idStr, linhas.map(p=>({formaNome:p.formaNome||"",valor:+Number(p.valor).toFixed(2)})), alteracao);
    addLog(idStr,"pagamento_editado_caixa",funcionarioId,alteracao.por,{autorizadoPor:auth.funcionario.nome,de:descAntes,para:descDepois});

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
          alterado:true, alteracoes:[alteracao],
        });
        salvarCaixaSessoes(dCx);
        incluidoNoCaixa={operador:sAberta.operador||"", sessaoId:sAberta.id};
        addLog(idStr,"pedido_incluido_no_caixa",funcionarioId,alteracao.por,{caixaDe:sAberta.operador||"",motivo:"pedido não pertencia a nenhum caixa"});
      }
    }

    res.json({ok:true, autorizadoPor:auth.funcionario.nome, de:descAntes, para:descDepois, numero:numero||ped.numero, movimentoAtualizado:achouMov, incluidoNoCaixa});
  }catch(e){ res.status(500).json({erro:e.message}); }
});

// CANCELAR uma venda JÁ FINALIZADA — só com autorização de gerente/financeiro/admin (QR).
// Move o pedido pra CANCELADO no Bling, zera o pagamento local e marca o movimento
// como CANCELADO no histórico do caixa (some do total, aparece em vermelho).
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

app.post("/api/pdv/venda", async(req,res)=>{
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

    // registra localmente (mesmo padrão usado no restante do sistema)
    const pags=lerPag();
    const historico=pagamentos.map(p=>({em:Date.now(),valor:+Number(p.valor).toFixed(2),formaNome:p.formaNome||"",tipo:"pdv_varejo"}));
    const _outrasPagNova=+Number(req.body.taxaCredito||0).toFixed(2);
    const _totalPagarNova=+(totalPedido+_outrasPagNova).toFixed(2);
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
        sessaoAtual.movimentos.push({
          tipo:"venda", em:Date.now(), pedidoId, numero:criado?.data?.numero,
          total:+(totalPedido+_outrasNova).toFixed(2), clienteNome:clienteNome||"", desconto:totalDesconto,
          outrasDespesas:_outrasNova, operador:sessaoAtual.operador||"",
          itens:(itens||[]).map(i=>({produtoId:i.produtoId,nome:i.nome||"",quantidade:Number(i.quantidade),valor:Number(i.valor)})),
          pagamentos:pagamentos.map(p=>({formaNome:p.formaNome||"",valor:+Number(p.valor).toFixed(2)})),
        });
        salvarCaixaSessoes(dCx);
      }
    }catch(e){ console.error("Falha ao vincular venda à sessão de caixa (ignorado):",e.message); }

    let nfce=null;
    if(emitirNfce){
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

    res.json({ok:true,pedidoId,numero:criado?.data?.numero,total:totalPedido,nfce,estoqueReposto});
  }catch(e){ res.status(e.status||500).json({erro:e.message,detalhe:e.body}); }
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
async function moverPedidoParaAtendido(pedidoId){
  const lerSit=async()=>{ try{ const d=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data); return Number(d?.situacao?.id||0); }catch(e){ return 0; } };
  const patch=async(sitId)=>{ await bling(`/pedidos/vendas/${pedidoId}/situacoes/${sitId}`,{method:"PATCH"}); };
  const caminho=[];
  let sitAtual=await lerSit();
  if(sitAtual===SIT.ATENDIDO) return {ok:true, situacaoFinal:SIT.ATENDIDO, caminho:["já estava atendido"]};

  // REGRA DO NEGÓCIO: o pedido NÃO pode pular direto pra Atendido — tem que caminhar
  // SEPARADO -> ATENDIDO. Então sempre garantimos o Separado antes.
  if(sitAtual!==SIT.SEPARADO){
    try{ await patch(SIT.SEPARADO); caminho.push("→ Separado"); await sleep(500); }
    catch(e){ caminho.push("falhou → Separado: "+e.message); }
    let s=await lerSit();
    // se o Bling não deixou ir direto pra Separado, passa por Em separação antes
    if(s!==SIT.SEPARADO){
      try{
        await patch(SIT.EM_SEP); caminho.push("→ Em separação"); await sleep(500);
        await patch(SIT.SEPARADO); caminho.push("→ Separado (após Em separação)"); await sleep(500);
      }catch(e){ caminho.push("falhou cascata Separado: "+e.message); }
    }
  }

  // agora Separado -> Atendido
  try{ await patch(SIT.ATENDIDO); caminho.push("→ Atendido (após Separado)"); await sleep(400); }
  catch(e){ caminho.push("falhou → Atendido: "+e.message); }
  let novo=await lerSit();
  return {ok:novo===SIT.ATENDIDO, situacaoFinal:novo, caminho};
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

app.post("/api/caixa-atacado/finalizar",async(req,res)=>{
  try{
    const {pedidoId,itens,pagamentos,emitirNfce,funcionarioId,clienteNome,observacao,statusFinal,taxaCredito,outrasDespesasBase}=req.body||{};
    if(!pedidoId) return res.status(400).json({erro:"informe o pedido"});
    if(!Array.isArray(pagamentos)||!pagamentos.length) return res.status(400).json({erro:"Informe ao menos uma forma de pagamento"});

    // 0) GARANTE ESTOQUE: define os itens efetivos da venda (os enviados pela tela,
    //    ou os do pedido no Bling) e lança entrada do que faltar, pra o Bling não
    //    barrar a finalização por saldo insuficiente. Repõe só o que falta.
    let itensParaEstoque = Array.isArray(itens)&&itens.length ? itens : null;
    if(!itensParaEstoque){
      try{
        const p=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data);
        itensParaEstoque=(p?.itens||[]).map(i=>({produtoId:i.produto?.id,nome:i.descricao||"",quantidade:i.quantidade}));
      }catch(e){ itensParaEstoque=[]; }
    }
    let estoqueReposto=[];
    try{ estoqueReposto=await garantirEstoqueParaItens(itensParaEstoque); }
    catch(e){ console.error("Falha ao garantir estoque (segue mesmo assim):",e.message); }

    // 1) Descobre se os itens realmente MUDARAM. Se o operador só está recebendo o
    //    pagamento (sem editar itens/preços), NÃO reenviamos os itens ao Bling — isso
    //    evita disparar a validação de estoque do Bling à toa (que barra quantidades
    //    grandes mesmo em pedido já existente). Só regravamos quando houve edição.
    const temItens=Array.isArray(itens)&&itens.length;
    const temObs=observacao&&String(observacao).trim();
    let itensMudaram=false;
    let pedAtual=null;
    if(temItens){
      try{ pedAtual=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data); }catch(e){}
      if(pedAtual){
        const orig={};
        (pedAtual.itens||[]).forEach(i=>{ if(i.produto?.id) orig[String(i.produto.id)]={q:Number(i.quantidade),v:Number(i.valor)}; });
        // mudou se: quantidade de itens difere, ou algum item novo/removido, ou qtd/preço diferentes
        if((pedAtual.itens||[]).length!==itens.length){ itensMudaram=true; }
        else {
          for(const it of itens){
            const o=orig[String(it.produtoId)];
            if(!o || o.q!==Number(it.quantidade) || Math.abs(o.v-Number(it.valor))>0.001){ itensMudaram=true; break; }
          }
        }
      } else {
        itensMudaram=true; // não conseguiu ler o atual — por segurança tenta salvar
      }
    }

    if(temItens && itensMudaram){
      const r=await atualizarItensBling(pedidoId, itens.map(i=>({produtoId:i.produtoId,quantidade:i.quantidade,valor:i.valor})), temObs?observacao:null);
      if(!r?.ok){
        let m=r?.erro||"erro";
        // deixa a mensagem de estoque mais clara e acionável
        if(/estoque|saldo.*insuficiente/i.test(m)){
          m="Estoque insuficiente no Bling pra um ou mais produtos deste pedido. "+
            "Ajuste o estoque no Bling (ou a config de baixa de estoque da situação) e tente de novo. Nada foi finalizado.";
        }
        return res.status(502).json({erro:m, estoqueInsuficiente:/estoque|saldo/i.test(String(r?.erro||""))});
      }
    } else if(temObs){
      // sem edição de itens: salva só a observação (PUT leve, não mexe em quantidades)
      try{
        const ped=pedAtual||await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data);
        if(ped){
          const obsAtual=ped.observacoes||"";
          const oe=String(observacao).trim();
          const nova=obsAtual && !obsAtual.includes(oe) ? obsAtual+"\n"+oe : (obsAtual||oe);
          await bling(`/pedidos/vendas/${pedidoId}`,{method:"PUT",body:JSON.stringify({
            data:ped.data,
            ...(ped.contato?.id?{contato:{id:ped.contato.id}}:{}),
            ...(ped.vendedor?.id?{vendedor:{id:ped.vendedor.id}}:{}),
            itens:(ped.itens||[]).map(i=>({produto:{id:i.produto?.id},quantidade:i.quantidade,valor:i.valor})),
            observacoes:nova,
          })});
        }
      }catch(e){ console.error("Falha ao salvar observação (ignorado):",e.message); }
    }

    // 2) recalcula o total a partir dos itens finais (ou usa o total enviado)
    const totalPedido = Array.isArray(itens)&&itens.length
      ? +itens.reduce((s,i)=>s+Number(i.valor)*Number(i.quantidade),0).toFixed(2)
      : +Number(req.body.total||0).toFixed(2);

    // 3) registra o pagamento localmente
    const pags=lerPag();
    const historico=pagamentos.map(p=>({em:Date.now(),valor:+Number(p.valor).toFixed(2),formaNome:p.formaNome||"",tipo:"caixa_atacado"}));
    const _outrasPagFin=+(Number(outrasDespesasBase||0)+Number(taxaCredito||0)).toFixed(2);
    const _totalPagarFin=+(totalPedido+_outrasPagFin).toFixed(2);
    const _valorPagoFin=+pagamentos.reduce((s,p)=>s+Number(p.valor),0).toFixed(2);
    pags[String(pedidoId)]={
      pedidoId:String(pedidoId), valorPago:_valorPagoFin, valorPedido:_totalPagarFin, historico,
      statusPagamento:_valorPagoFin>=_totalPagarFin-0.05?"pago":(_valorPagoFin>0?"parcial":"pendente"),
    };
    salvarJSON(PAG_FILE,pags);

    // 4) vincula à sessão de caixa ATACADO aberta desse funcionário (entra no fechamento)
    try{
      const dCx=lerCaixaSessoes();
      const sessaoAtual=(dCx.sessoes||[]).find(s=>!s.fechadaEm&&s.funcionarioId===funcionarioId&&(s.tipoCaixa||"frente")==="atacado");
      if(sessaoAtual){
        const _outrasFin=+(Number(outrasDespesasBase||0)+Number(taxaCredito||0)).toFixed(2);
        sessaoAtual.movimentos.push({
          tipo:"venda", em:Date.now(), pedidoId, numero:req.body.numero||null,
          total:+(totalPedido+_outrasFin).toFixed(2), clienteNome:clienteNome||"", origem:"caixa_atacado",
          outrasDespesas:_outrasFin, operador:sessaoAtual.operador||"",
          itens:(Array.isArray(itens)?itens:[]).map(i=>({produtoId:i.produtoId,nome:i.nome||"",quantidade:i.quantidade,valor:i.valor})),
          pagamentos:pagamentos.map(p=>({formaNome:p.formaNome||"",valor:+Number(p.valor).toFixed(2)})),
        });
        salvarCaixaSessoes(dCx);
      }
    }catch(e){ console.error("Falha ao vincular ao caixa (ignorado):",e.message); }

    // 4b) grava as FORMAS DE PAGAMENTO (parcelas) no pedido do Bling, pra o pedido
    //     ficar com o pagamento correto lá também (não só no controle local).
    //     Faz antes de mover pra Atendido (Atendido pode travar edição de parcelas).
    try{
      const parcelasBling=pagamentos.filter(p=>p.formaId&&Number(p.valor)>0)
        .map(p=>({formaId:Number(p.formaId), valor:+Number(p.valor).toFixed(2)}));
      if(parcelasBling.length){
        const rp=await atualizarParcelasBling(pedidoId, parcelasBling, {append:false});
        if(!rp?.ok) console.error("Não gravou as formas de pagamento no Bling (pedido "+pedidoId+"):", rp?.erro);
      }
    }catch(e){ console.error("Falha ao gravar formas de pagamento no Bling (ignorado):",e.message); }

    // 4c) grava OUTRAS DESPESAS (taxa de cartão de crédito) no pedido do Bling. A taxa
    //     total = a que já existia no pedido + a taxa de crédito adicionada no caixa.
    let despesasGravadas=null;
    try{
      const taxaAdd=Number(taxaCredito||0);
      const base=Number(outrasDespesasBase||0);
      const totalDespesas=+(base+taxaAdd).toFixed(2);
      // só regrava se houver taxa nova a adicionar (evita PUT desnecessário)
      if(taxaAdd>0){
        const ped=await bling(`/pedidos/vendas/${pedidoId}`).then(r=>r?.data);
        if(ped){
          await bling(`/pedidos/vendas/${pedidoId}`,{method:"PUT",body:JSON.stringify({
            data:ped.data,
            ...(ped.contato?.id?{contato:{id:ped.contato.id}}:{}),
            ...(ped.vendedor?.id?{vendedor:{id:ped.vendedor.id}}:{}),
            itens:(ped.itens||[]).map(i=>({produto:{id:i.produto?.id},quantidade:i.quantidade,valor:i.valor})),
            outrasDespesas:totalDespesas,
          })});
          despesasGravadas=totalDespesas;
        }
      }
    }catch(e){ console.error("Falha ao gravar outras despesas/taxa no Bling (ignorado):",e.message); }

    // 5) move pro STATUS FINAL correto (Atendido ou Separado, conforme a regra da tela)
    //    de forma robusta (com cascata e conferindo se realmente mudou). Se não
    //    conseguir, o pagamento já ficou registrado — avisa o operador.
    const alvo = statusFinal==="separado" ? "Separado" : "Atendido";
    let avisoAtendido=null;
    try{
      const rMov=await moverPedidoParaStatusFinal(pedidoId, statusFinal);
      console.log("Transição de status do pedido "+pedidoId+" (alvo "+alvo+"):", JSON.stringify(rMov.caminho));
      if(!rMov.ok){
        avisoAtendido="O pagamento foi registrado, mas não consegui mudar a situação do pedido pra "+alvo+" (ficou na situação "+rMov.situacaoFinal+"). Verifique no Bling.";
      }
    }catch(e){
      console.error("Falha ao mover pra "+alvo+" (pagamento registrado, id="+pedidoId+"):",e.message);
      if(/estoque|saldo/i.test(e.message||"")){
        avisoAtendido="O pagamento foi registrado, mas o Bling não deixou mudar o pedido pra "+alvo+" por estoque insuficiente. Ajuste o estoque no Bling e mude a situação manualmente.";
      } else {
        avisoAtendido="O pagamento foi registrado, mas não consegui mudar a situação do pedido pra "+alvo+" automaticamente. Verifique no Bling.";
      }
    }

    // 6) NFC-e só se pedido (padrão desligado nesse caixa)
    let nfce=null;
    if(emitirNfce){
      try{
        const gerado=await bling(`/pedidos/vendas/${pedidoId}/gerar-nfce`,{method:"POST"});
        const idNotaFiscal=gerado?.data?.id||gerado?.data?.idNotaFiscal||null;
        if(!idNotaFiscal){ nfce={erro:"Bling não retornou o ID da NFC-e",detalhe:gerado}; }
        else{
          try{
            const enviado=await bling(`/nfce/${idNotaFiscal}/enviar`,{method:"POST"});
            let linkDanfe=null;
            try{ const det=await bling(`/nfce/${idNotaFiscal}`); linkDanfe=det?.data?.linkDanfe||det?.data?.linkPDF||null; }catch(e){}
            nfce={ok:true,idNotaFiscal,linkDanfe};
          }catch(e){ nfce={ok:true,idNotaFiscal,erroEnvio:e.message}; }
        }
      }catch(e){ nfce={erro:e.message,detalhe:e.body}; }
    }

    res.json({ok:true,pedidoId,total:totalPedido,nfce,aviso:avisoAtendido,estoqueReposto});
  }catch(e){ res.status(e.status||500).json({erro:e.message,detalhe:e.body}); }
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
    const tab = lerTabela(); const precoPorCod = {}; const caixaPorCod = {};
    (tab?.model || []).forEach(c => (c.itens || []).forEach(it => (it.bling || []).forEach(b => { precoPorCod[String(b.codigo)] = it.preco; caixaPorCod[String(b.codigo)] = it.caixa||1; })));
    lista.forEach(p => {
      const atacado = precoPorCod[String(p.codigo)];
      p.precoAtacado = (atacado != null) ? atacado : null;
      p.preco = (atacado != null) ? atacado : (p.precoBling ?? 0);
      p.origemPreco = (atacado != null) ? "atacado" : "bling";
      p.multiplo = caixaPorCod[String(p.codigo)] || 1; // de quantas em quantas unidades some
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
async function atualizarItensBling(id,itens,obsExtra){
  try{
    const atualJson=await bling(`/pedidos/vendas/${id}`);
    const ped=atualJson?.data; if(!ped) return {ok:false,erro:"pedido não encontrado"};
    const sit=ped.situacao?.id;
    if(sit===9||sit===12) return {ok:false,erro:"Pedido Atendido/Cancelado não pode ser editado."};

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
    const STATUS_BLOQUEADOS=[SIT.EM_SEP,SIT.SEP_PEND,SIT.SEPARADO,SIT.CONF_ENTREGA,SIT.EM_ROTA];
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
    if(ped.parcelas?.length){
      const novoTotalItens=itens.reduce((s,i)=>s+Number(i.quantidade)*Number(i.valor),0);
      const freteAtual=+(ped.transporte?.frete||0);
      const novoTotal=+(novoTotalItens+freteAtual).toFixed(2);
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

    let resultado, fezUnlock=false;
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
        let restaurado=false;
        for(let t=0;t<3;t++){
          try{ await bling(`/pedidos/vendas/${id}/situacoes/${sitRestaurar}`,{method:"PATCH"}); restaurado=true; break; }
          catch(e){ await new Promise(r=>setTimeout(r,600*(t+1))); }
        }
        if(!restaurado){
          try{ await bling(`/pedidos/vendas/${id}/situacoes/${SIT.AGUARDANDO}`,{method:"PATCH"}); }catch(e){}
        }
      }
    }
    return {ok:true,resultado};
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
    if(ped.parcelas?.length){
      const novoTotalItens=itens.reduce((s,i)=>s+Number(i.quantidade)*Number(i.valor),0);
      const freteAtual=+(ped.transporte?.frete||0);
      const novoTotal=+(novoTotalItens+freteAtual).toFixed(2);
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
      // 400: tenta via Em Digitação
      console.log("Tentando via Em Digitação para editar itens, sit atual:", sit);
      try{
        await blingComRetry(`/pedidos/vendas/${req.params.id}/situacoes/${SIT_EM_DIGITACAO}`,{method:"PATCH"});
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
        // determina para qual status restaurar
        // se estava em SEP_PEND, após editar vai para EM_SEP (expedição precisa separar novamente)
        const sitRestaurar=sit===SIT.SEP_PEND?SIT.EM_SEP:sit;
        let restaurado=false;
        console.log("Restaurando status:", sit, "→", sitRestaurar, "pedido:", req.params.id);
        for(let t=0;t<3;t++){
          try{
            await bling(`/pedidos/vendas/${req.params.id}/situacoes/${sitRestaurar}`,{method:"PATCH"});
            console.log("Status restaurado para", sitRestaurar);
            restaurado=true; break;
          }catch(e){
            console.error("Erro ao restaurar status "+sitRestaurar+" tentativa "+(t+1)+":", e.message);
            await new Promise(r=>setTimeout(r,600*(t+1)));
          }
        }
        // fallback: AGUARDANDO SEPARAÇÃO
        if(!restaurado){
          try{
            await bling(`/pedidos/vendas/${req.params.id}/situacoes/${SIT.AGUARDANDO}`,{method:"PATCH"});
            console.log("Status restaurado para AGUARDANDO (fallback)");
          }catch(e){
            console.error("Fallback falhou:", e.message);
            addLog(String(req.params.id),"status_nao_restaurado",null,null,{statusOriginal:sit,statusAtual:SIT_EM_DIGITACAO});
          }
        }
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
app.get("/estoque", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "estoque.html")); });
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
    if(indice[codigo]) return res.json({data:aplicarAtacado({...indice[codigo]}),origem:"indice"});

    // 2) fallback: SKU (esse filtro do Bling funciona, é busca exata pelo código interno)
    try{
      const r=await bling(`/produtos?codigo=${encodeURIComponent(codigo)}&limite=1`);
      const p=(r?.data||[])[0];
      if(p && String(p.codigo||"")===codigo){
        let det=p;
        try{ const d=await bling(`/produtos/${p.id}`); if(d?.data) det=d.data; }catch(e){}
        return res.json({data:aplicarAtacado({
          produtoId:det.id,nome:det.nome,preco:+(det.preco||0),
          imagem:det.imagemURL||det.imagem?.link?.grande||null,codigo:det.codigo||"",gtin:det.gtin||""
        }),origem:"sku"});
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
      const r=await bling(`/produtos?pagina=${pg}&limite=100`);
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
      try{ const d=await bling(`/produtos/${p.id}`); if(d?.data) det=d.data; }catch(e){}
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
    res.json({ok:true, verificados:pedidos.length, removidos:removidos.length, detalhes:removidos});
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
    const entrega=b.entrega&&b.entrega.tipo==="entrega"?{tipo:"entrega",endereco:b.entrega.endereco||"",km:b.entrega.km||0,taxa:Number(b.entrega.taxa)||0}:{tipo:"retirada"};
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
    let numero=criado?.data?.numero||pedidoId;
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
        agendadoRotaData=data;
      }catch(e){ console.error("[atacado] falhou ao agendar pedido",pedidoId,"no Gerenciamento de Rota:",e.message); }
    }

    prop.status="pedido_gerado";
    prop.pedidoBlingId=pedidoId; prop.pedidoBlingNumero=numero;
    prop.gerandoPedidoEm=null;
    prop.atualizadoEm=Date.now();
    props[prop.id]=prop; salvarPropostas(props);
    res.json({ok:true,pedidoId,numero,agendadoRotaData});
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
    const temCacheValido=_cacheApoio && _cacheApoio.dados?.vendedores;
    const cacheFresco=temCacheValido && (Date.now()-_cacheApoio.em < 24*60*60*1000);

    // tem cache fresco e não pediu pra forçar → devolve na hora
    if(cacheFresco && !forcar){
      return res.json({..._cacheApoio.dados, doCache:true, cacheEm:_cacheApoio.em, computando:_apoioComputando});
    }
    // precisa (re)calcular — dispara em segundo plano e responde na hora
    dispararApoioBackground({minValor,diasAtencao,diasPerdido});
    if(temCacheValido){
      // já tem um resultado anterior: mostra ele enquanto o novo é calculado
      return res.json({..._cacheApoio.dados, doCache:true, cacheEm:_cacheApoio.em, computando:true, progresso:_apoioProgresso});
    }
    // primeira análise de todas, nada pronto ainda
    return res.json({computando:true, primeira:true, progresso:_apoioProgresso||"Iniciando…"});
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
    const valorMin=req.query.valorMin!=null?Number(req.query.valorMin):1000;
    const jaAgendado=(id)=>!!acharCarroDoPedido(id);
    const candidatos = valorMin>0
      ? unicos.filter(p=> Number(p.total||0)>=valorMin || jaAgendado(p.id))
      : unicos;

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

app.listen(PORT,()=> console.log(`B13 Bling Backend na porta ${PORT} (DATA_DIR=${DATA_DIR})`));
