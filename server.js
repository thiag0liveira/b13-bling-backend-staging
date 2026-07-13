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
  const r=await fetch(API+path,{...options,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json",...(options.headers||{})}});
  const txt=await r.text(); let j; try{ j=txt?JSON.parse(txt):{}; }catch{ j={raw:txt}; }
  if(!r.ok) throw Object.assign(new Error("Erro Bling "+r.status),{status:r.status,body:j});
  return j;
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
app.get("/api/contatos",async(req,res)=>{
  try{ const doc=soDigitos(req.query.doc); if(!doc) return res.status(400).json({erro:"?doc=CPF_ou_CNPJ"});
    const d=await bling(`/contatos?pesquisa=${encodeURIComponent(doc)}`); const l=d?.data||[];
    const a=l.find(c=>soDigitos(c.numeroDocumento)===doc)||null;
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
      if (achado) contatoId = achado.id;
      else {
        const tipo = doc.length === 14 ? "J" : "F";
        const end = cadastro?.endereco || {};
        const contato = {
          nome: nome || ("Cliente " + doc),
          tipo, numeroDocumento: doc, situacao: "A",
          telefone: telefone || "", celular: telefone || "",
          email: (email && /\S+@\S+\.\S+/.test(email)) ? email : undefined,
          endereco: { geral: {
            endereco: end.rua || "", numero: end.numero || "", complemento: end.complemento || "",
            bairro: end.bairro || "", cep: soDigitos(end.cep), municipio: end.cidade || "", uf: end.uf || "",
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
      parcelas: [], // cliente ainda não pagou; a loja registra o pagamento na separação
      observacoes: obs,
    };
    if (entrega && entrega.tipo === "entrega" && Number(entrega.taxa) > 0)
      payload.transporte = { fretePorConta: 0, frete: Number(entrega.taxa) };
    if (process.env.BLING_VENDEDOR_ID) payload.vendedor = { id: Number(process.env.BLING_VENDEDOR_ID) };
    if (process.env.BLING_SITUACAO_ID) payload.situacao = { id: Number(process.env.BLING_SITUACAO_ID) };
    const pedido = await bling(`/pedidos/vendas`, { method: "POST", body: JSON.stringify(payload) });
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
    const p = new URLSearchParams();
    p.set("pagina", req.query.pagina || 1);
    p.set("limite", req.query.limite || 50);
    if (req.query.idsSituacoes) p.set("idsSituacoes[]", req.query.idsSituacoes);
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
    const itens = req.body?.itens;
    if (!Array.isArray(itens)) return res.status(400).json({ erro: "itens inválidos" });
    const atualJson = await bling(`/pedidos/vendas/${req.params.id}`);
    const ped = atualJson?.data; if (!ped) return res.status(404).json({ erro: "pedido não encontrado" });
    const sit = ped.situacao?.id;
    if (sit === 9 || sit === 12) return res.status(400).json({ erro: "Pedido Atendido/Cancelado não pode ser editado." });

    const payload = {
      data: ped.data, contato: { id: ped.contato?.id },
      itens: itens.map(i => ({ produto: { id: Number(i.produtoId) }, quantidade: Number(i.quantidade), valor: Number(i.valor) })),
      observacoes: ped.observacoes || "",
    };
    if (ped.transporte?.frete) payload.transporte = { fretePorConta: ped.transporte.fretePorConta ?? 0, frete: ped.transporte.frete };
    if (ped.vendedor?.id) payload.vendedor = { id: ped.vendedor.id };
    if (ped.situacao?.id) payload.situacao = { id: ped.situacao.id };
    res.json(await bling(`/pedidos/vendas/${req.params.id}`, { method: "PUT", body: JSON.stringify(payload) }));
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
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
app.get("/",(req,res)=> res.send("B13 Bling Backend rodando. Comece em <a href='/auth'>/auth</a>. Totem do cliente em <a href='/pedir'>/pedir</a>."));
app.listen(PORT,()=> console.log(`B13 Bling Backend na porta ${PORT} (DATA_DIR=${DATA_DIR})`));
