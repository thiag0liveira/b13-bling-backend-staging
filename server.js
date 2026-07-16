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
const SEP_FILE  = `${DATA_DIR}/separacoes.json`;
const ACRS_FILE = `${DATA_DIR}/acrescimos.json`;
const PAG_FILE  = `${DATA_DIR}/pagamentos.json`;
const LOG_FILE    = `${DATA_DIR}/log_pedidos.json`;
const PERDAS_FILE = `${DATA_DIR}/perdas.json`;
const CREDITOS_FILE = `${DATA_DIR}/creditos_clientes.json`;
const FPAG_FILE = `${DATA_DIR}/formas_pagamento.json`;
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
app.use(cors());
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
async function bling(path,options={}){
  const token=await getAccessToken();
  const ctrl=new AbortController();
  const timeout=setTimeout(()=>ctrl.abort(),30000); // 30s timeout
  try{
    const r=await fetch(API+path,{...options,signal:ctrl.signal,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json",...(options.headers||{})}});
    clearTimeout(timeout);
    const txt=await r.text(); let j; try{ j=txt?JSON.parse(txt):{}; }catch{ j={raw:txt}; }
    if(!r.ok) throw Object.assign(new Error("Erro Bling "+r.status),{status:r.status,body:j});
    return j;
  }catch(e){ clearTimeout(timeout); throw e; }
}
const soDigitos=(s)=>(s||"").replace(/\D/g,"");

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
    {href:"/expedicao",label:"🚚 Expedição",check:()=>b13Pode("ver_separacao")},
    {href:"/conferencia",label:"🔍 Conferência",check:()=>b13Pode("conferir")},
    {href:"/dashboard",label:"📊 Dashboard",check:()=>b13Pode("ver_dashboard")},
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
app.get("/api/situacoes",async(req,res)=>{ try{ const m=req.query.modulo; res.json(await bling(m?`/situacoes/modulos/${m}`:`/situacoes/modulos`)); }catch(e){ res.status(e.status||500).json({erro:e.message,body:e.body}); }});

// ---- helpers ----
const lerJSON=(f,def={})=>{ try{return JSON.parse(fs.readFileSync(f,"utf8"));}catch{return def;} };
const salvarJSON=(f,d)=>fs.writeFileSync(f,JSON.stringify(d));
const hashSenha=(s)=>crypto.createHash("sha256").update(s+(process.env.SALT||"b13salt")).digest("hex");

// ---- FUNCIONÁRIOS ----
app.get("/api/funcionarios",(req,res)=>{
  const funcs=lerJSON(FUNC_FILE,{});
  res.json({data:Object.values(funcs).map(f=>({id:f.id,nome:f.nome,login:f.login||"",nivel:f.nivel,permissoes:f.permissoes||[f.nivel],ativo:f.ativo}))});
});
app.post("/api/funcionarios",(req,res)=>{
  const {nome,senha,nivel}=req.body||{};
  if(!nome||!senha||!nivel) return res.status(400).json({erro:"nome, senha e nivel obrigatórios"});
  const funcs=lerJSON(FUNC_FILE,{});
  const id="f"+Date.now();
  // verificar login duplicado
  if(req.body.login && Object.values(funcs).some(f=>f.login===req.body.login))
    return res.status(400).json({erro:"Login já em uso por outro funcionário"});
  funcs[id]={id,nome,login:req.body.login||"",nivel,permissoes:req.body.permissoes||[nivel],senhaHash:hashSenha(senha),ativo:true,criadoEm:Date.now()};
  salvarJSON(FUNC_FILE,funcs); res.json({ok:true,id});
});
app.patch("/api/funcionarios/:id",(req,res)=>{
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
  salvarJSON(FUNC_FILE,funcs); res.json({ok:true});
});
app.delete("/api/funcionarios/:id",(req,res)=>{
  const funcs=lerJSON(FUNC_FILE,{}); if(!funcs[req.params.id]) return res.status(404).json({erro:"não encontrado"});
  delete funcs[req.params.id]; salvarJSON(FUNC_FILE,funcs); res.json({ok:true});
});
// Reset de senha via URL (temporário para recuperação)
app.get("/api/funcionarios/:id/reset-senha/:novaSenha",(req,res)=>{
  const funcs=lerJSON(FUNC_FILE,{});
  const f=funcs[req.params.id];
  if(!f) return res.status(404).json({erro:"não encontrado"});
  f.senhaHash=hashSenha(req.params.novaSenha);
  salvarJSON(FUNC_FILE,funcs);
  res.json({ok:true,nome:f.nome,login:f.login});
});

app.post("/api/funcionarios/login",(req,res)=>{
  const {login,senha,nivel}=req.body||{};
  const funcs=lerJSON(FUNC_FILE,{});
  const hash=hashSenha(senha||"");
  // busca por login+senha (se tiver login), senão só pela senha (compatibilidade)
  const f=Object.values(funcs).find(x=>{
    const loginOk=login?x.login===login:true;
    return loginOk&&x.senhaHash===hash&&x.ativo&&(!nivel||x.nivel===nivel||(x.permissoes||[]).includes(nivel)||x.nivel==="admin");
  });
  if(!f) return res.status(401).json({erro:"Login ou senha incorretos"});
  res.json({ok:true,funcionario:{id:f.id,nome:f.nome,nivel:f.nivel,permissoes:f.permissoes||[f.nivel]}});
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

app.get("/api/pagamentos/:id",(req,res)=>{
  const pags=lerPag(); res.json({data:pags[String(req.params.id)]||null});
});
app.post("/api/pagamentos/:id",async(req,res)=>{
  try{
    const {valor,formaId,formaNome,obs,funcionarioId,funcionarioNome,substituir}=req.body||{};
    if(!valor||!formaId) return res.status(400).json({erro:"valor e formaId obrigatórios"});
    const pags=lerPag(); const id=String(req.params.id);
    if(!pags[id]) pags[id]={pedidoId:id,valorPago:0,historico:[],statusPagamento:"pendente"};
    const p=pags[id];
    // substituir=true OU se já estava pago: reinicia o valor (não soma)
    const jaTinhaPago=(p.statusPagamento==="pago"||p.statusPagamento==="parcial")&&(p.valorPago||0)>0;
    if(substituir||jaTinhaPago){
      p.historico.push({valor:Number(valor),formaId,formaNome,obs,funcionarioId,funcionarioNome,em:Date.now(),tipo:"substituicao",valorAnterior:p.valorPago||0});
      p.valorPago=+Number(valor).toFixed(2);
    } else {
      p.valorPago=+(p.valorPago+Number(valor)).toFixed(2);
      p.historico.push({valor:Number(valor),formaId,formaNome,obs,funcionarioId,funcionarioNome,em:Date.now(),tipo:"normal"});
    }
    // busca total do pedido pra comparar
    try{
      const ped=await bling(`/pedidos/vendas/${id}`); const total=ped?.data?.total||0;
      p.valorPedido=+Number(total).toFixed(2);
      p.statusPagamento=p.valorPago>=p.valorPedido?"pago":p.valorPago>0?"parcial":"pendente";
    }catch(e){}
    salvarPag(pags);
    addLog(id, "pagamento_registrado", funcionarioId, funcionarioNome, {valor:Number(valor),formaNome,statusPagamento:p.statusPagamento});
    // lança a parcela no Bling
    try{ await bling(`/pedidos/vendas/${id}/financeiro`,{method:"POST",body:JSON.stringify({valor:Number(valor),formasPagamento:[{id:formaId}]})}); }catch(e){}
    res.json({ok:true,pagamento:p});
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

// Buscar histórico de pagamento de um pedido específico
app.get("/api/pagamentos/:id",(req,res)=>{
  const pags=lerPag(); const id=String(req.params.id);
  res.json({data:pags[id]||null});
});

// Formas de pagamento (cadastradas no sistema)
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
    // registra pagamento se veio
    if(pagamento?.valor&&pagamento?.formaId){
      const pags=lerPag();
      if(!pags[id]) pags[id]={pedidoId:id,valorPago:0,historico:[],statusPagamento:"pendente"};
      pags[id].valorPago=+(pags[id].valorPago+Number(pagamento.valor)).toFixed(2);
      pags[id].historico.push({valor:Number(pagamento.valor),formaId:pagamento.formaId,formaNome:pagamento.formaNome,funcionarioId,funcionarioNome,em:Date.now()});
      pags[id].statusPagamento="pago"; salvarPag(pags);
    }
    // muda status no Bling
    await bling(`/pedidos/vendas/${id}/situacoes/${SIT.EM_SEP}`,{method:"PATCH"});
    addLog(id, pagamento?.valor?"enviado_separacao_pago":"enviado_separacao_sem_pagar", funcionarioId, funcionarioNome, pagamento?{valor:pagamento.valor,formaNome:pagamento.formaNome}:{});
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
app.post("/api/fluxo/:id/confirmar-entrega",async(req,res)=>{
  try{
    const {funcionarioId,funcionarioNome,itensNaoEntregues,itensDanificados,valorAbatido,resolucao,clienteId,clienteNome}=req.body||{};
    const id=String(req.params.id);
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
      for(let pg=1;pg<=50;pg++){
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
          if(pg%3===0) await new Promise(r=>setTimeout(r,400)); // delay a cada 3 páginas
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
      const criado=eventos.find(e=>e.evento==="enviado_separacao_pago"||e.evento==="enviado_separacao_sem_pagar");
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
  try{ const nome=(req.query.nome||"").trim(); if(nome.length<2) return res.json({data:[]});
    const d=await bling(`/produtos?nome=${encodeURIComponent(nome)}&limite=100`);
    let l=(d.data||[]).map(p=>({id:p.id,nome:p.nome,codigo:p.codigo,estoque:p.estoque?.saldoVirtualTotal ?? null}));
    const t=nome.toLowerCase(); const f=l.filter(p=>(p.nome||"").toLowerCase().includes(t));
    res.json({data:f.length?f:l});
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
        if(telefone) { atualizacao.celular=telefone; atualizacao.telefone=telefone; }
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
          telefone: telefone || "", celular: telefone || "",
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
    const payload = {
      data: hoje,
      contato: { id: Number(contatoId) },
      itens: itens.map((i) => ({ produto: { id: Number(i.produtoId) }, quantidade: Number(i.quantidade), valor: Number(i.valor) })),
      observacoes: obs,
    };
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
    if (process.env.BLING_VENDEDOR_ID) payload.vendedor = { id: Number(process.env.BLING_VENDEDOR_ID) };
    // NÃO definir situação aqui — criar em Em digitação (padrão) sem condição de pagamento
    // depois mover para AGUARDANDO SEPARAÇÃO
    await new Promise(r=>setTimeout(r,350)); // delay para evitar rate limit
    const pedido = await bling(`/pedidos/vendas`, { method: "POST", body: JSON.stringify(payload) });
    // mover para status AGUARDANDO SEPARAÇÃO após criação
    const pedidoId=pedido?.data?.id;
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
    // se pedir todos (paginar=true), faz paginação automática
    if(req.query.todos==="1"){
      const todos=[];
      // default: últimos 30 dias em fuso Brasília
      const offsetBR=3*60*60*1000;
      const hojeBR=new Date(Date.now()-offsetBR).toISOString().slice(0,10);
      const inicioMes=new Date(new Date(Date.now()-offsetBR).toISOString().slice(0,8)+"01").toISOString().slice(0,10);
      const dataIni=req.query.dataInicial||inicioMes;
      const dataFim=req.query.dataFinal||hojeBR;
      for(let pg=1;pg<=20;pg++){
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
    if (req.query.dataInicial) p.set("dataInicial", req.query.dataInicial);
    if (req.query.dataFinal) p.set("dataFinal", req.query.dataFinal);
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
    const d = await bling(`/produtos?nome=${encodeURIComponent(nome)}&limite=50`);
    const termo = nome.toLowerCase();
    let lista = (d.data || []).map(p => ({ id: p.id, nome: p.nome, codigo: p.codigo, estoque: p.estoque?.saldoVirtualTotal ?? null, precoBling: p.preco ?? null }));
    const f = lista.filter(p => (p.nome || "").toLowerCase().includes(termo));
    lista = f.length ? f : lista;
    // aplica o preço de atacado (tabela publicada); se não houver, usa o preço padrão do Bling
    const tab = lerTabela(); const precoPorCod = {};
    (tab?.model || []).forEach(c => (c.itens || []).forEach(it => (it.bling || []).forEach(b => { precoPorCod[String(b.codigo)] = it.preco; })));
    lista.forEach(p => {
      const atacado = precoPorCod[String(p.codigo)];
      p.precoAtacado = (atacado != null) ? atacado : null;
      p.preco = (atacado != null) ? atacado : (p.precoBling ?? 0);
      p.origemPreco = (atacado != null) ? "atacado" : "bling";
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

app.get("/pedir", (req, res) => res.sendFile(path.join(__dirname, "totem.html")));
app.get("/pedir-tabela", (req, res) => res.sendFile(path.join(__dirname, "pedir-tabela.html")));
app.get("/painel", (req, res) => res.sendFile(path.join(__dirname, "painel.html")));
app.get("/expedicao", (req, res) => res.sendFile(path.join(__dirname, "expedicao.html")));
app.get("/gestao", (req, res) => res.sendFile(path.join(__dirname, "gestao.html")));
app.get("/gerenciamento", (req, res) => res.sendFile(path.join(__dirname, "gerenciamento.html")));
app.get("/funcionarios", (req, res) => res.sendFile(path.join(__dirname, "funcionarios.html")));
app.get("/operacional", (req, res) => res.sendFile(path.join(__dirname, "operacional.html")));
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
app.get("/listas", (req, res) => res.sendFile(path.join(__dirname, "listas.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

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
    const qrUrl=`${BASE}/pedido/${id}/status`;
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
  body{padding:0}
  .nota{max-width:100%}
}
</style></head><body>
<div class="nota">
  <div class="topo">
    <div class="logo">B13 BEBIDAS</div>
    <div class="empresa">Av. Brigadeiro Eduardo Gomes, 1668 — Glória, BH · (31) 99971-9888</div>
  </div>
  <div class="secao">
    <div class="secao-title">Pedido</div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:22px;font-weight:900">#${ped.numero||id}</div>
      <div style="font-size:11px;color:#666">${ped.data?new Date(ped.data).toLocaleDateString("pt-BR"):""}</div>
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
    <div class="total-row total-destaque"><span>TOTAL</span><span>R$ ${(ped.totalProdutos||ped.total||0).toLocaleString("pt-BR",{minimumFractionDigits:2})}</span></div>
    ${pago?`<div class="pag-ok">✅ PAGO — R$ ${(pag.valorPago||0).toLocaleString("pt-BR",{minimumFractionDigits:2})}</div>`:`<div class="pag-pend">⏳ AGUARDANDO PAGAMENTO</div>`}
  </div>
  <div class="qr-area">
    <img src="https://api.qrserver.com/v1/create-qr-code/?size=130x130&data=${encodeURIComponent(qrUrl)}" style="width:130px;height:130px">
    <div style="font-size:10px;color:#888;margin-top:6px">Leia o QR para ver status do pedido</div>
  </div>
  <div class="acoes no-print">
    <a href="${confUrl}" class="btn btn-conf">🔍 Abrir na Conferência</a>
    <button class="btn btn-ghost" onclick="window.print()">🖨️ Imprimir nota</button>
  </div>
</div>
</body></html>`;
    res.setHeader("Content-Type","text/html;charset=utf-8");
    res.send(html);
  }catch(e){ res.status(500).send("Erro: "+e.message); }
});

// Página de status atualizado do pedido (lida via QR)
app.get("/pedido/:id/status", async(req,res)=>{
  try{
    const id=req.params.id;
    const BASE=process.env.RAILWAY_PUBLIC_DOMAIN?`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`:"";
    const [rPed,pag,logArr]=await Promise.all([
      bling(`/pedidos/vendas/${id}`),
      Promise.resolve(lerPag()[id]||null),
      Promise.resolve((lerLog()[id]||[]).slice(-6).reverse()),
    ]);
    const ped=rPed?.data||{};
    const sit=ped.situacao?.nome||ped.situacao?.descricao||ped.situacao?.value||"—";
    console.log("Status pedido",id,"situacao:",JSON.stringify(ped.situacao));
    const sitCor={"AGUARDANDO SEPARAÇÃO (SISTEMA)":"#fbff00","AGUARDANDO SEPARAÇÃO":"#fbff00","Em Separação":"#00aaff","SEPARADO C/ PENDÊNCIAS":"#d400ff","SEPARADO":"#a855f7","Em Rota":"#6d2390","Atendido":"#3FB57A","Em digitação":"#9a95c9"}[sit]||"#9a95c9";
    const pago=pag?.statusPagamento==="pago";
    const confUrl=`${BASE}/conferencia?pedido=${id}`;
    const logHtml=logArr.map(e=>{
      const d=new Date(e.em||0);
      const dt=d.toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
      return `<div style="font-size:12px;padding:5px 0;border-bottom:1px solid #1a1840;color:#cfc9f5">${(e.evento||"").replace(/_/g," ")} <b>${e.funcionarioNome||""}</b><span style="float:right;color:#888;font-size:10px">${dt}</span></div>`;
    }).join("");
    const html=`<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Status Pedido #${ped.numero||id}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0920;color:#e8e4ff;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:20px}
.card{background:#12103a;border:1px solid #2a2660;border-radius:16px;max-width:380px;width:100%;overflow:hidden}
.topo{background:#262366;padding:14px 16px;display:flex;justify-content:space-between;align-items:center}
.logo{font-size:18px;font-weight:900;color:#FF0082}
.num{font-size:13px;color:#cfc9f5}
.status{padding:10px 16px;text-align:center;font-weight:900;font-size:15px;border-bottom:1px solid #2a2660}
.sec{padding:10px 16px;border-bottom:1px solid #2a2660}
.sec-t{font-size:10px;color:#9a95c9;font-weight:700;text-transform:uppercase;margin-bottom:4px}
.total{font-size:20px;font-weight:900;color:#ffd23f}
.pag-ok{color:#a8f0c8;font-size:13px;margin-top:4px}
.pag-pend{color:#ff8090;font-size:13px;margin-top:4px}
.btn-conf{display:block;background:#a855f7;color:#fff;padding:14px;border-radius:10px;text-align:center;font-weight:900;font-size:15px;text-decoration:none;margin:16px}
.rodape{text-align:center;font-size:10px;color:#514c96;padding:10px 16px}
</style></head><body>
<div class="card">
  <div class="topo">
    <div class="logo">B13 BEBIDAS</div>
    <div class="num">Pedido #${ped.numero||id}</div>
  </div>
  <div class="status" style="background:${sitCor}22;color:${sitCor}">${sit}</div>
  <div class="sec">
    <div class="sec-t">Cliente</div>
    <div style="font-size:15px;font-weight:700">${ped.contato?.nome||"—"}</div>
  </div>
  <div class="sec">
    <div class="sec-t">Total</div>
    <div class="total">R$ ${(ped.totalProdutos||ped.total||0).toLocaleString("pt-BR",{minimumFractionDigits:2})}</div>
    ${pago?`<div class="pag-ok">✅ Pago: R$ ${(pag.valorPago||0).toLocaleString("pt-BR",{minimumFractionDigits:2})}</div>`:`<div class="pag-pend">⏳ Aguardando pagamento</div>`}
  </div>
  ${logHtml?`<div class="sec"><div class="sec-t">Histórico</div>${logHtml}</div>`:""}
  <a href="${confUrl}" class="btn-conf">🔍 Abrir na Conferência</a>
  <div class="rodape">Atualizado em ${new Date().toLocaleString("pt-BR")}</div>
</div>
</body></html>`;
    res.setHeader("Content-Type","text/html;charset=utf-8");
    res.send(html);
  }catch(e){ res.status(500).send("Erro: "+e.message); }
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
app.listen(PORT,()=> console.log(`B13 Bling Backend na porta ${PORT} (DATA_DIR=${DATA_DIR})`));
