// =============================================================================
// CONCURSO DO SLOGAN DA B13 — Rota 2 ("A frase da tela")
// Regulamento v7 (30/09/2026). Período: 01/10/2026 00h01 a 30/10/2026 23h59.
// -----------------------------------------------------------------------------
// Módulo separado do server.js de propósito: é uma ação temporária, e assim fica
// fácil de revisar e de desligar depois (apagar o import e a chamada no server.js).
//
// O que faz:
//  - gera um LINK INDIVIDUAL e de USO ÚNICO por pedido (cláusulas 3.3 e 4.4 b),
//    já travado na quantidade de frases que o pedido dá (4.2: valor em produtos,
//    sem frete, dividido pela faixa, desprezando a fração);
//  - página pública /frase/<token>, com pedido, razão social e CNPJ vindos do Bling
//    (o cliente não digita nem altera); o servidor grava data e hora do envio (8.2 b);
//  - registro manual da frase que chegou pelo WhatsApp oficial (4.4 c);
//  - conferência no Bling antes do julgamento: pedido existe, não foi cancelado,
//    valor ainda dá as frases enviadas (4.6 e 4.7);
//  - planilha da triagem (completa) e planilha às cegas para a comissão (6.5).
//
// Dados: um arquivo só em DATA_DIR (concurso_slogan.json). Toda alteração é feita
// de forma SÍNCRONA (ler → mudar → gravar, sem await no meio), então dois envios
// simultâneos do mesmo link não conseguem gravar duas vezes.
// =============================================================================
import crypto from "crypto";
import path from "path";

const CONCURSO = {
  inicio: Date.parse(process.env.CONCURSO_INICIO || "2026-10-01T00:01:00-03:00"),
  fimEnvio: Date.parse(process.env.CONCURSO_FIM_ENVIO || "2026-10-30T23:59:59-03:00"),
  dataPedidoMin: "2026-10-01",
  dataPedidoMax: "2026-10-30",
  faixas: { atacado: 3000, varejo: 200 },
  // Esta campanha da Rota 2 é SÓ para o atacado (R$ 3.000 por frase). A faixa de
  // varejo (R$ 200) fica desligada; só liga com CONCURSO_PERMITIR_VAREJO=1, se um
  // dia o app vender varejo (regulamento 4.1.2).
  permitirVarejo: process.env.CONCURSO_PERMITIR_VAREJO === "1",
  // 3.2 pede CPF da pessoa indicada pelo estabelecimento, mas 4.5 e 12.2 não listam
  // CPF entre os dados coletados. Fica DESLIGADO até a LL Comunica alinhar o texto;
  // para ligar, defina CONCURSO_PEDIR_CPF=1 no Railway (e atualize a 12.2).
  pedirCpf: process.env.CONCURSO_PEDIR_CPF === "1",
  urlBase: process.env.CONCURSO_URL_BASE || "https://app.b13bebidas.com.br",
  regulamentoUrl: process.env.CONCURSO_REGULAMENTO_URL || "",
  whatsappOficial: "(31) 99971-9888",
  maxCaracteresFrase: 120,
};
// origens do registro local (propostas_atacado.json) que são compra PRESENCIAL (Rota 1)
const ORIGENS_LOJA = new Set(["totem", "caixa", "caixa_atacado", "pdv"]);

