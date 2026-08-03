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
const FPAG_DEFAULT=[
  {id:1,nome:"Dinheiro"},{id:2,nome:"PIX"},{id:3,nome:"Cartão de Crédito"},
  {id:4,nome:"Cartão de Débito"},{id:5,nome:"Transferência"},{id:6,nome:"Boleto"},
];

// IDs dos status — configurados via variáveis de ambiente ou padrões existentes
const SIT = {
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
  "http://localhost:3000","http://127.0.0.1:3000",
];
app.use(cors({
  origin(origin,cb){
    // requisições sem "origin" (apps mobile, curl, mesma origem) sempre passam
    if(!origin||ORIGENS_PERMITIDAS.includes(origin)) return cb(null,true);
    cb(new Error("Origem não permitida por CORS"));
  },
}));
app.use(express.json({ limit: "5mb" }));

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
      const motivo=j?.error?.description||j?.error?.message||(Array.isArray(j?.errors)?j.errors.map(x=>x.msg||x.message).join("; "):null)||JSON.stringify(j).slice(0,200);
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

// ------------------------- OAuth -------------------------
app.get("/auth",(req,res)=> res.redirect(`${AUTH_URL}?response_type=code&client_id=${BLING_CLIENT_ID}&state=b13${Date.now()}`));
app.get("/logo",(req,res)=>res.sendFile(path.join(__dirname,"logo.png")));
app.get("/loja-fundo",(req,res)=>res.sendFile(path.join(__dirname,"loja-fundo.png")));
app.get("/logo-ofertas",(req,res)=>res.sendFile(path.join(__dirname,"logo-ofertas.jpg")));
app.use("/promo", express.static(path.join(__dirname, "promo"))); // imagens promocionais fixas (splash do totem)
app.get("/musica-fundo",(req,res)=>{
  const arq=path.join(__dirname,"musica-fundo.mp3");
  if(!fs.existsSync(arq)) return res.status(404).send("Música de fundo ainda não configurada");
  res.sendFile(arq);
});
app.get("/login",(req,res)=>res.sendFile(path.join(__dirname,"login.html")));
app.get("/nav.js",(req,res)=>{
  res.setHeader("Content-Type","application/javascript");
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
  if(n.includes("admin")) return true;
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
function b13Logout(){ b13ClearSession(); location.href="/login"; }

function b13RenderNav(ativo){
  const f=b13GetSession(); if(!f) return "";
  const links=[
    {href:"/operacional",label:"⚙️ Operacional",check:()=>b13Pode("ver_aguardando")||b13Pode("ver_separacao")||b13Pode("conferir")},
    {href:"/painel-pedidos",label:"📺 Painel de Pedidos",check:()=>b13Pode("ver_aguardando")||b13Pode("ver_separacao")||b13Pode("conferir")},
    {href:"/caixa",label:"💳 Caixa",check:()=>b13Pode("receber_pagamento")},
    {href:"/caixa-diario",label:"📅 Relatório Diário",check:()=>b13Pode("receber_pagamento")},
    {href:"/frente-caixa",label:"🧾 Frente de Caixa",check:()=>b13Pode("receber_pagamento")},
    {href:"/venda-atacado",label:"🛒 Venda Atacado",check:()=>b13Pode("receber_pagamento")||b13Pode("editar_pedido")},
    {href:"/propostas",label:"📄 Propostas",check:()=>b13Pode("receber_pagamento")||b13Pode("editar_pedido")},
    {href:"/lista-fardo",label:"📋 Lista de Fardo",check:()=>b13Pode("editar_pedido")},
    {href:"/etiquetas",label:"🏷 Etiquetas",check:()=>b13Pode("editar_pedido")},
    {href:"/listas-extras",label:"📂 Listas Extras",check:()=>b13Pode("editar_pedido")},
    {href:"/expedicao",label:"🚚 Expedição",check:()=>b13Pode("ver_separacao")},
    {href:"/conferencia",label:"🔍 Conferência",check:()=>b13Pode("conferir")},
    {href:"/dashboard",label:"📊 Dashboard",check:()=>b13Pode("ver_dashboard")},
    {href:"/perdas",label:"📉 Perdas (danif./não entregue)",check:()=>b13Pode("ver_dashboard")},
    {href:"/gestao",label:"📋 Gestão",check:()=>b13Pode("editar_pedido")},
    {href:"/tabela",label:"🗂️ Tabela Atacado",check:()=>b13Pode("ver_listas")},
    {href:"/listas",label:"📄 Listas de Preço",check:()=>b13Pode("ver_listas")},
    {href:"/funcionarios",label:"👥 Funcionários",check:()=>b13Pode("ver_funcionarios")},
    {href:"/imagens",label:"📷 Imagens",check:()=>b13Pode("admin")},
  ].filter(l=>l.check());

  return \`<div id="b13nav" style="position:fixed;top:0;left:0;bottom:0;width:200px;background:linear-gradient(180deg,#2b2870,#262366);border-right:2px solid #FF0082;display:flex;flex-direction:column;z-index:100;transform:translateX(-100%);transition:.25s" id="b13nav">
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
  <button onclick="b13ToggleNav()" style="position:fixed;top:12px;left:12px;z-index:101;background:#262366;border:1px solid #FF0082;border-radius:8px;color:#fff;padding:6px 10px;cursor:pointer;font-size:18px">☰</button>
  <div id="b13navOverlay" onclick="b13ToggleNav()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99"></div>\`;
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
  sessoes[token]={funcionarioId:f.id,nome:f.nome,nivel:f.nivel,permissoes:f.permissoes||[f.nivel],criadoEm:Date.now(),expiraEm:Date.now()+12*3600*1000};
  salvarSessoes(sessoes);
  return token;
}
// Middleware: exige token de sessão válido de um admin (ou de quem tem "admin" nas permissões)
function requireAdmin(req,res,next){
  const token=req.headers["x-auth-token"];
  if(!token) return res.status(401).json({erro:"Não autenticado — faça login novamente"});
  const sessoes=lerSessoes();
  const s=sessoes[token];
  if(!s||s.expiraEm<Date.now()) return res.status(401).json({erro:"Sessão expirada — faça login novamente"});
  if(s.nivel!=="admin"&&!(s.permissoes||[]).includes("admin")) return res.status(403).json({erro:"Sem permissão de administrador"});
  req.sessao=s;
  next();
}

// ---- FUNCIONÁRIOS ----
app.get("/api/funcionarios",(req,res)=>{
  const funcs=lerJSON(FUNC_FILE,{});
  res.json({data:Object.values(funcs).map(f=>({id:f.id,nome:f.nome,login:f.login||"",nivel:f.nivel,permissoes:f.permissoes||[f.nivel],ativo:f.ativo,codigoConfirmacao:f.codigoConfirmacao||"",temPin:!!f.pinConfirmacao,vendedorBlingId:f.vendedorBlingId||null,vendedorBlingNome:f.vendedorBlingNome||""}))});
});
app.post("/api/funcionarios",requireAdmin,(req,res)=>{
  const {nome,senha,nivel}=req.body||{};
  if(!nome||!senha||!nivel) return res.status(400).json({erro:"nome, senha e nivel obrigatórios"});
  const funcs=lerJSON(FUNC_FILE,{});
  const id="f"+Date.now()+crypto.randomBytes(4).toString("hex");
  // verificar login duplicado
  if(req.body.login && Object.values(funcs).some(f=>f.login===req.body.login))
    return res.status(400).json({erro:"Login já em uso por outro funcionário"});
  // código de confirmação (1 letra + 2 números), sem repetir um já existente
  const letras="ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let codigoConfirmacao;
  do{
    codigoConfirmacao=letras[Math.floor(Math.random()*letras.length)]+String(Math.floor(Math.random()*100)).padStart(2,"0");
  }while(Object.values(funcs).some(f=>f.codigoConfirmacao===codigoConfirmacao));
  funcs[id]={id,nome,login:req.body.login||"",nivel,permissoes:req.body.permissoes||[nivel],senhaHash:hashSenha(senha),ativo:true,criadoEm:Date.now(),
    codigoConfirmacao,pinConfirmacao:req.body.pinConfirmacao||"",
    vendedorBlingId:req.body.vendedorBlingId?Number(req.body.vendedorBlingId):null,vendedorBlingNome:req.body.vendedorBlingNome||""};
  salvarJSON(FUNC_FILE,funcs); res.json({ok:true,id,codigoConfirmacao});
});
app.patch("/api/funcionarios/:id",requireAdmin,(req,res)=>{
  const funcs=lerJSON(FUNC_FILE,{}); const f=funcs[req.params.id];
  if(!f) return res.status(404).json({erro:"funcionário não encontrado"});
  if(req.body.nome) f.nome=req.body.nome;
  if(req.body.login){
    const outros=Object.values(lerJSON(FUNC_FILE,{})).filter(x=>x.id!==req.params.id);
    if(outros.some(x=>x.login===req.body.login)) return res.status(400).json({erro:"Login já em uso"});
    f.login=req.body.login;
  }
  if(req.body.nivel) f.nivel=req.body.nivel;
  if(req.body.permissoes) f.permissoes=req.body.permissoes;
  if(typeof req.body.ativo==="boolean") f.ativo=req.body.ativo;
  if(req.body.senha) f.senhaHash=hashSenha(req.body.senha);
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
  const f=Object.values(funcs).find(x=>{
    const loginOk=login?x.login===login:true;
    return loginOk&&verificarSenha(senha||"",x.senhaHash)&&x.ativo&&(!nivel||x.nivel===nivel||(x.permissoes||[]).includes(nivel)||x.nivel==="admin");
  });
  if(!f){ registrarFalhaLogin(ip); return res.status(401).json({erro:"Login ou senha incorretos"}); }
  limparTentativasLogin(ip);
  // migra sozinho pro hash forte (scrypt) se ainda estava no formato antigo
  if(!f.senhaHash.includes(":")){ f.senhaHash=hashSenha(senha); salvarJSON(FUNC_FILE,funcs); }
  const token=criarSessao(f);
  res.json({ok:true,funcionario:{id:f.id,nome:f.nome,nivel:f.nivel,permissoes:f.permissoes||[f.nivel],token}});
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
  const STATUS_BLOQUEADOS=[SIT.EM_SEP,SIT.SEP_PEND,SIT.SEPARADO,SIT.CONF_ENTREGA,SIT.EM_ROTA];
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
      observacoes:ped.observacoes||"",
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
      if(e1.status!==400||!precisaUnlock) throw e1;
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
          try{ await bling(`/pedidos/vendas/${id}/situacoes/${sitAtual}`,{method:"PATCH"}); break; }
          catch(e){ await new Promise(r=>setTimeout(r,600*(t+1))); }
        }
      }
    }
    return {ok:true,resposta:resultado,fezUnlock};
  }catch(e){ return {ok:false,erro:e.message,status:e.status,body:e.body}; }
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
    res.json({ok:true,pagamento:p,_blingFinanceiro:blingFinanceiroResultado});
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
    await bling(`/pedidos/vendas/${id}/situacoes/${SIT.ATENDIDO}`,{method:"PATCH"});
    liberarLock(id,funcionarioId,funcionarioNome,"entrega_confirmada");
    addLog(id,"entrega_confirmada",funcionarioId,funcionarioNome,{});
    res.json({ok:true});
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
app.get("/api/tabela",(req,res)=> res.json(lerTabela()||{model:[],meta:{}}));

// ------------------------- Catálogo p/ o totem (tabela + estoque ao vivo) -------------------------
let _estCache={t:0,map:null};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function getEstoqueMap(){
  if(_estCache.map && Date.now()-_estCache.t < 300000) return _estCache.map; // cache 5 min
  const map={};
  for(let pg=1; pg<=40; pg++){
    const d=await bling(`/produtos?pagina=${pg}&limite=100`);
    const arr=d.data||[]; if(!arr.length) break;
    arr.forEach(p=>{ map[String(p.codigo)]={estoque:p.estoque?.saldoVirtualTotal ?? 0, nome:p.nome, id:p.id, imagem:p.imagemURL||""}; });
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
app.get("/api/contatos",async(req,res)=>{
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
    console.log("Busca contato doc:", doc, "encontrado:", !!a, "id:", a?.id);
    if(!a) return res.json({encontrado:false,contato:null});
    // busca detalhe completo (com endereço, telefone, celular, email)
    let detalhe=a;
    try{ const dj=await bling(`/contatos/${a.id}`); detalhe=dj?.data||a; }catch(e){}
    const end=detalhe.endereco?.geral||{};
    res.json({encontrado:true, contato:{
      id:detalhe.id, nome:detalhe.nome||"",
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
function sessaoCaixaAberta(funcionarioId){
  const d=lerCaixaSessoes();
  if(funcionarioId) return (d.sessoes||[]).find(s=>!s.fechadaEm&&s.funcionarioId===funcionarioId)||null;
  return (d.sessoes||[]).find(s=>!s.fechadaEm)||null;
}
// Resumo consolidado de uma sessão: soma vendas por forma, sangrias, suprimentos
function resumoSessaoCaixa(sessao){
  const movs=sessao.movimentos||[];
  const vendas=movs.filter(m=>m.tipo==="venda");
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
  const esperadoGaveta=+(Number(sessao.trocoInicial||0)+vendasDinheiro+totalSuprimentos-totalSangrias).toFixed(2);

  return {
    trocoInicial:+Number(sessao.trocoInicial||0).toFixed(2),
    qtdVendas:vendas.length,
    totalVendas:+totalVendas.toFixed(2),
    vendasDinheiro:+vendasDinheiro.toFixed(2),
    totalSangrias:+totalSangrias.toFixed(2),
    totalSuprimentos:+totalSuprimentos.toFixed(2),
    esperadoGaveta,
    porForma:Object.entries(porForma).map(([nome,v])=>({nome,valor:+v.valor.toFixed(2),qtd:v.qtd})).sort((a,b)=>b.valor-a.valor),
  };
}

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
  const s=sessaoCaixaAberta(req.query.funcionarioId);
  if(!s) return res.json({aberta:false});
  res.json({
    aberta:true,
    sessao:{id:s.id,abertaEm:s.abertaEm,operador:s.operador,funcionarioId:s.funcionarioId,trocoInicial:s.trocoInicial},
    resumo:resumoSessaoCaixa(s),
    movimentos:(s.movimentos||[]).slice().sort((a,b)=>b.em-a.em),
  });
});

// lista todos os caixas abertos agora (de todo mundo) — pra ver quem está com caixa aberto
app.get("/api/caixa-sessao/abertos",(req,res)=>{
  const d=lerCaixaSessoes();
  const abertos=(d.sessoes||[]).filter(s=>!s.fechadaEm);
  res.json({data:abertos.map(s=>({id:s.id,operador:s.operador,funcionarioId:s.funcionarioId,abertaEm:s.abertaEm,resumo:resumoSessaoCaixa(s)}))});
});

// abre o caixa informando o troco inicial (fundo de caixa) — vinculado ao funcionário logado
app.post("/api/caixa-sessao/abrir",(req,res)=>{
  const {trocoInicial,operador,funcionarioId}=req.body||{};
  if(!funcionarioId) return res.status(400).json({erro:"Sessão não identificada — faça login de novo."});
  if(sessaoCaixaAberta(funcionarioId)) return res.status(400).json({erro:"Você já tem um caixa aberto. Feche o atual antes de abrir outro."});
  const d=lerCaixaSessoes();
  const sessao={
    id:"cx"+Date.now()+crypto.randomBytes(3).toString("hex"),
    abertaEm:Date.now(),
    operador:operador||"—",
    funcionarioId,
    trocoInicial:+Number(trocoInicial||0).toFixed(2),
    movimentos:[],
    fechadaEm:null,
  };
  d.sessoes=d.sessoes||[]; d.sessoes.push(sessao); salvarCaixaSessoes(d);
  res.json({ok:true,sessao,resumo:resumoSessaoCaixa(sessao)});
});

// registra sangria (retirada) ou suprimento (entrada de dinheiro)
app.post("/api/caixa-sessao/movimento",(req,res)=>{
  const {tipo,valor,motivo,operador,funcionarioId}=req.body||{};
  if(!["sangria","suprimento"].includes(tipo)) return res.status(400).json({erro:"tipo deve ser sangria ou suprimento"});
  const v=+Number(valor||0).toFixed(2);
  if(!(v>0)) return res.status(400).json({erro:"informe um valor maior que zero"});
  const d=lerCaixaSessoes();
  const sessao=(d.sessoes||[]).find(s=>!s.fechadaEm&&s.funcionarioId===funcionarioId);
  if(!sessao) return res.status(400).json({erro:"Nenhum caixa aberto pra esse usuário"});
  sessao.movimentos.push({tipo,valor:v,motivo:motivo||"",operador:operador||"—",em:Date.now()});
  salvarCaixaSessoes(d);
  res.json({ok:true,resumo:resumoSessaoCaixa(sessao)});
});

// fecha o caixa, comparando o contado com o esperado (conferência)
app.post("/api/caixa-sessao/fechar",(req,res)=>{
  const {valorContado,observacao,operador,funcionarioId}=req.body||{};
  const d=lerCaixaSessoes();
  const sessao=(d.sessoes||[]).find(s=>!s.fechadaEm&&s.funcionarioId===funcionarioId);
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
    id:s.id,abertaEm:s.abertaEm,fechadaEm:s.fechadaEm,operador:s.operador,funcionarioId:s.funcionarioId,
    trocoInicial:s.trocoInicial,fechamento:s.fechamento,resumo:s.resumoFinal||resumoSessaoCaixa(s),movimentos:s.movimentos||[],
  }))});
});

// detalhe (histórico de movimentos) de UMA sessão específica, aberta ou fechada
app.get("/api/caixa-sessao/:id/movimentos",(req,res)=>{
  const d=lerCaixaSessoes();
  const s=(d.sessoes||[]).find(x=>x.id===req.params.id);
  if(!s) return res.status(404).json({erro:"sessão não encontrada"});
  res.json({
    sessao:{id:s.id,abertaEm:s.abertaEm,fechadaEm:s.fechadaEm,operador:s.operador,trocoInicial:s.trocoInicial},
    resumo:s.resumoFinal||resumoSessaoCaixa(s),
    fechamento:s.fechamento||null,
    movimentos:(s.movimentos||[]).sort((a,b)=>b.em-a.em),
  });
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
// ---------------- LISTAS EXTRAS (promoção, produto perto do vencimento, etc) ----------------
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

// estoque ao vivo do produto (o indice de preco pode estar desatualizado quanto a quantidade)
// busca do "Consumidor Final" pelo codigo 2 no Bling, com cache curto (pra nao bater na API toda hora)
let _consumidorFinalCache=null, _consumidorFinalEm=0;
const CONSUMIDOR_FINAL_ID=17313605063; // ID confirmado direto do link do contato no Bling
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
  const {idDigitado,senhaDigitada}=req.body||{};
  const r=validarAutorizacaoPdv(idDigitado,senhaDigitada);
  if(r.erro) return res.status(401).json({erro:r.erro});
  res.json({ok:true,autorizadoPor:r.funcionario.nome});
});

// Ajusta o estoque do produto no Bling (define o saldo pro valor informado) — usado quando
// o funcionário tenta vender um produto sem estoque suficiente no sistema, mas o produto
// está fisicamente disponível (ex: contagem desatualizada). Exige a mesma autorização.
app.post("/api/pdv/ajustar-estoque",async(req,res)=>{
  const {idDigitado,senhaDigitada,produtoId,quantidade}=req.body||{};
  const auth=validarAutorizacaoPdv(idDigitado,senhaDigitada);
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

    // vendedor: usa o vendedor Bling vinculado ao funcionário logado no caixa;
    // se o funcionário não tiver um vendedor configurado, cai pro ID fixo do .env (compatibilidade)
    let vendedorId=null;
    if(funcionarioId){
      const funcs=lerJSON(FUNC_FILE,{});
      const func=funcs[funcionarioId];
      if(func?.vendedorBlingId) vendedorId=Number(func.vendedorBlingId);
    }
    if(!vendedorId) vendedorId=Number(process.env.BLING_VENDEDOR_ID)||null;

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
    const payload={
      data: dataHojeBR,
      itens:itensPayload,
      ...(contatoId?{contato:{id:Number(contatoId)}}:{}),
      ...(vendedorId?{vendedor:{id:vendedorId}}:{}),
      ...(totalDesconto?{desconto:{valor:totalDesconto,unidade:"REAL"}}:{}),
      parcelas: pagamentos.map(p=>({valor:+Number(p.valor).toFixed(2),dataVencimento:dataHojeBR,formaPagamento:{id:Number(p.formaId)}})),
    };

    const criado=await bling(`/pedidos/vendas`,{method:"POST",body:JSON.stringify(payload)});
    const pedidoId=criado?.data?.id;
    if(!pedidoId) return res.status(500).json({erro:"Bling não retornou o ID do pedido criado",detalhe:criado});
    // move pra Atendido depois de criado (igual o fluxo do totem, que já funciona)
    try{ await bling(`/pedidos/vendas/${pedidoId}/situacoes/${SIT.ATENDIDO}`,{method:"PATCH"}); }
    catch(e){ console.error("Falha ao mover pedido pra Atendido (venda ja foi criada, id="+pedidoId+"):",e.message); }

    // registra localmente (mesmo padrão usado no restante do sistema)
    const pags=lerPag();
    const historico=pagamentos.map(p=>({em:Date.now(),valor:+Number(p.valor).toFixed(2),formaNome:p.formaNome||"",tipo:"pdv_varejo"}));
    pags[String(pedidoId)]={valorPago:totalPedido,historico};
    salvarJSON(PAG_FILE,pags);

    // vincula a venda à sessão de caixa aberta DESSE funcionário (pra entrar no fechamento/conferência)
    try{
      const dCx=lerCaixaSessoes();
      const sessaoAtual=(dCx.sessoes||[]).find(s=>!s.fechadaEm&&s.funcionarioId===funcionarioId);
      if(sessaoAtual){
        sessaoAtual.movimentos.push({
          tipo:"venda", em:Date.now(), pedidoId, numero:criado?.data?.numero,
          total:totalPedido, clienteNome:clienteNome||"", desconto:totalDesconto,
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

    res.json({ok:true,pedidoId,numero:criado?.data?.numero,total:totalPedido,nfce});
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
app.post("/api/finalizar", async (req, res) => {
  try {
    const { documento, nome, email, telefone, itens, entrega, cadastro } = req.body || {};
    const doc = soDigitos(documento);
    if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ erro: "itens vazios" });

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
    const totalItensCalc=itens.reduce((s,i)=>s+Number(i.quantidade)*Number(i.valor),0);
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
      itens: itens.map((i) => ({ produto: { id: Number(i.produtoId) }, quantidade: Number(i.quantidade), valor: Number(i.valor) })),
      observacoes: obs,
    };
    if(formaFichaFinanceira){
      payload.parcelas=[{ formaPagamento:{id:formaFichaFinanceira}, dataVencimento:hoje, valor:totalPedidoCalc }];
    }
    if (entrega && entrega.tipo === "entrega"){
      payload.transporte = {
        fretePorConta: 0,
        frete: Number(entrega.taxa) || 0,
      };
      // incluir endereço de entrega para evitar erro de UF obrigatório
      if(entrega.endereco){
        const endParts=entrega.endereco.split(",").map(s=>s.trim());
        payload.transporte.enderecoEntrega={
          endereco: endParts[0]||"",
          numero: endParts[1]||"S/N",
          complemento: "",
          bairro: endParts[2]||"",
          cep: "",
          municipio: "Belo Horizonte",
          uf: "MG",
          pais: "Brasil",
        };
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
app.get("/api/frete", async (req,res)=>{
  try{
    const endereco=(req.query.endereco||"").trim();
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
    res.json({ data: lista });
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// Atualiza os ITENS de um pedido (mantém o resto do pedido), bloqueando Atendido/Cancelado
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
        payload.transporte.enderecoEntrega={
          endereco:end.endereco||"",
          numero:end.numero||"S/N",
          complemento:end.complemento||"",
          bairro:end.bairro||"",
          cep:end.cep||"",
          municipio:end.municipio||"",
          uf:end.uf||"MG",
          pais:end.pais||"Brasil",
        };
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
        vendedor:vendedorNome, total, valorPago, pago, parcial, falta, doBling, fichaFinanceira,
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
    res.write(`data: ${JSON.stringify({tipo:"done",relatorio:{
      data, dataInicial, dataFinal, totalPedidos:lista.length, totalGeral:+totalGeral.toFixed(2),
      totalPago:+totalPago.toFixed(2), totalNaoPago:+totalNaoPago.toFixed(2),
      totalCancelados:+totalCancelados.toFixed(2), qtdCancelados,
      totalPrevisto:+totalPrevisto.toFixed(2), qtdPrevisto,
      totalFichaFinanceira:+totalFichaFinanceira.toFixed(2), qtdFichaFinanceira,
      qtdParciais, totalFaltaParciais,
      porStatus, porVendedor, porFormaPagamento, porCliente, pedidos:pedidosDetalhados,
    }})}\n\n`);
  }catch(e){ send({tipo:"erro",erro:e.message}); }
  clearInterval(heartbeat);
  res.end();
});


app.get("/expedicao", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "expedicao.html")); });
app.get("/caixa", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "caixa.html")); });
app.get("/caixa-diario", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "caixa-diario.html")); });
app.get("/frente-caixa", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "frente-caixa.html")); });
app.get("/lista-fardo", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "lista-fardo.html")); });
app.get("/etiquetas", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "etiquetas.html")); });
app.get("/listas-extras", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "listas-extras.html")); });
app.get("/gestao", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "gestao.html")); });
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
app.get("/tabela",(req,res)=>res.sendFile(path.join(__dirname,"tabela.html")));
app.get("/listas", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "listas.html")); });
app.get("/dashboard", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "dashboard.html")); });
app.get("/perdas", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "perdas.html")); });
app.get("/venda-atacado", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "venda-atacado.html")); });
app.get("/propostas", (req, res) => { res.set("Cache-Control","no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "propostas.html")); });

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
app.get("/api/preco/gtin/:codigo", async(req,res)=>{
  try{
    const codigo=String(req.params.codigo||"").trim();
    if(!codigo) return res.status(400).json({erro:"informe o código"});
    const indice=lerJSON(GTIN_INDEX_FILE,{});
    if(indice[codigo]) return res.json({data:indice[codigo],origem:"indice"});
    // fallback ao vivo: tenta pelo campo "codigo" (SKU interno) direto no Bling
    try{
      const r=await bling(`/produtos?codigo=${encodeURIComponent(codigo)}&limite=1`);
      const p=(r?.data||[])[0];
      if(p){
        const item={produtoId:p.id,nome:p.nome,preco:+(p.preco||0),imagem:p.imagemURL||p.imagem?.link?.grande||null,codigo:p.codigo||""};
        return res.json({data:item,origem:"bling_ao_vivo"});
      }
    }catch(e){}
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
      payload.transporte.enderecoEntrega={
        endereco:end.endereco||"",numero:end.numero||"S/N",complemento:end.complemento||"",
        bairro:end.bairro||"",cep:end.cep||"",municipio:end.municipio||"",uf:end.uf||"MG",pais:end.pais||"Brasil",
      };
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
app.get("/",(req,res)=> res.send("B13 Bling Backend rodando. Comece em <a href='/auth'>/auth</a>. Totem do cliente em <a href='/pedir'>/pedir</a>."));
// Reconstrói o índice de produtos (nome/código/preço) em segundo plano, sem travar
// nada. Roda ao subir o servidor e depois a cada 30 min — assim produtos novos
// entram na busca automaticamente, sem precisar reconstruir manualmente em /preco.
async function reconstruirIndiceProdutosBg(){
  try{
    const lista=[];
    for(let pg=1;pg<=100;pg++){
      const r=await bling(`/produtos?pagina=${pg}&limite=100`);
      const arr=r?.data||[]; lista.push(...arr);
      if(arr.length<100) break;
      await sleep(400); // respeita o limite de req/s do Bling
    }
    const indice={};
    for(const p of lista){
      const item={produtoId:p.id,nome:p.nome,preco:+(p.preco||0),imagem:p.imagemURL||null,codigo:p.codigo||""};
      const codigos=[p.gtin,p.codigo].filter(Boolean).map(String);
      if(codigos.length) codigos.forEach(c=>{ indice[c]=item; });
      else indice["id_"+p.id]=item; // garante que o produto entre no índice mesmo sem código
    }
    if(Object.keys(indice).length) salvarJSON(GTIN_INDEX_FILE,indice);
    console.log(`[indice] atualizado em segundo plano: ${lista.length} produtos`);
  }catch(e){ console.log("[indice] falha ao atualizar em segundo plano:",e.message); }
}
setTimeout(reconstruirIndiceProdutosBg, 15000);            // 15s depois de subir
setInterval(reconstruirIndiceProdutosBg, 30*60*1000);      // e a cada 30 min

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
  if(tipo) lista=lista.filter(p=>p.tipo===tipo);
  if(status) lista=lista.filter(p=>p.status===status);
  lista.sort((a,b)=>(b.criadoEm||0)-(a.criadoEm||0));
  res.json({data:lista});
});

app.get("/api/atacado/propostas/:id",(req,res)=>{
  const p=lerPropostas()[req.params.id];
  if(!p) return res.status(404).json({erro:"não encontrada"});
  res.json({data:p});
});

// cria ou atualiza uma proposta/rascunho de pedido no nosso sistema
app.post("/api/atacado/propostas",(req,res)=>{
  try{
    const b=req.body||{};
    const props=lerPropostas();
    const id=b.id||("prop_"+Date.now()+"_"+Math.random().toString(36).slice(2,7));
    const agora=Date.now();
    const registro={
      id,
      tipo:b.tipo||"proposta",           // "proposta" | "pedido"
      status:b.status||"aberta",         // aberta | aprovada | pedido_gerado | cancelada
      cliente:b.cliente||null,           // {id,nome,documento,telefone,...}
      itens:b.itens||[],                 // [{produtoId,nome,quantidade,valor,imagem}]
      observacao:b.observacao||"",
      vendedorId:b.vendedorId||null, vendedorNome:b.vendedorNome||"",
      funcionarioId:b.funcionarioId||null, funcionarioNome:b.funcionarioNome||"",
      total:+(b.itens||[]).reduce((s,i)=>s+Number(i.valor||0)*Number(i.quantidade||0),0).toFixed(2),
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
  if(props[req.params.id]){ delete props[req.params.id]; salvarPropostas(props); }
  res.json({ok:true});
});

// gera o pedido de venda no Bling a partir de uma proposta e marca situação "aguardando separação"
app.post("/api/atacado/propostas/:id/gerar-pedido",async(req,res)=>{
  try{
    const props=lerPropostas();
    const prop=props[req.params.id];
    if(!prop) return res.status(404).json({erro:"proposta não encontrada"});
    if(prop.pedidoBlingId) return res.status(400).json({erro:"esta proposta já virou o pedido #"+prop.pedidoBlingNumero});
    if(!prop.cliente?.id) return res.status(400).json({erro:"a proposta precisa de um cliente cadastrado no Bling pra gerar o pedido"});
    if(!prop.itens?.length) return res.status(400).json({erro:"a proposta não tem itens"});

    const dataHojeBR=new Date(Date.now()-3*60*60*1000).toISOString().slice(0,10);
    const totalPed=+prop.itens.reduce((s,i)=>s+Number(i.valor||0)*Number(i.quantidade||0),0).toFixed(2);
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
      return res.status(400).json({erro:"Bling recusou: "+detalhe, detalheCompleto:b});
    }
    const pedidoId=criado?.data?.id;
    let numero=criado?.data?.numero||pedidoId;
    // reforça o vendedor via PUT (o POST às vezes não respeita) e move pra separação
    if(pedidoId&&prop.vendedorId){
      try{ await new Promise(r=>setTimeout(r,350)); await bling(`/pedidos/vendas/${pedidoId}`,{method:"PUT",body:JSON.stringify(payload)}); }catch(e){}
    }
    // move pra "aguardando separação" (mesmo status do fluxo do totem)
    try{ await new Promise(r=>setTimeout(r,350)); await bling(`/pedidos/vendas/${pedidoId}/situacoes/${SIT.AGUARDANDO}`,{method:"PATCH"}); }catch(e){}
    addLog(String(pedidoId),"pedido_criado_atacado",prop.funcionarioId,prop.funcionarioNome,{proposta:prop.id});

    prop.status="pedido_gerado";
    prop.pedidoBlingId=pedidoId; prop.pedidoBlingNumero=numero;
    prop.atualizadoEm=Date.now();
    props[prop.id]=prop; salvarPropostas(props);
    res.json({ok:true,pedidoId,numero});
  }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }
});

app.listen(PORT,()=> console.log(`B13 Bling Backend na porta ${PORT} (DATA_DIR=${DATA_DIR})`));
