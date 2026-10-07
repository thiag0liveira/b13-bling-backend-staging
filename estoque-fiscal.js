// =============================================================================
// ESTOQUE FISCAL (paralelo, só fiscal) — parte 1: ENTRADAS em UNIDADE
// -----------------------------------------------------------------------------
// Módulo separado do server.js de propósito (mesmo padrão do concurso do slogan).
//
// O que faz nesta parte:
//  - lê NF-e de ENTRADA de duas fontes: XML enviado pela tela e notas de entrada
//    que já estão no Bling (leitura sob demanda, em segundo plano, fila lenta);
//  - associa cada item da nota a um produto nosso, APRENDENDO: por vínculo já
//    confirmado (fornecedor + código dele), por código de barras (GTIN) e, nas notas
//    do Bling, pelo código do produto; o que não resolve vira PENDÊNCIA com sugestões
//    e, depois de confirmado uma vez, entra sozinho nas próximas notas;
//  - converte TUDO para UNIDADE (caixa/fardo -> unidade) com o fator vindo do próprio
//    XML (quantidade tributável), do cadastro do produto (itens por caixa) ou da
//    confirmação de quem conferiu. Nada entra como "ok" sem unidade definida;
//  - confere o custo por unidade contra o usual do produto e marca o que destoa.
//
// Esta parte NÃO baixa nada no estoque físico do Bling e NÃO emite nada: só lê e guarda
// em arquivos próprios (fiscal_*.json). O saldo fiscal (entradas menos saídas) vem na
// parte 2, em cima destes dados.
// =============================================================================
import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";

// unidades comerciais que são EMBALAGEM (precisam de fator) e as que já são unidade
const UN_PACK = new Set(["CX", "CXA", "CAIXA", "FD", "FARDO", "PCT", "PACOTE", "PACK", "DZ", "DUZIA", "CT", "CARTELA", "ENG", "ENGRADADO", "BDJ", "BANDEJA", "PAL", "PALETE"]);
const UN_UNIDADE = new Set(["UN", "UND", "UNID", "UNIDADE", "PC", "PÇ", "PEC", "LT", "L", "LATA", "GARRAFA", "GRF", "BT", "BOT", "KG"]);