export function registrarConcursoSlogan(app, deps) {
  const { bling, blingLento, lerJSON, salvarJSON, requireAdmin, rateLimit, DATA_DIR, SIT,
          lerPropostas, nomeSituacao, ExcelJS, registrarAviso, sleep, rootDir } = deps;
  const ARQ = `${DATA_DIR}/concurso_slogan.json`;

  // ---------- armazenamento ----------
  const ler = () => {
    const d = lerJSON(ARQ, null) || {};
    d.links ||= {}; d.frases ||= []; d.seq ||= 0;
    return d;
  };
  const gravar = (d) => salvarJSON(ARQ, d);

  // ---------- utilidades ----------
  const soDig = (s) => String(s || "").replace(/\D/g, "");
  const agoraISO = () => new Date().toISOString();
  const emBR = (iso) => iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "medium" }) : "";
  const novoToken = () => crypto.randomBytes(16).toString("base64url"); // 22 caracteres, 128 bits
  const tokenValido = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{22}$/.test(t);
  const fmtCNPJ = (d) => (d = soDig(d)).length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : d;
  const mascaraDoc = (d) => {
    d = soDig(d);
    if (d.length === 14) return `${d.slice(0, 2)}.***.***/${d.slice(8, 12)}-${d.slice(12)}`;
    if (d.length === 11) return `***.${d.slice(3, 6)}.***-${d.slice(9)}`;
    return "";
  };
  const limpaTexto = (s, max) => String(s ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  // normalização para achar frases iguais (cap. VIII): sem acento, pontuação e caixa
  const normFrase = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const palavras = (s) => (String(s || "").trim().match(/\S+/g) || []).length;
  const cpfValido = (c) => {
    c = soDig(c); if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
    const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
  };
  const fase = () => {
    const t = Date.now();
    if (t < CONCURSO.inicio) return "nao_iniciado";
    if (t > CONCURSO.fimEnvio) return "encerrado";
    return "aberto";
  };
  const urlDoLink = (token) => `${CONCURSO.urlBase.replace(/\/$/, "")}/frase/${token}`;
  const telWa = (t) => { let d = soDig(t); if (!d) return ""; if (d.length <= 11) d = "55" + d; return d; };
  const mensagemWhatsApp = (L) => {
    // PJ: usa o nome fantasia (razão social em maiúsculas soa robótico); PF: primeiro nome
    const tit = (x) => x.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
    const primeiro = L.cliente?.pj ? (L.cliente.fantasia || "") : tit(String(L.cliente?.nome || "").split(" ")[0] || "");
    const n = L.qtdFrases;
    return [
      `Olá${primeiro ? ", " + primeiro : ""}! Aqui é a B13 Bebidas 💙`,
      ``,
      `O seu pedido nº ${L.numero} dá direito a ${n} frase${n > 1 ? "s" : ""} no Concurso do Slogan da B13. A frase escolhida vira o slogan da B13 e quem escreveu leva R$ 2.000,00 em compras.`,
      ``,
      `Envie pelo link do seu pedido (é individual e só pode ser usado uma vez):`,
      urlDoLink(L.token),
      ``,
      `Prazo: até 30/10, às 23h59. Resultado em 07/11.`,
      `Regulamento completo no link da bio do @b13_bebidas. Só para maiores de 18 anos.`,
    ].join("\n");
  };
  const linkPublicoDTO = (L) => ({
    token: L.token, url: urlDoLink(L.token), numero: L.numero, pedidoId: L.pedidoId, dataPedido: L.dataPedido,
    canal: L.canal, tipo: L.tipo, faixa: L.faixa, valorProdutos: L.valorProdutos, qtdFrases: L.qtdFrases,
    cliente: L.cliente, status: L.status, criadoEm: L.criadoEm, criadoPor: L.criadoPor,
    enviadoEm: L.enviadoEm || null, qtdEnviada: L.qtdEnviada ?? null, viaWhatsapp: !!L.viaWhatsapp, revogadoEm: L.revogadoEm || null, motivoRevogacao: L.motivoRevogacao || "",
    avisos: L.avisos || [], conferencia: L.conferencia || null,
    whatsappTexto: mensagemWhatsApp(L), whatsappLink: telWa(L.cliente?.telefone) ? `https://wa.me/${telWa(L.cliente.telefone)}?text=${encodeURIComponent(mensagemWhatsApp(L))}` : `https://wa.me/?text=${encodeURIComponent(mensagemWhatsApp(L))}`,
  });

  // ---------- leitura do pedido no Bling (fonte da verdade do valor e do cliente) ----------
  async function buscarPedido(numeroOuId, lento) {
    const chamar = lento ? blingLento : bling;
    const t = String(numeroOuId || "").trim();
    if (!/^\d{1,15}$/.test(t)) { const e = new Error("Informe o número do pedido (só dígitos)."); e.status = 400; throw e; }
    let ped = null;
    try { const r = await chamar(`/pedidos/vendas?numero=${encodeURIComponent(t)}`); const a = (r?.data || [])[0]; if (a?.id) ped = (await chamar(`/pedidos/vendas/${a.id}`))?.data; } catch (e) {}
    if (!ped) { try { ped = (await chamar(`/pedidos/vendas/${t}`))?.data; } catch (e) {} }
    if (!ped?.id) { const e = new Error(`Pedido ${t} não encontrado no Bling.`); e.status = 404; throw e; }
    return ped;
  }
  const valorEmProdutos = (ped) => {
    // 4.3: valor pago em produtos, já com desconto, sem frete e sem outras despesas
    const total = Number(ped.total || 0), frete = Number(ped.transporte?.frete || 0), outras = Number(ped.outrasDespesas || 0);
    let v = total ? total - frete - outras : Number(ped.totalProdutos || 0);
    if (Number(ped.totalProdutos) > 0) v = Math.min(v, Number(ped.totalProdutos));
    return Math.max(0, +v.toFixed(2));
  };
  const origemLocal = (pedidoId) => {
    try { const p = Object.values(lerPropostas() || {}).find(x => String(x?.pedidoBlingId) === String(pedidoId)); return p ? String(p.origem || "atacado") : null; }
    catch (e) { return null; }
  };

  // monta (sem gravar) o que o link vai ter, com bloqueios e avisos
  async function prepararPedido({ numero, tipo, canal }) {
    const ped = await buscarPedido(numero, false);
    const bloqueios = [], avisos = [];
    tipo = (tipo === "varejo" && CONCURSO.permitirVarejo) ? "varejo" : "atacado";
    const faixa = CONCURSO.faixas[tipo];
    const valor = valorEmProdutos(ped);
    const qtd = Math.floor(valor / faixa + 1e-9);
    const sit = Number(ped.situacao?.id || 0);
    const data = String(ped.data || "").slice(0, 10);
    if (sit === SIT.CANCELADO) bloqueios.push("Pedido cancelado no Bling (cláusula 4.7).");
    if (!data || data < CONCURSO.dataPedidoMin || data > CONCURSO.dataPedidoMax) bloqueios.push(`Pedido de ${data ? data.split("-").reverse().join("/") : "data desconhecida"}, fora do período de 01/10 a 30/10 (cláusula 2.5).`);
    if (qtd < 1) bloqueios.push(`Valor em produtos de ${valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} não alcança a faixa de R$ ${faixa.toLocaleString("pt-BR")} do ${tipo} (cláusula 4.2).`);
    if (sit === SIT.EM_ABERTO || sit === SIT.EM_DIGITACAO) avisos.push(`Pedido ainda "${nomeSituacao(sit)}". A frase só vale para compra efetivada; confira o pagamento antes de mandar o link.`);
    const orig = origemLocal(ped.id);
    if (orig && ORIGENS_LOJA.has(orig)) bloqueios.push(`Pedido registrado como compra na loja (${orig}). Compra presencial participa pela Rota 1, com o papel (cláusula 4.1.1).`);
    if (!canal) canal = orig === "site" ? "app" : "whatsapp";
    canal = canal === "app" ? "app" : "whatsapp";
    // cliente: o pedido traz nome e documento; telefone vem do contato
    let contato = {};
    if (ped.contato?.id) { try { contato = (await bling(`/contatos/${ped.contato.id}`))?.data || {}; } catch (e) {} }
    const documento = soDig(ped.contato?.numeroDocumento || contato.numeroDocumento);
    const pj = documento.length === 14 || String(ped.contato?.tipoPessoa || contato.tipo || "").toUpperCase() === "J";
    if (tipo === "atacado" && !pj) avisos.push("O cliente do pedido não tem CNPJ no Bling. O link vai pedir o nome do estabelecimento para o próprio cliente preencher.");
    if (/consumidor\s*final/i.test(ped.contato?.nome || "")) bloqueios.push("Pedido em nome de Consumidor Final: não há como identificar o titular da compra (cláusula 3.3).");
    const telefone = soDig(contato.celular || contato.telefone || "");
    if (!telefone) avisos.push("Contato sem celular no Bling: copie a mensagem e envie pela conversa do pedido.");
    return {
      ped, bloqueios, avisos,
      dados: {
        pedidoId: String(ped.id), numero: String(ped.numero || numero), dataPedido: data, canal, tipo, faixa,
        valorProdutos: valor, totalPedido: Number(ped.total || 0), qtdFrases: Math.max(0, qtd),
        situacaoNaGeracao: { id: sit, nome: nomeSituacao(sit) },
        cliente: {
          contatoId: ped.contato?.id || null,
          nome: ped.contato?.nome || contato.nome || "",
          fantasia: contato.fantasia || "",
          documento, pj,
          telefone,
        },
      },
    };
  }

  // =========================== ROTAS PÚBLICAS ===========================
  const limitePublico = rateLimit({ janelaMs: 60000, max: 30, prefixo: "concurso" });
  app.get("/frase/:token", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer"); // o token não vaza para links externos da página
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(path.join(rootDir, "frase.html"));
  });

  app.get("/api/concurso/link/:token", limitePublico, (req, res) => {
    const t = req.params.token;
    const L = tokenValido(t) ? ler().links[t] : null;
    if (!L) return res.status(404).json({ erro: "Link não encontrado. Confira se copiou o endereço inteiro ou fale com a B13 pelo WhatsApp " + CONCURSO.whatsappOficial + "." });
    const f = fase();
    const base = {
      numero: L.numero, dataPedido: L.dataPedido, qtdFrases: L.qtdFrases, tipo: L.tipo,
      estabelecimento: L.cliente?.pj ? { razaoSocial: L.cliente.nome, fantasia: L.cliente.fantasia || "", cnpj: mascaraDoc(L.cliente.documento) } : null,
      pedirEstabelecimento: L.tipo === "atacado" && !L.cliente?.pj,
      pedirCpf: CONCURSO.pedirCpf, prazo: "30/10/2026, às 23h59", resultado: "07/11/2026",
      whatsappOficial: CONCURSO.whatsappOficial, regulamentoUrl: CONCURSO.regulamentoUrl,
      maxCaracteres: CONCURSO.maxCaracteresFrase,
    };
    if (L.status === "revogado") return res.json({ ...base, status: "revogado" });
    if (L.status === "enviado") {
      const minhas = ler().frases.filter(x => x.token === t).map(x => x.frase);
      return res.json({ ...base, status: "enviado", enviadoEm: emBR(L.enviadoEm), frasesEnviadas: minhas });
    }
    res.json({ ...base, status: f });
  });

  app.post("/api/concurso/link/:token/enviar", limitePublico, (req, res) => {
    // TUDO SÍNCRONO daqui até gravar: impede envio duplo do mesmo link.
    const t = req.params.token;
    if (!tokenValido(t)) return res.status(404).json({ erro: "Link não encontrado." });
    const d = ler();
    const L = d.links[t];
    if (!L) return res.status(404).json({ erro: "Link não encontrado." });
    if (L.status === "enviado") return res.status(409).json({ erro: "As frases deste pedido já foram enviadas. Cada link só pode ser usado uma vez." });
    if (L.status === "revogado") return res.status(410).json({ erro: "Este link foi cancelado pela B13. Fale com a gente no WhatsApp " + CONCURSO.whatsappOficial + "." });
    const f = fase();
    if (f === "encerrado") return res.status(410).json({ erro: "O envio de frases encerrou em 30/10/2026, às 23h59." });
    if (f === "nao_iniciado") return res.status(403).json({ erro: "O concurso começa em 01/10/2026." });

    const b = req.body || {};
    const erros = {};
    const nome = limpaTexto(b.nome, 120);
    if (palavras(nome) < 2) erros.nome = "Escreva o nome completo.";
    const whatsapp = soDig(b.whatsapp);
    if (whatsapp.length < 10 || whatsapp.length > 13) erros.whatsapp = "WhatsApp com DDD, só números.";
    const email = limpaTexto(b.email, 120).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) erros.email = "E-mail inválido (ou deixe em branco, é opcional).";
    let cpf = "";
    if (CONCURSO.pedirCpf) { cpf = soDig(b.cpf); if (!cpfValido(cpf)) erros.cpf = "CPF inválido."; }
    const vinculo = limpaTexto(b.vinculo, 60);
    if (L.tipo === "atacado" && !vinculo) erros.vinculo = "Diga qual é o seu vínculo com o estabelecimento.";
    let estabelecimentoInformado = "";
    if (L.tipo === "atacado" && !L.cliente?.pj) {
      estabelecimentoInformado = limpaTexto(b.estabelecimento, 120);
      if (estabelecimentoInformado.length < 2) erros.estabelecimento = "Escreva o nome do estabelecimento.";
    }
    const frases = (Array.isArray(b.frases) ? b.frases : []).map(x => limpaTexto(x, CONCURSO.maxCaracteresFrase + 1)).filter(Boolean);
    if (!frases.length) erros.frases = "Escreva pelo menos uma frase.";
    else if (frases.length > L.qtdFrases) erros.frases = `Este pedido dá direito a ${L.qtdFrases} frase${L.qtdFrases > 1 ? "s" : ""}.`;
    else if (frases.some(x => x.length > CONCURSO.maxCaracteresFrase)) erros.frases = `Cada frase pode ter até ${CONCURSO.maxCaracteresFrase} caracteres.`;
    else if (new Set(frases.map(normFrase)).size !== frases.length) erros.frases = "Há frases repetidas. Cada frase precisa ser diferente.";
    if (b.maior18 !== true) erros.maior18 = "Obrigatório.";
    if (b.autoria !== true) erros.autoria = "Obrigatório.";
    if (b.regulamento !== true) erros.regulamento = "Obrigatório.";
    if (Object.keys(erros).length) return res.status(400).json({ erro: "Confira os campos destacados.", campos: erros });

    const em = agoraISO();
    const autor = { nome, whatsapp, email, vinculo, ...(CONCURSO.pedirCpf ? { cpf } : {}) };
    const estabelecimento = L.tipo === "atacado"
      ? { razaoSocial: L.cliente?.pj ? L.cliente.nome : estabelecimentoInformado, cnpj: L.cliente?.pj ? L.cliente.documento : "", informadoPeloCliente: !L.cliente?.pj }
      : null;
    frases.forEach((frase, i) => {
      d.seq += 1;
      d.frases.push({
        id: "f" + d.seq, seq: d.seq, rota: 2, canal: "link", token: t,
        pedidoId: L.pedidoId, numero: L.numero, ordemNoPedido: i + 1, frase, palavras: palavras(frase),
        autor, estabelecimento, marketing: b.marketing === true,
        declaracoes: { maior18: true, autoria: true, regulamento: true },
        enviadoEm: em, status: "valida", motivo: "",
      });
    });
    L.status = "enviado"; L.enviadoEm = em; L.qtdEnviada = frases.length;
    gravar(d);
    res.json({ ok: true, enviadoEm: emBR(em), frases });
  });

  // =========================== ROTAS INTERNAS (admin) ===========================
  app.get("/concurso", (req, res) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate"); res.sendFile(path.join(rootDir, "concurso.html")); });

  let _conf = { rodando: false, feitos: 0, total: 0, iniciadoEm: null, terminadoEm: null, erro: "" };

  app.get("/api/concurso/resumo", requireAdmin, (req, res) => {
    const d = ler();
    const links = Object.values(d.links);
    const validas = d.frases.filter(x => x.status === "valida");
    res.json({
      fase: fase(), inicio: new Date(CONCURSO.inicio).toISOString(), fimEnvio: new Date(CONCURSO.fimEnvio).toISOString(),
      pedirCpf: CONCURSO.pedirCpf, faixas: CONCURSO.faixas, permitirVarejo: CONCURSO.permitirVarejo,
      links: { total: links.length, aguardando: links.filter(l => l.status === "aberto").length, enviados: links.filter(l => l.status === "enviado").length, revogados: links.filter(l => l.status === "revogado").length,
               frasesLiberadas: links.filter(l => l.status !== "revogado").reduce((s, l) => s + (l.qtdFrases || 0), 0) },
      frases: { total: d.frases.length, validas: validas.length, desclassificadas: d.frases.length - validas.length,
                porLink: validas.filter(x => x.canal === "link").length, porWhatsapp: validas.filter(x => x.canal === "whatsapp").length },
      conferencia: _conf,
    });
  });

  app.get("/api/concurso/links", requireAdmin, (req, res) => {
    const d = ler();
    res.json({ data: Object.values(d.links).sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm))).map(linkPublicoDTO) });
  });

  // pré-visualiza (não grava): mostra valor, quantidade de frases, bloqueios e avisos
  app.get("/api/concurso/pedido/:numero", requireAdmin, async (req, res) => {
    try {
      const p = await prepararPedido({ numero: req.params.numero, tipo: req.query.tipo, canal: req.query.canal });
      const existente = Object.values(ler().links).find(l => l.pedidoId === p.dados.pedidoId && l.status !== "revogado");
      res.json({ ...p.dados, bloqueios: p.bloqueios, avisos: p.avisos, linkExistente: existente ? linkPublicoDTO(existente) : null });
    } catch (e) { res.status(e.status || 500).json({ erro: e.message }); }
  });

  app.post("/api/concurso/links", requireAdmin, async (req, res) => {
    try {
      const { numero, tipo, canal, ignorarAvisos } = req.body || {};
      const p = await prepararPedido({ numero, tipo, canal });
      if (p.bloqueios.length) return res.status(422).json({ erro: p.bloqueios[0], bloqueios: p.bloqueios, avisos: p.avisos, previa: p.dados });
      if (p.avisos.length && ignorarAvisos !== true) return res.status(409).json({ erro: "Confirme os avisos antes de gerar.", precisaConfirmar: true, avisos: p.avisos, previa: p.dados });
      // daqui em diante síncrono: 1 link ativo por pedido (cláusula 4.3)
      const d = ler();
      const ativo = Object.values(d.links).find(l => l.pedidoId === p.dados.pedidoId && l.status !== "revogado");
      if (ativo) return res.json({ ok: true, jaExistia: true, link: linkPublicoDTO(ativo) });
      let token; do { token = novoToken(); } while (d.links[token]);
      d.links[token] = { token, ...p.dados, avisos: p.avisos, status: "aberto", criadoEm: agoraISO(), criadoPor: req.sessao?.nome || "" };
      gravar(d);
      res.json({ ok: true, link: linkPublicoDTO(d.links[token]) });
    } catch (e) { res.status(e.status || 500).json({ erro: e.message }); }
  });

  app.post("/api/concurso/links/:token/revogar", requireAdmin, (req, res) => {
    const d = ler(); const L = d.links[req.params.token];
    if (!L) return res.status(404).json({ erro: "Link não encontrado." });
    if (L.status === "enviado") return res.status(409).json({ erro: "Este link já foi usado. Para tirar as frases da disputa, desclassifique-as na lista de frases." });
    const motivo = limpaTexto(req.body?.motivo, 200);
    if (!motivo) return res.status(400).json({ erro: "Informe o motivo (fica no registro)." });
    L.status = "revogado"; L.revogadoEm = agoraISO(); L.revogadoPor = req.sessao?.nome || ""; L.motivoRevogacao = motivo;
    gravar(d); res.json({ ok: true });
  });

  // pedidos do registro local que provavelmente dão direito e ainda não têm link
  app.get("/api/concurso/sugestoes", requireAdmin, (req, res) => {
    const d = ler();
    const comLink = new Set(Object.values(d.links).filter(l => l.status !== "revogado").map(l => String(l.pedidoId)));
    const ini = Date.parse(CONCURSO.dataPedidoMin + "T00:00:00-03:00"), fim = Date.parse(CONCURSO.dataPedidoMax + "T23:59:59-03:00");
    const lista = Object.values(lerPropostas() || {}).filter(p => {
      if (!p?.pedidoBlingId || comLink.has(String(p.pedidoBlingId))) return false;
      if (ORIGENS_LOJA.has(String(p.origem || "atacado"))) return false;
      if (/consumidor\s*final/i.test(p.cliente?.nome || "")) return false;
      const c = Number(p.criadoEm || 0); if (c < ini || c > fim) return false;
      const frete = p.entrega?.tipo === "entrega" ? Number(p.entrega?.taxa || 0) : 0;
      return (Number(p.total || 0) - frete) >= CONCURSO.faixas.atacado;
    }).map(p => {
      const frete = p.entrega?.tipo === "entrega" ? Number(p.entrega?.taxa || 0) : 0;
      const v = +(Number(p.total || 0) - frete).toFixed(2);
      return { pedidoId: String(p.pedidoBlingId), numero: String(p.pedidoBlingNumero || p.pedidoBlingId), cliente: p.cliente?.nome || "", origem: p.origem || "atacado",
               valorAprox: v, frasesAprox: Math.floor(v / CONCURSO.faixas.atacado), criadoEm: p.criadoEm };
    }).sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0));
    res.json({ data: lista, obs: "Valor do registro local, aproximado. O valor que vale é o do Bling, conferido ao gerar o link." });
  });

  app.get("/api/concurso/frases", requireAdmin, (req, res) => {
    const d = ler();
    const primeiraPorNorm = {};
    [...d.frases].sort((a, b) => String(a.enviadoEm).localeCompare(String(b.enviadoEm)) || a.seq - b.seq).forEach(x => { const n = normFrase(x.frase); if (!(n in primeiraPorNorm)) primeiraPorNorm[n] = x.seq; });
    res.json({ data: d.frases.map(x => ({ ...x, enviadoEmBR: emBR(x.enviadoEm), igualA: primeiraPorNorm[normFrase(x.frase)] !== x.seq ? primeiraPorNorm[normFrase(x.frase)] : null,
      conferencia: d.links[x.token]?.conferencia || (x.conferencia || null) })).sort((a, b) => b.seq - a.seq) });
  });

  // 4.4 c: frase que chegou pelo WhatsApp oficial (respondendo à mensagem do pedido)
  app.post("/api/concurso/frases/whatsapp", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const recebidaEm = Date.parse(b.recebidaEm || "");
      if (!recebidaEm) return res.status(400).json({ erro: "Informe a data e a hora da mensagem, como o WhatsApp mostra." });
      if (recebidaEm < CONCURSO.inicio || recebidaEm > CONCURSO.fimEnvio) return res.status(422).json({ erro: "A mensagem é de fora do período de envio (cláusula 2.5)." });
      const frases = (Array.isArray(b.frases) ? b.frases : [b.frase]).map(x => limpaTexto(x, CONCURSO.maxCaracteresFrase)).filter(Boolean);
      const nome = limpaTexto(b.nome, 120);
      if (!frases.length || palavras(nome) < 2) return res.status(400).json({ erro: "Frase e nome completo são obrigatórios (cláusula 4.5)." });
      const p = await prepararPedido({ numero: b.numero, tipo: b.tipo, canal: "whatsapp" });
      if (p.bloqueios.length) return res.status(422).json({ erro: p.bloqueios[0], bloqueios: p.bloqueios });
      // síncrono daqui em diante
      const d = ler();
      const doPedido = d.frases.filter(x => x.pedidoId === p.dados.pedidoId);
      if (doPedido.length + frases.length > p.dados.qtdFrases) return res.status(422).json({ erro: `O pedido dá direito a ${p.dados.qtdFrases} frase(s) e já tem ${doPedido.length} registrada(s).` });
      const linkAberto = Object.values(d.links).find(l => l.pedidoId === p.dados.pedidoId && l.status === "aberto");
      const estab = p.dados.tipo === "atacado" ? { razaoSocial: p.dados.cliente.pj ? p.dados.cliente.nome : limpaTexto(b.estabelecimento, 120), cnpj: p.dados.cliente.pj ? p.dados.cliente.documento : "", informadoPeloCliente: !p.dados.cliente.pj } : null;
      if (p.dados.tipo === "atacado" && !estab.razaoSocial) return res.status(400).json({ erro: "No atacado, informe o nome do estabelecimento." });
      const em = new Date(recebidaEm).toISOString();
      frases.forEach((frase, i) => {
        d.seq += 1;
        d.frases.push({ id: "f" + d.seq, seq: d.seq, rota: 2, canal: "whatsapp", token: linkAberto?.token || null,
          pedidoId: p.dados.pedidoId, numero: p.dados.numero, ordemNoPedido: doPedido.length + i + 1, frase, palavras: palavras(frase),
          autor: { nome, whatsapp: soDig(b.whatsapp), email: "", vinculo: limpaTexto(b.vinculo, 60) }, estabelecimento: estab,
          marketing: b.marketing === true, enviadoEm: em, registradoEm: agoraISO(), registradoPor: req.sessao?.nome || "",
          valorPedido: p.dados.valorProdutos, status: "valida", motivo: "" });
      });
      // o link do mesmo pedido deixa de valer, senão o cliente mandaria pelos dois canais
      if (linkAberto) { linkAberto.status = "enviado"; linkAberto.enviadoEm = em; linkAberto.viaWhatsapp = true; linkAberto.qtdEnviada = frases.length; }
      gravar(d);
      res.json({ ok: true, registradas: frases.length });
    } catch (e) { res.status(e.status || 500).json({ erro: e.message }); }
  });

  // triagem (cap. XI): desclassificar / reabilitar, sempre com motivo para a ata (11.3)
  app.post("/api/concurso/frases/:id/status", requireAdmin, (req, res) => {
    const d = ler(); const x = d.frases.find(f => f.id === req.params.id);
    if (!x) return res.status(404).json({ erro: "Frase não encontrada." });
    const status = req.body?.status === "valida" ? "valida" : "desclassificada";
    const motivo = limpaTexto(req.body?.motivo, 200);
    if (status === "desclassificada" && !motivo) return res.status(400).json({ erro: "Informe o motivo (vai para a ata)." });
    x.status = status; x.motivo = status === "valida" ? "" : motivo;
    (x.historico ||= []).push({ em: agoraISO(), por: req.sessao?.nome || "", status, motivo });
    gravar(d); res.json({ ok: true });
  });

  // 4.6 / 4.7: confere no Bling todos os pedidos que mandaram frase. Roda em segundo
  // plano, um pedido por vez, na fila LENTA do Bling (não atrapalha o caixa).
  app.post("/api/concurso/conferir", requireAdmin, (req, res) => {
    if (_conf.rodando) return res.json({ ok: true, jaRodando: true, conferencia: _conf });
    const d = ler();
    const pedidos = [...new Set(d.frases.map(x => x.pedidoId))];
    _conf = { rodando: true, feitos: 0, total: pedidos.length, iniciadoEm: agoraISO(), terminadoEm: null, erro: "" };
    (async () => {
      for (const pid of pedidos) {
        let r;
        try {
          const ped = (await blingLento(`/pedidos/vendas/${pid}`))?.data;
          const sit = Number(ped?.situacao?.id || 0);
          const ref = Object.values(ler().links).find(l => l.pedidoId === pid) || {};
          const faixa = ref.faixa || CONCURSO.faixas.atacado;
          const valor = ped ? valorEmProdutos(ped) : 0;
          const enviadas = ler().frases.filter(x => x.pedidoId === pid).length;
          const permitidas = Math.floor(valor / faixa + 1e-9);
          const problemas = [];
          if (!ped) problemas.push("pedido não encontrado");
          if (sit === SIT.CANCELADO) problemas.push("pedido cancelado");
          if (sit === SIT.EM_ABERTO || sit === SIT.EM_DIGITACAO) problemas.push(`pedido ainda "${nomeSituacao(sit)}" (compra não efetivada)`);
          if (ped && permitidas < enviadas) problemas.push(`valor atual dá ${permitidas} frase(s), foram enviadas ${enviadas}`);
          r = { em: agoraISO(), situacaoId: sit, situacao: nomeSituacao(sit), valorAtual: valor, frasesPermitidas: permitidas, enviadas, ok: !problemas.length, problemas };
        } catch (e) { r = { em: agoraISO(), ok: false, problemas: ["erro ao consultar o Bling: " + String(e.message || e).slice(0, 120)] }; }
        // grava o resultado (síncrono, relendo o arquivo para não perder envios feitos no meio)
        const d2 = ler();
        Object.values(d2.links).filter(l => l.pedidoId === pid).forEach(l => { l.conferencia = r; });
        d2.frases.filter(x => x.pedidoId === pid).forEach(x => { x.conferencia = r; });
        gravar(d2);
        _conf.feitos++;
        await sleep(300);
      }
      _conf.rodando = false; _conf.terminadoEm = agoraISO();
      try {
        const comProblema = ler().frases.filter(x => x.conferencia && !x.conferencia.ok).length;
        if (comProblema) registrarAviso({ tipo: "concurso_conferencia", titulo: `Concurso do slogan: ${comProblema} frase(s) com problema na conferência do Bling`, oQueFazer: "Abra Concurso do Slogan e veja a coluna Conferência antes da triagem.", fingerprint: "concurso-conf-" + _conf.terminadoEm, link: "/concurso" });
      } catch (e) {}
    })().catch(e => { _conf.rodando = false; _conf.erro = e.message; });
    res.json({ ok: true, conferencia: _conf });
  });

  app.get("/api/concurso/exportar", requireAdmin, async (req, res) => {
    try {
      const modo = req.query.modo === "cega" ? "cega" : "triagem";
      const d = ler();
      const wb = new ExcelJS.Workbook(); wb.creator = "B13 Bebidas"; wb.created = new Date();
      const cab = (ws) => { const r = ws.getRow(1); r.font = { bold: true, color: { argb: "FFFFFFFF" } }; r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C1846" } }; };
      const ordem = [...d.frases].sort((a, b) => String(a.enviadoEm).localeCompare(String(b.enviadoEm)) || a.seq - b.seq);
      if (modo === "cega") {
        // 6.5: sem nome do autor, sem canal, sem valor da compra. Só número e frase.
        const ws = wb.addWorksheet("Rota 2 - às cegas", { views: [{ state: "frozen", ySplit: 1 }] });
        ws.columns = [{ header: "Nº", key: "seq", width: 8 }, { header: "Frase", key: "frase", width: 70 }, { header: "Palavras", key: "palavras", width: 10 }];
        cab(ws);
        ordem.filter(x => x.status === "valida").forEach(x => ws.addRow({ seq: x.seq, frase: x.frase, palavras: x.palavras }));
      } else {
        const primeira = {}; ordem.forEach(x => { const n = normFrase(x.frase); if (!(n in primeira)) primeira[n] = x.seq; });
        const ws = wb.addWorksheet("Rota 2 - triagem", { views: [{ state: "frozen", ySplit: 1 }] });
        ws.columns = [
          { header: "Nº", key: "seq", width: 7 }, { header: "Recebida em", key: "em", width: 20 }, { header: "Canal", key: "canal", width: 11 },
          { header: "Pedido", key: "numero", width: 10 }, { header: "Data pedido", key: "dataPedido", width: 12 }, { header: "Valor produtos", key: "valor", width: 15 },
          { header: "Frases do pedido", key: "qtd", width: 10 }, { header: "Estabelecimento", key: "estab", width: 32 }, { header: "CNPJ", key: "cnpj", width: 20 },
          { header: "Autor", key: "autor", width: 28 }, { header: "Vínculo", key: "vinculo", width: 16 }, { header: "WhatsApp", key: "wa", width: 16 },
          { header: "E-mail", key: "email", width: 26 }, ...(CONCURSO.pedirCpf ? [{ header: "CPF", key: "cpf", width: 15 }] : []),
          { header: "Aceita promoções", key: "mkt", width: 10 },
          { header: "Frase", key: "frase", width: 50 }, { header: "Palavras", key: "palavras", width: 9 }, { header: "Igual à frase nº", key: "igual", width: 10 },
          { header: "Conferência Bling", key: "conf", width: 34 }, { header: "Status", key: "status", width: 15 }, { header: "Motivo", key: "motivo", width: 30 },
          { header: "Registrado por", key: "regpor", width: 16 },
        ];
        cab(ws);
        ordem.forEach(x => {
          const L = d.links[x.token] || {};
          const c = x.conferencia || L.conferencia;
          const row = ws.addRow({
            seq: x.seq, em: emBR(x.enviadoEm), canal: x.canal === "link" ? "Link" : "WhatsApp", numero: x.numero, dataPedido: L.dataPedido ? L.dataPedido.split("-").reverse().join("/") : "",
            valor: L.valorProdutos ?? x.valorPedido ?? null, qtd: L.qtdFrases ?? "", estab: x.estabelecimento?.razaoSocial || "", cnpj: x.estabelecimento?.cnpj ? fmtCNPJ(x.estabelecimento.cnpj) : "",
            autor: x.autor?.nome || "", vinculo: x.autor?.vinculo || "", wa: x.autor?.whatsapp || "", email: x.autor?.email || "", cpf: x.autor?.cpf || "",
            mkt: x.marketing ? "Sim" : "Não", frase: x.frase, palavras: x.palavras, igual: primeira[normFrase(x.frase)] !== x.seq ? primeira[normFrase(x.frase)] : "",
            conf: !c ? "não conferido" : (c.ok ? `OK · ${c.situacao || ""}` : c.problemas.join("; ")), status: x.status === "valida" ? "Válida" : "Desclassificada", motivo: x.motivo || "",
            regpor: x.registradoPor || "",
          });
          row.getCell("valor").numFmt = '"R$" #,##0.00';
        });
      }
      const nome = `concurso-slogan-rota2-${modo}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${nome}"`);
      await wb.xlsx.write(res); res.end();
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
}