export function registrarEstoqueFiscal(app, deps) {
  const { bling, blingLento, lerJSON, salvarJSON, requireAdmin, DATA_DIR, sleep, GTIN_INDEX_FILE, rootDir } = deps;

  const NOTAS_FILE = `${DATA_DIR}/fiscal_notas.json`;     // { [chaveOuId]: nota }
  const DEPARA_FILE = `${DATA_DIR}/fiscal_depara.json`;   // { "cnpj|cProd": vínculo }
  const PRODS_FILE = `${DATA_DIR}/fiscal_produtos.json`;  // cache do detalhe dos produtos
  const CONFIG_FILE = `${DATA_DIR}/fiscal_config.json`;

  // fonte única da verdade em memória (gravação imediata em disco). Como o Node roda numa
  // thread só, upload, confirmação e processamento em segundo plano mexem no MESMO objeto
  // sem se atropelar.
  let NOTAS = lerJSON(NOTAS_FILE, {});
  let DEPARA = lerJSON(DEPARA_FILE, {});
  let PRODS = lerJSON(PRODS_FILE, {});
  let CONFIG = lerJSON(CONFIG_FILE, {});
  const gravarNotas = () => salvarJSON(NOTAS_FILE, NOTAS);
  const gravarDepara = () => salvarJSON(DEPARA_FILE, DEPARA);
  const gravarProds = () => salvarJSON(PRODS_FILE, PRODS);

  // ---------------------------------------------------------------- utilitários
  const num = (v) => { const n = Number(String(v == null ? "0" : v).replace(",", ".")); return Number.isFinite(n) ? n : 0; };
  const digitos = (v) => String(v == null ? "" : v).replace(/\D/g, "");
  const up = (v) => String(v == null ? "" : v).trim().toUpperCase();
  const r2 = (n) => +Number(n).toFixed(2);
  const r4 = (n) => +Number(n).toFixed(4);
  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  // GTIN válido = só dígitos, 8 a 14. "SEM GTIN" e afins viram vazio. Zeros à esquerda
  // não contam (EAN-13 em campo de 14 dígitos).
  const gtinLimpo = (v) => { const d = digitos(v); if (d.length < 8 || d.length > 14) return ""; return String(Number(d)) === "0" ? "" : d.replace(/^0+/, ""); };
  const ehPack = (u) => UN_PACK.has(up(u));
  const ehUnidade = (u) => UN_UNIDADE.has(up(u));
  const quem = (req) => String(req?.sessao?.nome || req?.sessao?.funcionarioNome || req?.sessao?.login || "admin").slice(0, 60);

  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true,
    parseTagValue: false, parseAttributeValue: false, trimValues: true,
    isArray: (nome) => nome === "det",
  });

  // ------------------------------------------------------------ leitura do XML
  // Devolve a nota no formato interno. Lança erro com mensagem clara se não for NF-e.
  function lerNFeXml(texto) {
    let j;
    try { j = parser.parse(texto); } catch (e) { throw new Error("o arquivo não é um XML válido"); }
    const nfe = j?.nfeProc?.NFe || j?.procNFe?.NFe || j?.NFe;
    const inf = nfe?.infNFe;
    if (!inf) throw new Error("o XML não é uma NF-e (não achei o grupo infNFe)");
    const chave = digitos(inf["@_Id"]) || digitos(j?.nfeProc?.protNFe?.infProt?.chNFe);
    const ide = inf.ide || {}, emit = inf.emit || {}, dest = inf.dest || {};
    const emissao = Date.parse(ide.dhEmi || ide.dEmi || "") || 0;
    const itens = [].concat(inf.det || []).map((d, ix) => {
      const p = d.prod || {};
      return {
        nItem: Number(d["@_nItem"]) || ix + 1,
        cProd: String(p.cProd == null ? "" : p.cProd).trim(), cEAN: gtinLimpo(p.cEAN), xProd: String(p.xProd || "").trim(),
        ncm: digitos(p.NCM), cfop: digitos(p.CFOP),
        uCom: up(p.uCom), qCom: num(p.qCom), vUnCom: num(p.vUnCom), vProd: num(p.vProd), vDesc: num(p.vDesc),
        cEANTrib: gtinLimpo(p.cEANTrib), uTrib: up(p.uTrib), qTrib: num(p.qTrib), vUnTrib: num(p.vUnTrib),
      };
    });
    if (!itens.length) throw new Error("a nota não tem itens");
    return {
      chave: chave.length === 44 ? chave : "", numero: String(ide.nNF || ""), serie: String(ide.serie || ""), emissao,
      emitente: { cnpj: digitos(emit.CNPJ || emit.CPF), nome: String(emit.xNome || "").trim() },
      destCnpj: digitos(dest.CNPJ || dest.CPF), vNF: num(inf.total?.ICMSTot?.vNF),
      origem: "xml", origemDados: "xml", itens,
    };
  }

  // classe do CFOP só pra mostrar (a regra de contar ou não vem na parte 2)
  function classeCfop(cfop) {
    const c = String(cfop || "");
    if (/^[123](101|102|403|405|401|113|122)/.test(c)) return "compra";
    if (/^[123]910/.test(c)) return "bonificação";
    if (/^[123](202|411|201)/.test(c)) return "devolução";
    if (/^[123](152|409|151)/.test(c)) return "transferência";
    return "outra";
  }

  // ------------------------------------------------------------ produtos nossos
  function montarIndice() {
    const bruto = lerJSON(GTIN_INDEX_FILE, {});
    const porGtin = {}, porCodigo = {}, lista = {};
    Object.keys(bruto).forEach((chave) => {
      const it = bruto[chave]; if (!it || !it.produtoId) return;
      const g = gtinLimpo(chave); if (g) porGtin[g] = it;
      const g2 = gtinLimpo(it.gtin); if (g2) porGtin[g2] = it;
      if (it.codigo) porCodigo[String(it.codigo)] = it;
      lista[it.produtoId] = it;
    });
    const nomes = Object.values(lista).map((it) => ({ produtoId: it.produtoId, nome: it.nome || "", codigo: it.codigo || "", gtin: it.gtin || "", tokens: new Set(norm(it.nome).split(" ").filter((t) => t.length > 1)) }));
    return { porGtin, porCodigo, nomes, total: nomes.length };
  }
  function sugerir(idx, texto, max = 3) {
    const tk = new Set(norm(texto).split(" ").filter((t) => t.length > 1));
    if (!tk.size) return [];
    const out = [];
    for (const p of idx.nomes) {
      if (!p.tokens.size) continue;
      let comum = 0; tk.forEach((t) => { if (p.tokens.has(t)) comum++; });
      if (!comum) continue;
      const score = (2 * comum) / (tk.size + p.tokens.size); // Dice
      if (score >= 0.35) out.push({ produtoId: p.produtoId, nome: p.nome, score: r2(score) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, max);
  }
  // detalhe do produto (itens por caixa, GTIN da embalagem). Uma ida ao Bling por produto,
  // guardada por 30 dias. Falhou? usa o que já tinha, sem travar o processamento.
  async function detalheProduto(produtoId) {
    const c = PRODS[produtoId];
    if (c && Date.now() - (c.em || 0) < 30 * 86400000) return c;
    try {
      const d = (await blingLento(`/produtos/${produtoId}`))?.data;
      if (d) {
        PRODS[produtoId] = {
          id: produtoId, nome: d.nome || "", codigo: d.codigo || "", unidade: up(d.unidade),
          itensPorCaixa: num(d.itensPorCaixa ?? d.dimensoes?.itensPorCaixa ?? d.tributacao?.itensPorCaixa),
          gtin: gtinLimpo(d.gtin || d.codigoBarras), gtinEmbalagem: gtinLimpo(d.gtinEmbalagem), em: Date.now(),
        };
        gravarProds();
        return PRODS[produtoId];
      }
    } catch (e) { /* Bling lento ou fora: segue sem o detalhe */ }
    return c || null;
  }

  // ----------------------------------------------------- conversão para UNIDADE
  function fatorDaDescricao(xProd) {
    // só tira acento: a barra de "C/12" precisa ficar (norm() a apagaria)
    const t = up(String(xProd || "").normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    const ach = [/\bC ?\/ ?(\d{1,2})\b/, /\b(?:CX|CAIXA|FD|FARDO|PACK|PCT) ?(?:C ?\/|COM|DE|X)? ?(\d{1,2})\b/, /\b(\d{1,2}) ?X ?\d/, /\bCOM (\d{1,2})\b/, /\b(\d{1,2})X\b/];
    for (const re of ach) { const m = t.match(re); if (m) { const f = Number(m[1]); if (f >= 2 && f <= 48) return f; } }
    return 0;
  }
  // Devolve { fator, via, confianca } onde fator = UNIDADES por unidade comercial da nota,
  // ou { fator:0, motivo, sugestaoFator } se não dá pra concluir sem alguém confirmar.
  function derivarFator(it, pd) {
    const packCom = ehPack(it.uCom);
    // 1) a unidade comercial já é unidade
    if (!packCom) {
      if (ehUnidade(it.uCom) || !it.uCom) return { fator: 1, via: "unidade comercial já é unidade", confianca: "alta" };
      return { fator: 0, motivo: `unidade "${it.uCom}" desconhecida (não sei se é caixa ou unidade)`, sugestaoFator: fatorDaDescricao(it.xProd) };
    }
    // 2) embalagem: o próprio XML traz a quantidade tributável em unidade (caso mais comum)
    if (ehUnidade(it.uTrib) && it.qTrib > 0 && it.qCom > 0) {
      const f = it.qTrib / it.qCom;
      if (Number.isInteger(r4(f)) && f >= 2) {
        if (pd?.itensPorCaixa > 0 && Math.abs(pd.itensPorCaixa - f) > 0.001) {
          return { fator: f, via: "XML (quantidade tributável)", confianca: "revisar", motivo: `o XML indica ${f} unidades por ${it.uCom}, mas o cadastro do produto diz ${pd.itensPorCaixa} por caixa` };
        }
        return { fator: f, via: "XML (quantidade tributável)", confianca: "alta" };
      }
    }
    // 3) cadastro do produto no Bling
    if (pd?.itensPorCaixa > 0) return { fator: pd.itensPorCaixa, via: "cadastro do produto (itens por caixa)", confianca: "media" };
    // 4) só dá pra sugerir pela descrição ("C/12"): alguém precisa confirmar
    const sug = fatorDaDescricao(it.xProd);
    return { fator: 0, motivo: `${it.uCom} sem fator de conversão para unidade` + (sug ? ` (a descrição sugere ${sug} por ${it.uCom})` : ""), sugestaoFator: sug };
  }

  function custosDoProduto(produtoId, ignorarItem) {
    const v = [];
    Object.values(NOTAS).forEach((n) => (n.itens || []).forEach((i) => { if (i !== ignorarItem && i.produtoId === produtoId && i.status === "ok" && i.custoUn > 0) v.push(i.custoUn); }));
    return v;
  }
  const mediana = (a) => { const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // Associa UM item. Atualiza o próprio objeto do item (status, produto, fator, unidades).
  async function associarItem(nota, it, ctx) {
    const cnpj = nota.emitente?.cnpj || "";
    const chaveVinc = `${cnpj}|${it.cProd}`;
    it.sugestoes = []; it.motivo = ""; it.confianca = ""; it.sugestaoFator = 0;
    let produto = null, fonte = "", fatorVinc = 0;

    // 1) vínculo já aprendido/confirmado (fornecedor + código dele)
    const v = DEPARA[chaveVinc];
    if (v && v.produtoId) { produto = ctx.idx.nomes.find((p) => p.produtoId === v.produtoId) || { produtoId: v.produtoId, nome: v.produtoNome }; fonte = v.fonte === "confirmado" ? "vínculo confirmado" : "vínculo aprendido"; if (v.uCom === it.uCom && v.fator > 0) fatorVinc = v.fator; }
    // 2) código de barras (da unidade tributável primeiro, depois o comercial)
    if (!produto) {
      const g = ctx.idx.porGtin[it.cEANTrib] || ctx.idx.porGtin[it.cEAN];
      if (g) { produto = { produtoId: g.produtoId, nome: g.nome }; fonte = "código de barras"; }
    }
    // 3) nota vinda do Bling: o "código" do item costuma ser o NOSSO código do produto
    if (!produto && nota.origem === "bling") {
      const c = ctx.idx.porCodigo[String(it.cProd)];
      if (c) { produto = { produtoId: c.produtoId, nome: c.nome }; fonte = "código do produto"; }
    }
    if (!produto) {
      it.status = "pendente"; it.produtoId = null; it.produtoNome = "";
      it.motivo = "não achei o produto (sem vínculo, sem código de barras conhecido)";
      it.sugestoes = sugerir(ctx.idx, it.xProd);
      it.sugestaoFator = ehPack(it.uCom) ? fatorDaDescricao(it.xProd) : 0;
      it.qtdUn = 0; it.fator = 0; it.custoUn = 0; it.fonte = "";
      return;
    }
    it.produtoId = produto.produtoId; it.produtoNome = produto.nome || ""; it.fonte = fonte;

    // fator para unidade
    let f;
    if (fatorVinc > 0) f = { fator: fatorVinc, via: "vínculo confirmado", confianca: "alta" };
    else { const pd = await detalheProduto(produto.produtoId); f = derivarFator(it, pd); }
    if (!(f.fator > 0)) {
      it.status = "pendente"; it.motivo = f.motivo || "sem fator de conversão"; it.sugestaoFator = f.sugestaoFator || 0;
      it.qtdUn = 0; it.fator = 0; it.custoUn = 0;
      return;
    }
    it.fator = f.fator; it.fatorVia = f.via; it.confianca = f.confianca;
    it.qtdUn = r4(it.qCom * f.fator);
    it.custoUn = it.qtdUn > 0 ? r4((it.vProd - it.vDesc) / it.qtdUn) : 0;
    if (f.confianca === "revisar") { it.status = "revisar"; it.motivo = f.motivo; return; }
    // custo por unidade muito fora do usual do produto = quase sempre fator errado
    const hist = custosDoProduto(it.produtoId, it);
    if (hist.length >= 2 && it.custoUn > 0) {
      const med = mediana(hist), razao = it.custoUn / med;
      if (razao > 2.5 || razao < 0.4) { it.status = "revisar"; it.motivo = `custo por unidade R$ ${it.custoUn.toFixed(2)} bem diferente do usual (R$ ${med.toFixed(2)}); confira o fator de conversão`; return; }
    }
    it.status = "ok"; it.motivo = "";
    // aprendeu: guarda o vínculo (só se veio de fonte segura) pra próxima nota entrar sozinha
    if (fonte !== "vínculo confirmado" && fonte !== "vínculo aprendido" && cnpj && it.cProd && f.confianca !== "baixa") {
      DEPARA[chaveVinc] = { produtoId: it.produtoId, produtoNome: it.produtoNome, uCom: it.uCom, fator: f.fator, fonte: "aprendido", via: fonte, em: Date.now(), cnpj, cProd: it.cProd, xProd: it.xProd };
      gravarDepara();
    }
  }

  // ---------------------------------------------- processamento em segundo plano
  const PROC = { rodando: false, total: 0, feito: 0, inicio: 0, fim: 0, msg: "" };
  let _outraRodada = false;
  async function processar() {
    if (PROC.rodando) { _outraRodada = true; return; }
    Object.assign(PROC, { rodando: true, total: 0, feito: 0, inicio: Date.now(), fim: 0, msg: "" });
    try {
      do {
        _outraRodada = false;
        const idx = montarIndice();
        const fila = [];
        Object.values(NOTAS).forEach((n) => { if (n.ignorada) return; (n.itens || []).forEach((it) => { if (!it.status || it.status === "novo") fila.push({ n, it }); }); });
        PROC.total += fila.length;
        for (const { n, it } of fila) {
          try { await associarItem(n, it, { idx }); } catch (e) { it.status = "pendente"; it.motivo = "erro ao associar: " + String(e.message || e).slice(0, 80); }
          PROC.feito++;
          if (PROC.feito % 20 === 0) gravarNotas();
        }
        gravarNotas();
      } while (_outraRodada);
    } catch (e) { PROC.msg = String(e.message || e).slice(0, 120); }
    PROC.rodando = false; PROC.fim = Date.now();
  }

  // ------------------------------------------------------------------ entrada
  function guardarNota(nota) {
    const id = nota.chave || `bling:${nota.blingId}`;
    const ex = NOTAS[id];
    if (ex) {
      // a do XML é mais completa que a lida do Bling: troca (reassocia pelos vínculos); o contrário não
      if (ex.origemDados === "xml" || nota.origemDados !== "xml") return { id, duplicada: true };
    }
    nota.id = id; nota.importadaEm = Date.now();
    nota.itens.forEach((it) => { it.status = "novo"; it.classe = classeCfop(it.cfop); });
    NOTAS[id] = nota; gravarNotas();
    return { id, duplicada: false, substituiu: !!ex };
  }
  function avaliarDestino(nota, forcar) {
    const emp = digitos(CONFIG.cnpjEmpresa);
    if (!emp || forcar) return "";
    if (nota.emitente?.cnpj === emp) return "essa nota é de SAÍDA da própria empresa (o emitente é o CNPJ da empresa); aqui entram só notas de compra";
    if (nota.destCnpj && nota.destCnpj !== emp) return "a nota não é destinada ao CNPJ da empresa";
    return "";
  }

  // --------------------------------------------------------- leitura do Bling
  const BLING = { rodando: false, total: 0, feito: 0, importadas: 0, puladas: 0, ignoradas: 0, erros: 0, msg: "", inicio: 0 };
  async function lerNotaDoBling(id) {
    const d = (await blingLento(`/nfe/${id}`))?.data;
    if (!d) throw new Error("sem dados");
    // se o Bling expõe o XML da nota, ele é bem mais rico (códigos de barras e unidade tributável)
    if (typeof d.xml === "string" && /^https?:\/\//i.test(d.xml)) {
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
        const r = await fetch(d.xml, { signal: ctrl.signal }); clearTimeout(t);
        const txt = await r.text();
        if (r.ok && txt.trim().startsWith("<")) { const n = lerNFeXml(txt); n.origem = "bling"; n.origemDados = "xml"; n.blingId = id; return { nota: n, bruto: d }; }
      } catch (e) { /* cai pros itens do próprio Bling */ }
    }
    const itens = (d.itens || []).map((i, ix) => ({
      nItem: ix + 1, cProd: String(i.codigo == null ? "" : i.codigo).trim(), cEAN: gtinLimpo(i.gtin || i.codigoBarras), xProd: String(i.descricao || "").trim(),
      ncm: digitos(i.ncm), cfop: digitos(i.cfop), uCom: up(i.unidade), qCom: num(i.quantidade), vUnCom: num(i.valor), vProd: r2(num(i.quantidade) * num(i.valor)), vDesc: 0,
      cEANTrib: gtinLimpo(i.gtinTributavel), uTrib: up(i.unidade), qTrib: num(i.quantidade), vUnTrib: num(i.valor),
    }));
    return { bruto: d, nota: {
      chave: digitos(d.chaveAcesso).length === 44 ? digitos(d.chaveAcesso) : "", numero: String(d.numero || ""), serie: String(d.serie || ""),
      emissao: Date.parse(String(d.dataEmissao || "").replace(" ", "T")) || 0,
      emitente: { cnpj: digitos(d.contato?.numeroDocumento), nome: String(d.contato?.nome || "") }, destCnpj: "", vNF: num(d.valorNota ?? d.total),
      origem: "bling", origemDados: "bling-itens", blingId: id, itens,
    } };
  }
  async function importarDoBling(dataInicial, dataFinal) {
    if (BLING.rodando) return;
    Object.assign(BLING, { rodando: true, total: 0, feito: 0, importadas: 0, puladas: 0, ignoradas: 0, erros: 0, msg: "Listando as notas de entrada no Bling…", inicio: Date.now() });
    try {
      const ids = [];
      for (let pg = 1; pg <= 40; pg++) {
        const r = await blingLento(`/nfe?tipo=0&dataEmissaoInicial=${dataInicial} 00:00:00&dataEmissaoFinal=${dataFinal} 23:59:59&pagina=${pg}&limite=100`);
        const arr = r?.data || [];
        arr.forEach((n) => ids.push({ id: String(n.id), situacao: Number(n.situacao) }));
        if (arr.length < 100) break;
        await sleep(300);
      }
      BLING.total = ids.length;
      for (const { id, situacao } of ids) {
        BLING.msg = `Lendo nota ${BLING.feito + 1} de ${ids.length}…`;
        const ja = Object.values(NOTAS).some((n) => n.blingId === id);
        if (ja) { BLING.puladas++; BLING.feito++; continue; }
        try {
          const { nota } = await lerNotaDoBling(id);
          nota.situacaoBling = situacao;
          if ([2, 4, 9].includes(situacao)) { nota.ignorada = true; nota.motivoIgnorada = "nota cancelada, rejeitada ou denegada no Bling"; }
          const aviso = avaliarDestino(nota, false);
          if (aviso) { nota.ignorada = true; nota.motivoIgnorada = aviso; }
          const g = guardarNota(nota);
          if (g.duplicada) BLING.puladas++; else if (nota.ignorada) BLING.ignoradas++; else BLING.importadas++;
        } catch (e) { BLING.erros++; }
        BLING.feito++;
        await sleep(150);
      }
      BLING.msg = `Pronto: ${BLING.importadas} nota(s) nova(s), ${BLING.puladas} já existiam, ${BLING.ignoradas} ignorada(s) (cancelada/rejeitada ou de saída), ${BLING.erros} com erro.`;
      processar();
    } catch (e) { BLING.msg = "Falhou ao ler o Bling: " + String(e.message || e).slice(0, 120); }
    BLING.rodando = false;
  }

  // ------------------------------------------------------------------ resumos
  function contagem(n) { const c = { ok: 0, pendente: 0, revisar: 0, novo: 0 }; (n.itens || []).forEach((i) => { c[i.status || "novo"]++; }); return c; }
  function resumoGeral() {
    const t = { notas: 0, ignoradas: 0, itens: 0, ok: 0, pendente: 0, revisar: 0, novo: 0, vinculos: Object.keys(DEPARA).length };
    Object.values(NOTAS).forEach((n) => { if (n.ignorada) { t.ignoradas++; return; } t.notas++; const c = contagem(n); t.itens += (n.itens || []).length; t.ok += c.ok; t.pendente += c.pendente; t.revisar += c.revisar; t.novo += c.novo; });
    return t;
  }

  // =================================================================== ROTAS
  app.get("/estoque-fiscal", (req, res) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate"); res.sendFile(path.join(rootDir, "estoque-fiscal.html")); });

  app.get("/api/fiscal/resumo", requireAdmin, (req, res) => {
    res.json({ resumo: resumoGeral(), processando: PROC, bling: BLING, config: { cnpjEmpresa: CONFIG.cnpjEmpresa || "" } });
  });
  app.post("/api/fiscal/config", requireAdmin, (req, res) => {
    const c = digitos(req.body?.cnpjEmpresa);
    if (c && c.length !== 14) return res.status(400).json({ erro: "O CNPJ precisa ter 14 dígitos." });
    CONFIG.cnpjEmpresa = c; salvarJSON(CONFIG_FILE, CONFIG); res.json({ ok: true, cnpjEmpresa: c });
  });

  // envio de XMLs: { arquivos: [ { nome, xml } ], forcar? }
  app.post("/api/fiscal/xml", requireAdmin, (req, res) => {
    try {
      const arquivos = Array.isArray(req.body?.arquivos) ? req.body.arquivos.slice(0, 60) : [];
      if (!arquivos.length) return res.status(400).json({ erro: "Nenhum arquivo recebido." });
      const out = []; let novas = 0;
      for (const a of arquivos) {
        const nome = String(a?.nome || "arquivo.xml").slice(0, 120);
        try {
          const nota = lerNFeXml(String(a?.xml || ""));
          const aviso = avaliarDestino(nota, !!req.body?.forcar);
          if (aviso) { out.push({ nome, ok: false, erro: aviso, numero: nota.numero, emitente: nota.emitente.nome }); continue; }
          const g = guardarNota(nota);
          if (g.duplicada) { out.push({ nome, ok: true, duplicada: true, numero: nota.numero, emitente: nota.emitente.nome, itens: nota.itens.length }); continue; }
          novas++;
          out.push({ nome, ok: true, numero: nota.numero, emitente: nota.emitente.nome, itens: nota.itens.length, substituiu: !!g.substituiu });
        } catch (e) { out.push({ nome, ok: false, erro: String(e.message || e) }); }
      }
      if (novas) processar();
      res.json({ ok: true, novas, arquivos: out });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });

  app.post("/api/fiscal/bling/importar", requireAdmin, (req, res) => {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const ini = iso.test(String(req.body?.dataInicial || "")) ? req.body.dataInicial : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const fim = iso.test(String(req.body?.dataFinal || "")) ? req.body.dataFinal : hoje;
    if (BLING.rodando) return res.json({ ok: true, jaRodando: true });
    importarDoBling(ini, fim);
    res.json({ ok: true, iniciado: true, dataInicial: ini, dataFinal: fim });
  });
  // diagnóstico: mostra o que o Bling devolve de verdade numa nota de entrada (pra ajustar a leitura)
  app.get("/api/fiscal/diag-nfe/:id", requireAdmin, async (req, res) => {
    try {
      const d = (await bling(`/nfe/${encodeURIComponent(req.params.id)}`))?.data || {};
      res.json({ camposDaNota: Object.keys(d), temXml: typeof d.xml === "string" && !!d.xml, xml: typeof d.xml === "string" ? d.xml.slice(0, 120) : null, primeiroItem: (d.itens || [])[0] || null, qtdItens: (d.itens || []).length, contato: d.contato || null });
    } catch (e) { res.status(e.status || 500).json({ erro: e.message }); }
  });
  app.post("/api/fiscal/reprocessar", requireAdmin, (req, res) => {
    let n = 0;
    Object.values(NOTAS).forEach((nt) => (nt.itens || []).forEach((it) => { if (it.status === "pendente" || (req.body?.tudo && it.status !== "ok")) { it.status = "novo"; n++; } }));
    gravarNotas(); processar(); res.json({ ok: true, itens: n });
  });

  app.get("/api/fiscal/notas", requireAdmin, (req, res) => {
    const lista = Object.values(NOTAS).map((n) => ({ id: n.id, numero: n.numero, serie: n.serie, emissao: n.emissao, emitente: n.emitente?.nome || "", cnpj: n.emitente?.cnpj || "", vNF: n.vNF, origem: n.origem, origemDados: n.origemDados, ignorada: !!n.ignorada, motivoIgnorada: n.motivoIgnorada || "", itens: (n.itens || []).length, contagem: contagem(n) }))
      .sort((a, b) => (b.emissao || 0) - (a.emissao || 0));
    res.json({ data: lista.slice(0, 300), total: lista.length });
  });
  app.get("/api/fiscal/nota/:id", requireAdmin, (req, res) => {
    const n = NOTAS[req.params.id]; if (!n) return res.status(404).json({ erro: "nota não encontrada" });
    res.json({ nota: { ...n, itens: n.itens } });
  });

  // itens que precisam de alguém: sem produto/fator (pendente) ou suspeitos (revisar)
  app.get("/api/fiscal/pendencias", requireAdmin, (req, res) => {
    const so = String(req.query.status || "");
    const grupos = {};
    Object.values(NOTAS).forEach((n) => {
      if (n.ignorada) return;
      (n.itens || []).forEach((it) => {
        if (it.status !== "pendente" && it.status !== "revisar") return;
        if (so && it.status !== so) return;
        const chave = `${n.emitente?.cnpj || ""}|${it.cProd}`;
        const g = grupos[chave] = grupos[chave] || { chave, cnpj: n.emitente?.cnpj || "", fornecedor: n.emitente?.nome || "", cProd: it.cProd, xProd: it.xProd, cEAN: it.cEAN || it.cEANTrib, uCom: it.uCom, uTrib: it.uTrib, ncm: it.ncm, status: it.status, motivo: it.motivo, produtoId: it.produtoId || null, produtoNome: it.produtoNome || "", fator: it.fator || 0, sugestoes: it.sugestoes || [], sugestaoFator: it.sugestaoFator || 0, ocorrencias: 0, qtdTotal: 0, notas: [], exemplo: { qCom: it.qCom, qTrib: it.qTrib, vProd: it.vProd } };
        g.ocorrencias++; g.qtdTotal += it.qCom; if (g.notas.length < 4) g.notas.push(n.numero);
        if (it.status === "pendente") g.status = "pendente";
      });
    });
    const data = Object.values(grupos).sort((a, b) => b.ocorrencias - a.ocorrencias);
    res.json({ data: data.slice(0, 80), total: data.length });
  });

  // busca de produto nosso por nome, código ou código de barras
  app.get("/api/fiscal/produtos", requireAdmin, (req, res) => {
    const q = norm(req.query.q || ""); const dig = digitos(req.query.q || "");
    if (q.length < 2 && dig.length < 6) return res.json({ data: [] });
    const idx = montarIndice(); const tk = q.split(" ").filter(Boolean);
    const data = idx.nomes.filter((p) => (dig.length >= 6 && (digitos(p.gtin) === dig || String(p.codigo) === String(req.query.q))) || (tk.length && tk.every((t) => norm(p.nome).includes(t)))).slice(0, 15)
      .map((p) => ({ produtoId: p.produtoId, nome: p.nome, codigo: p.codigo, gtin: p.gtin }));
    res.json({ data });
  });

  // confirma (ou corrige) o vínculo e o fator: vale pra TODOS os itens desse fornecedor+código
  app.post("/api/fiscal/associar", requireAdmin, (req, res) => {
    try {
      const { cnpj, cProd, uCom } = req.body || {};
      const produtoId = Number(req.body?.produtoId); const fator = num(req.body?.fator);
      if (!produtoId) return res.status(400).json({ erro: "Escolha o produto." });
      if (!(fator > 0) || fator > 1000) return res.status(400).json({ erro: "Informe quantas UNIDADES vêm em cada unidade da nota (ex.: 12 para caixa com 12)." });
      const idx = montarIndice();
      const p = idx.nomes.find((x) => x.produtoId === produtoId);
      if (!p) return res.status(404).json({ erro: "Produto não encontrado no índice de produtos." });
      const chave = `${String(cnpj || "")}|${String(cProd || "")}`;
      DEPARA[chave] = { produtoId, produtoNome: p.nome, uCom: up(uCom), fator, fonte: "confirmado", por: quem(req), em: Date.now(), cnpj: String(cnpj || ""), cProd: String(cProd || ""), xProd: String(req.body?.xProd || "").slice(0, 120) };
      gravarDepara();
      let n = 0;
      Object.values(NOTAS).forEach((nt) => (nt.itens || []).forEach((it) => { if (`${nt.emitente?.cnpj || ""}|${it.cProd}` === chave && up(it.uCom) === up(uCom)) { it.status = "novo"; n++; } }));
      gravarNotas(); processar();
      res.json({ ok: true, itensReprocessados: n });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });

  app.get("/api/fiscal/vinculos", requireAdmin, (req, res) => {
    const data = Object.entries(DEPARA).map(([chave, v]) => ({ chave, ...v })).sort((a, b) => (b.em || 0) - (a.em || 0));
    res.json({ data: data.slice(0, 400), total: data.length });
  });
  app.post("/api/fiscal/vinculo/remover", requireAdmin, (req, res) => {
    const chave = String(req.body?.chave || ""); if (!DEPARA[chave]) return res.status(404).json({ erro: "vínculo não encontrado" });
    delete DEPARA[chave]; gravarDepara();
    Object.values(NOTAS).forEach((nt) => (nt.itens || []).forEach((it) => { if (`${nt.emitente?.cnpj || ""}|${it.cProd}` === chave) it.status = "novo"; }));
    gravarNotas(); processar(); res.json({ ok: true });
  });

  // entradas já convertidas pra UNIDADE, por produto (só itens "ok"), com o que ainda falta
  app.get("/api/fiscal/entradas-produto", requireAdmin, (req, res) => {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const ini = iso.test(String(req.query.dataInicial || "")) ? Date.parse(req.query.dataInicial + "T00:00:00-03:00") : 0;
    const fim = iso.test(String(req.query.dataFinal || "")) ? Date.parse(req.query.dataFinal + "T23:59:59-03:00") : Date.now() + 86400000;
    const por = {}; let pend = 0, rev = 0;
    Object.values(NOTAS).forEach((n) => {
      if (n.ignorada || (n.emissao && (n.emissao < ini || n.emissao > fim))) return;
      (n.itens || []).forEach((it) => {
        if (it.status === "pendente") { pend++; return; } if (it.status === "revisar") { rev++; return; } if (it.status !== "ok") return;
        const p = por[it.produtoId] = por[it.produtoId] || { produtoId: it.produtoId, nome: it.produtoNome, unidades: 0, valor: 0, notas: 0 };
        p.unidades += it.qtdUn; p.valor += (it.vProd - it.vDesc); p.notas++;
      });
    });
    const data = Object.values(por).map((p) => ({ ...p, unidades: r4(p.unidades), valor: r2(p.valor), custoMedioUn: p.unidades > 0 ? r4(p.valor / p.unidades) : 0 })).sort((a, b) => b.unidades - a.unidades);
    res.json({ data, itensPendentes: pend, itensParaRevisar: rev });
  });
}
