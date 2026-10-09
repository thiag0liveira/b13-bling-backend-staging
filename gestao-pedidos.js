// =============================================================================
// GESTÃO DE PEDIDOS — torre de controle, pipeline por etapa, indicadores e linha do tempo
// -----------------------------------------------------------------------------
// Alimenta o novo menu da tela de Pedidos. Princípio: gastar o MÍNIMO de chamadas ao Bling.
//
//  - PIPELINE: UMA consulta ao Bling (1 a 3 páginas) traz todos os pedidos em andamento de todas
//    as etapas de uma vez; o resultado fica guardado por 60s e é compartilhado por quem pedir.
//    Substitui a atualização de 40 pedidos, um por um, que rodava a cada minuto.
//  - TUDO O RESTO sai do que o próprio sistema já registra, SEM chamar o Bling: histórico de cada
//    pedido (quem fez o quê e quando), registro local dos pedidos, caixa, viagens e vendas a prazo.
//    Daí vêm o tempo parado em cada etapa, os alertas, os indicadores e a linha do tempo.
// =============================================================================

const BRT = 3 * 3600 * 1000;
const diaBR = (ms) => new Date(ms - BRT).toISOString().slice(0, 10);
const inicioDiaBR = (iso) => Date.parse(iso + "T00:00:00-03:00");
const horaBR = (ms) => new Date(ms - BRT).getUTCHours();
const r2 = (n) => +Number(n).toFixed(2);
const minutos = (ms) => Math.round(ms / 60000);

// Etapas na ordem em que o pedido anda, com os limites de tempo (minutos) pra acender o alerta:
// [atenção (amarelo), crítico (vermelho)]. Ajustável aqui num lugar só.
const ETAPAS = [
  { key: "aguardando", rotulo: "Aguardando separação", icone: "🟡", limite: [20, 45] },
  { key: "fila_sep",   rotulo: "Na fila de separação", icone: "📋", limite: [15, 30] },
  { key: "separando",  rotulo: "Sendo separado",       icone: "🧑‍🔧", limite: [40, 75] },
  { key: "pendencia",  rotulo: "Com pendências",       icone: "🛠️", limite: [30, 90] },
  { key: "separado",   rotulo: "Separado",             icone: "✅", limite: [30, 60] },
  { key: "conferencia", rotulo: "Conferência de entrega", icone: "🔍", limite: [45, 90] },
  { key: "rota",       rotulo: "Em rota",              icone: "🛵", limite: [120, 240] },
  // a entrega NÃO muda o pedido pra Atendido no Bling (ele segue "Em rota" lá): o registro de que foi
  // entregue fica no nosso sistema, então "entregue" é uma etapa daqui, sem alerta de tempo
  { key: "entregue",   rotulo: "Entregue (registrada)", icone: "🏠", limite: [null, null] },
  { key: "prazo",      rotulo: "A prazo",              icone: "⏰", limite: [null, null] },
];
const ETAPA_POR_KEY = Object.fromEntries(ETAPAS.map((e) => [e.key, e]));
const LIMITE_SITE_MIN = [10, 30]; // proposta do site esperando revisão

const ROTULOS_EVENTO = {
  pedido_criado_totem: "Pedido criado no totem", pedido_criado_atacado: "Pedido criado (atacado)",
  pedido_incluido_no_caixa: "Incluído no caixa", pedido_online_cancelado: "Pedido online cancelado",
  enviado_separacao: "Enviado para separação", enviado_separacao_pago: "Enviado para separação (já pago)",
  separar_para_entregar: "Enviado para separação (entrega)",
  pedido_aberto_separacao: "Separação iniciada", pedido_assumido: "Pedido assumido por outra pessoa",
  pedido_adotado: "Pedido adotado", pedido_liberado_separacao: "Separação liberada",
  pedido_liberado_conferencia: "Conferência liberada", pedido_liberado_automatico: "Liberado automaticamente (tempo esgotado)",
  separacao_completa: "Separação concluída", separacao_com_falta: "Separação concluída com falta",
  seguiu_sem_pendencias: "Seguiu sem as pendências", pedido_aberto_conferencia: "Conferência iniciada",
  conferido_entrega: "Conferido (para entrega)", conferido_retirada: "Conferido (retirada)", conferido_prazo: "Conferido (a prazo)",
  voltou_separacao: "Voltou para a separação", entrega_agendada: "Entrega agendada",
  entrega_finalizada_motorista: "Entregue pelo motorista", entrega_finalizada_gerente: "Entrega registrada pelo escritório",
  entrega_confirmada: "Entrega confirmada", entrega_com_ocorrencia: "Entrega com ocorrência",
  entrega_nao_realizada_gerente: "Entrega não realizada", pagamento_registrado: "Pagamento registrado",
  pagamento_editado_caixa: "Pagamento corrigido no caixa", pagamento_editado_gestao: "Pagamento corrigido pela gestão",
  pagamento_resetado: "Pagamento zerado", venda_a_prazo: "Venda a prazo", itens_retirados: "Itens retirados",
  itens_acrescentados: "Itens acrescentados", itens_editados: "Itens editados", itens_alterados_caixa: "Itens alterados no caixa",
  itens_alterados_gestao: "Itens alterados pela gestão", situacao_alterada: "Situação alterada",
  tipo_entrega_alterado: "Tipo de entrega alterado", observacao_salva: "Observação salva",
  retirada_convertida_frete_removido: "Convertido para retirada", venda_cancelada_caixa: "Venda cancelada no caixa",
  venda_cancelada_gestao: "Venda cancelada pela gestão",
};

export function registrarGestaoPedidos(app, deps) {
  const { bling, SIT, nomeSituacao, montarPedidoDoBling, lerLog, lerFilaSep, lerLocks, lerCaixaSessoes, lerPag,
    lerVendasPrazo, lerPropostas, lerViagensAtivas, mapaEntregasLocais, mapaAlteracoes } = deps;

  // --------------------------------------------------------------------- histórico -> marcos
  // Lê o histórico UMA vez (guardado 15s) e tira, de cada pedido, os momentos que importam.
  let _marcosCache = { t: 0, mapa: {}, log: {} };
  function marcosDoLog() {
    if (Date.now() - _marcosCache.t < 15000) return _marcosCache;
    const log = lerLog(); const mapa = {};
    for (const pid of Object.keys(log)) {
      const m = {}; let ultimo = 0;
      for (const e of log[pid] || []) {
        const n = String(e.evento || ""), t = e.em || 0;
        if (n.startsWith("pedido_criado_") || n === "pedido_incluido_no_caixa") m.criado = m.criado || t;
        else if (n.startsWith("enviado_separacao") || n === "separar_para_entregar") { m.envio = t; m.envioPor = e.funcionarioNome || ""; delete m.entregue; }
        else if (n === "pedido_aberto_separacao") { m.inicioSep = m.inicioSep || t; m.sepPor = e.funcionarioNome || m.sepPor; }
        // quem SEPAROU é quem concluiu a separação (na Mesa ou na Expedição). "Pendências resolvidas"
        // é outra pessoa (gestão/caixa) decidindo o que fazer com a falta: NÃO leva o crédito da separação
        // nem estica o tempo dela. Só vale como fim da separação se não houve conclusão registrada antes.
        else if (n === "separacao_completa" || n === "separacao_com_falta") { m.fimSep = t; m.fimSepPor = e.funcionarioNome || m.sepPor || ""; }
        else if (n === "seguiu_sem_pendencias") { m.pendResolvidaEm = t; m.pendResolvidaPor = e.funcionarioNome || ""; if (!m.fimSep) { m.fimSep = t; m.fimSepPor = e.funcionarioNome || m.sepPor || ""; } }
        else if (n.startsWith("conferido_")) { m.conferido = t; m.confPor = e.funcionarioNome || ""; }
        else if (n === "voltou_separacao") { m.envio = t; delete m.inicioSep; delete m.fimSep; delete m.conferido; delete m.entregue; }
        else if (n.startsWith("entrega_finalizada_") || n === "entrega_confirmada") m.entregue = t;
        if (t > ultimo) ultimo = t;
      }
      m.ultimo = ultimo; mapa[pid] = m;
    }
    _marcosCache = { t: Date.now(), mapa, log };
    return _marcosCache;
  }

  // --------------------------------------------------------------------- pagamentos (1 passada)
  let _pagCache = { t: 0, porId: {}, porNum: {} };
  function indicePagamentos() {
    if (Date.now() - _pagCache.t < 20000) return _pagCache;
    const porId = {}, porNum = {};
    try {
      for (const s of lerCaixaSessoes().sessoes || []) {
        for (const m of s.movimentos || []) {
          if (m.tipo !== "venda" || m.cancelado) continue;
          const info = { pago: true, onde: (s.tipoCaixa || "frente") === "atacado" ? "Caixa Atacado" : "Frente de Caixa",
            quando: m.em || 0, valor: Number(m.total) || 0,
            formas: (m.pagamentos || []).map((x) => ({ formaNome: x.formaNome || "", valor: Number(x.valor) || 0 })), troco: Number(m.troco) || 0 };
          if (m.pedidoId != null) porId[String(m.pedidoId)] = info;
          if (m.numero != null) porNum[String(m.numero)] = info;
        }
      }
    } catch (e) { /* sem caixa: segue sem */ }
    _pagCache = { t: Date.now(), porId, porNum };
    return _pagCache;
  }
  function pagamentoDe(id, numero, prazoReg) {
    if (prazoReg && !prazoReg.pago) return { pago: false, prazo: true, valor: Number(prazoReg.total) || 0 };
    const ix = indicePagamentos();
    const hit = ix.porId[String(id)] || (numero != null ? ix.porNum[String(numero)] : null);
    if (hit) return hit;
    try {
      const pg = lerPag()[String(id)];
      if (pg && pg.statusPagamento === "pago") return { pago: true, onde: "Registro de pagamento", valor: Number(pg.valorPago) || 0,
        formas: (pg.historico || []).map((h) => ({ formaNome: h.formaNome || "", valor: Number(h.valor) || 0 })) };
      if (pg && pg.statusPagamento === "parcial") return { pago: false, parcial: true, valorPago: Number(pg.valorPago) || 0, valorPedido: Number(pg.valorPedido) || 0 };
    } catch (e) {}
    return { pago: false };
  }

  // --------------------------------------------------------------------- etapa, tempo parado e alertas
  function etapaDe(p, lock) {
    const s = Number(p.situacaoId);
    if (s === SIT.EM_ROTA && p.entregaLocal) return "entregue";
    if (s === SIT.AGUARDANDO) return "aguardando";
    if (s === SIT.EM_SEP) return lock && (lock.tipo || "separacao") === "separacao" ? "separando" : "fila_sep";
    if (s === SIT.SEP_PEND) return "pendencia";
    if (s === SIT.SEPARADO) return "separado";
    if (s === SIT.CONF_ENTREGA) return "conferencia";
    if (s === SIT.EM_ROTA) return "rota";
    if (s === SIT.PRAZO) return "prazo";
    return null;
  }
  function desdeDa(etapa, p, m, fila, lock, viagem, prazoReg) {
    const f = fila[String(p.id)];
    switch (etapa) {
      case "aguardando": return m.criado || p.criadoEm || null;
      case "fila_sep": return m.envio || (f && f.em) || m.ultimo || null;
      case "separando": return m.inicioSep || (lock && (lock.inicio || lock.criadoEm)) || m.envio || m.ultimo || null;
      case "pendencia": case "separado": return m.fimSep || m.ultimo || null;
      case "conferencia": return m.conferido || m.fimSep || m.ultimo || null;
      case "rota": return (viagem && viagem.iniciadaEm) || m.conferido || m.ultimo || null;
      case "entregue": return (p.entregaLocal && p.entregaLocal.em) || m.entregue || m.ultimo || null;
      case "prazo": return (prazoReg && prazoReg.em) || m.ultimo || null;
      default: return m.ultimo || null;
    }
  }
  function nivelPorTempo(limite, min) {
    if (!limite || limite[0] == null || min == null) return 0;
    if (min >= limite[1]) return 2;
    if (min >= limite[0]) return 1;
    return 0;
  }

  // --------------------------------------------------------------------- PIPELINE
  let _pipe = { em: 0, dados: null, rodando: null };
  async function montarPipeline() {
    const ids = [SIT.AGUARDANDO, SIT.EM_SEP, SIT.SEP_PEND, SIT.SEPARADO, SIT.CONF_ENTREGA, SIT.EM_ROTA, SIT.PRAZO].filter(Boolean);
    let brutos = []; let chamadas = 0;
    for (let pg = 1; pg <= 3; pg++) {
      const params = new URLSearchParams({ pagina: pg, limite: 100 });
      ids.forEach((i) => params.append("idsSituacoes[]", i));
      const r = await bling(`/pedidos/vendas?${params.toString()}`); chamadas++;
      const arr = r?.data || [];
      brutos = brutos.concat(arr);
      if (arr.length < 100) break;
    }
    const agora = Date.now();
    const { mapa: marcos } = marcosDoLog();
    const fila = lerFilaSep(); const locks = lerLocks(); const prazos = lerVendasPrazo();
    const props = lerPropostas() || {}; const porBling = {};
    Object.values(props).forEach((pr) => { if (pr && pr.pedidoBlingId) porBling[String(pr.pedidoBlingId)] = pr; });
    const viagens = lerViagensAtivas();
    const viagemDoPedido = {}; const viagensAbertas = [];
    Object.values(viagens).forEach((v) => {
      if (!v || v.canceladaEm || v.finalizadaEm) return;
      const ent = v.entregas || {};
      const entregues = (v.pedidoIds || []).filter((pid) => ent[String(pid)]?.status === "entregue").length;
      viagensAbertas.push({ token: v.token, motorista: v.motoristaNome || "", carro: v.carroNome || "", iniciadaEm: v.iniciadaEm || 0,
        pedidoIds: (v.pedidoIds || []).map(String), total: (v.pedidoIds || []).length, entregues, naoEntregues: (v.pedidoIds || []).filter((pid) => ent[String(pid)]?.status === "nao_entregue").length });
      (v.pedidoIds || []).forEach((pid) => { viagemDoPedido[String(pid)] = v; });
    });
    const entLocais = mapaEntregasLocais();

    const vistos = new Set(); const pedidos = []; let antigosEmRota = 0;
    for (const b of brutos) {
      if (!b || !b.id || vistos.has(String(b.id))) continue; vistos.add(String(b.id));
      const p = montarPedidoDoBling(b);
      if (p.cancelado) continue;
      const bid = String(p.id); const pr = porBling[bid] || null;
      if (pr) { // o registro local sabe mais (telefone, itens, quem vendeu, quando foi criado de verdade)
        p.noSistema = true; p.origem = pr.origem || (pr.origemPedido === "site" ? "site" : "atacado");
        p.vendedor = pr.vendedorNome || pr.funcionarioNome || p.vendedor;
        p.telefone = pr.cliente?.telefone || p.telefone; p.cliente = pr.cliente?.nome || p.cliente;
        if (pr.entrega?.tipo) p.tipo = pr.entrega.tipo === "entrega" ? "entrega" : "retirada";
        p.endereco = pr.entrega?.endereco || p.endereco; p.criadoEm = pr.criadoEm || p.criadoEm;
        if ((pr.itens || []).length) p.itens = pr.itens.map((i) => ({ nome: i.nome || "", quantidade: Number(i.quantidade) || 0, valor: Number(i.valor) || 0 }));
      }
      p.entregaLocal = entLocais[bid] || p.entregaLocal || null;
      const lock = locks[bid] || null; const etapa = etapaDe(p, lock); if (!etapa) continue;
      if (etapa === "entregue" && p.entregaLocal.em && agora - p.entregaLocal.em > 36 * 3600 * 1000) { antigosEmRota++; continue; }
      const m = marcos[bid] || {}; const viagem = viagemDoPedido[bid] || null; const prazoReg = prazos[bid] || null;
      const desde = desdeDa(etapa, p, m, fila, lock, viagem, prazoReg);
      const min = desde ? minutos(agora - desde) : null;
      const pag = pagamentoDe(bid, p.numero, prazoReg);
      const alertas = []; let nivel = nivelPorTempo(ETAPA_POR_KEY[etapa].limite, min);
      if (nivel === 2) alertas.push({ n: 2, t: `parado há ${fmtDur(min)} em "${ETAPA_POR_KEY[etapa].rotulo}"` });
      else if (nivel === 1) alertas.push({ n: 1, t: `há ${fmtDur(min)} em "${ETAPA_POR_KEY[etapa].rotulo}"` });
      if (["separado", "conferencia", "rota"].includes(etapa) && !pag.pago && !pag.prazo) { alertas.push({ n: 2, t: "sem pagamento registrado" }); nivel = 2; }
      // entregue sem nada recebido e sem ser a prazo: alguém precisa olhar
      if (etapa === "entregue" && !pag.pago && !pag.prazo && !(p.entregaLocal.formas && p.entregaLocal.formas.length) && !p.entregaLocal.jaPago && !p.entregaLocal.prazo) { alertas.push({ n: 1, t: "entregue sem recebimento registrado" }); nivel = Math.max(nivel, 1); }
      if (etapa === "pendencia") { alertas.push({ n: Math.max(1, nivel), t: "pendência a resolver (falta produto)" }); nivel = Math.max(1, nivel); }
      if (etapa === "prazo" && prazoReg && prazoReg.venceEm && prazoReg.venceEm < agora) { alertas.push({ n: 2, t: `venda a prazo vencida (${fmtData(prazoReg.venceEm)})` }); nivel = 2; }
      if (p.agendamento?.data && etapa !== "rota") {
        const dias = Math.round((inicioDiaBR(p.agendamento.data) - inicioDiaBR(diaBR(agora))) / 86400000);
        if (dias === 0) alertas.push({ n: 1, t: `entrega agendada para HOJE (${p.agendamento.turno || "qualquer turno"})` });
        else if (dias < 0) { alertas.push({ n: 2, t: `entrega agendada para ${p.agendamento.data}: ATRASADA` }); nivel = 2; }
      }
      let resp = "";
      if (etapa === "separando") resp = lock?.funcionarioNome || m.sepPor || "";
      else if (etapa === "fila_sep") resp = m.envioPor || fila[bid]?.por || "";
      else if (etapa === "separado" || etapa === "pendencia") resp = m.fimSepPor || "";
      else if (etapa === "conferencia") resp = m.confPor || "";
      else if (etapa === "rota") resp = viagem?.motoristaNome || "";
      p.g = { etapa, desde, min, nivel, alertas, resp, pag, sla: ETAPA_POR_KEY[etapa].limite };
      pedidos.push(p);
    }

    // propostas do site esperando alguém revisar (ainda nem existem no Bling)
    const site = Object.values(props).filter((pr) => pr && (pr.origemPedido === "site" || pr.origem === "site") && !pr.pedidoBlingId && pr.status !== "cancelada" && pr.status !== "pedido_gerado")
      .map((pr) => { const min = pr.criadoEm ? minutos(agora - pr.criadoEm) : null;
        return { id: pr.id, criadoEm: pr.criadoEm || 0, min, nivel: nivelPorTempo(LIMITE_SITE_MIN, min), cliente: pr.cliente?.nome || "—", telefone: pr.cliente?.telefone || "",
          clienteAssociado: !!pr.cliente?.id, total: Number(pr.total) || 0, tipo: pr.entrega?.tipo === "entrega" ? "entrega" : "retirada", qtdItens: (pr.itens || []).length }; })
      .sort((a, b) => (b.min || 0) - (a.min || 0));

    // vendas a prazo em aberto
    const listaPrazo = Object.entries(prazos).filter(([, v]) => v && !v.pago).map(([pid, v]) => ({
      pedidoId: pid, numero: v.numero || pid, cliente: v.cliente || "—", total: Number(v.total) || 0, desde: v.em || 0,
      venceEm: v.venceEm || 0, atrasada: !!(v.venceEm && v.venceEm < agora), diasParaVencer: v.venceEm ? Math.ceil((v.venceEm - agora) / 86400000) : null,
      origem: v.origem || "caixa" })).sort((a, b) => (a.venceEm || 0) - (b.venceEm || 0));

    // resumo por etapa (a faixa da Visão geral)
    const etapas = ETAPAS.map((e) => {
      const lista = pedidos.filter((p) => p.g.etapa === e.key);
      const mins = lista.map((p) => p.g.min).filter((x) => x != null);
      const maisAntigo = mins.length ? Math.max(...mins) : null;
      return { key: e.key, rotulo: e.rotulo, icone: e.icone, qtd: lista.length, valor: r2(lista.reduce((s, p) => s + p.total, 0)),
        maisAntigoMin: maisAntigo, nivel: Math.max(0, ...lista.map((p) => p.g.nivel)),
        // só importa faltar pagamento quando o pedido já está pronto ou a caminho; no começo da fila é normal
        semPagamento: ["separado", "conferencia", "rota"].includes(e.key) ? lista.filter((p) => !p.g.pag.pago && !p.g.pag.prazo).length : 0 };
    });
    const atencao = pedidos.filter((p) => p.g.nivel > 0).sort((a, b) => b.g.nivel - a.g.nivel || (b.g.min || 0) - (a.g.min || 0)).map((p) => p.id);
    // quem está fazendo o quê agora
    const equipe = [];
    Object.entries(locks).forEach(([pid, l]) => { const p = pedidos.find((x) => String(x.id) === pid);
      equipe.push({ tipo: l.tipo || "separacao", nome: l.funcionarioNome || "—", pedidoId: pid, numero: p?.numero || pid, min: l.ultimaAtividade ? minutos(agora - (l.inicio || l.criadoEm || l.ultimaAtividade)) : null }); });
    const dados = { em: agora, chamadasBling: chamadas, pedidos, site, prazos: listaPrazo, etapas, atencao, equipe, viagens: viagensAbertas,
      emRotaAntigosNoBling: antigosEmRota,
      totais: { ativos: pedidos.length, valor: r2(pedidos.reduce((s, p) => s + p.total, 0)), atencao: atencao.length, semPagamento: pedidos.filter((p) => ["separado", "conferencia", "rota"].includes(p.g.etapa) && !p.g.pag.pago && !p.g.pag.prazo).length } };
    return dados;
  }
  function fmtDur(min) { if (min == null) return "—"; if (min < 60) return `${min} min`; const h = Math.floor(min / 60), mm = min % 60; return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h${mm ? String(mm).padStart(2, "0") : ""}`; }
  function fmtData(ms) { const d = new Date(ms - BRT); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }

  app.get("/api/gestao/pipeline", async (req, res) => {
    try {
      const forcar = req.query.forcar === "1";
      // quem pede "atualizar" toda hora não gasta chamada à toa: dentro de 15s reaproveita; sem forçar, 60s
      const limite = forcar ? 15000 : 60000;
      if (_pipe.dados && Date.now() - _pipe.em < limite) return res.json({ ..._pipe.dados, doCache: true, idadeSeg: Math.round((Date.now() - _pipe.em) / 1000) });
      if (!_pipe.rodando) _pipe.rodando = montarPipeline().then((d) => { _pipe.dados = d; _pipe.em = Date.now(); return d; }).finally(() => { _pipe.rodando = null; });
      const d = await _pipe.rodando;
      res.json({ ...d, doCache: false, idadeSeg: 0 });
    } catch (e) {
      // o Bling falhou: devolve o último que tinha (marcado) em vez de deixar a tela vazia
      if (_pipe.dados) return res.json({ ..._pipe.dados, doCache: true, desatualizado: true, erroBling: String(e.message || e).slice(0, 120), idadeSeg: Math.round((Date.now() - _pipe.em) / 1000) });
      res.status(502).json({ erro: "Não consegui consultar o Bling agora: " + String(e.message || e).slice(0, 120) });
    }
  });

  // --------------------------------------------------------------------- INDICADORES (sem Bling)
  const mediana = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const k = Math.floor(s.length / 2); return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  function janela(periodo) {
    const agora = Date.now(); const hoje = inicioDiaBR(diaBR(agora));
    if (periodo === "ontem") return { ini: hoje - 86400000, fim: hoje, rotulo: "Ontem" };
    // SEMANA: começa na segunda-feira (semana de trabalho). "semana" = de segunda até agora;
    // "semana_passada" = a semana anterior inteira, de segunda a domingo.
    const dow = new Date(diaBR(agora) + "T12:00:00").getDay(); // 0 = domingo
    const iniSemana = hoje - ((dow + 6) % 7) * 86400000;
    const ddmm = (ms) => { const d = diaBR(ms); return d.slice(8) + "/" + d.slice(5, 7); };
    if (periodo === "semana") return { ini: iniSemana, fim: agora, rotulo: "Esta semana (" + ddmm(iniSemana) + " até hoje)" };
    if (periodo === "semana_passada") return { ini: iniSemana - 7 * 86400000, fim: iniSemana - 1, rotulo: "Semana passada (" + ddmm(iniSemana - 7 * 86400000) + " a " + ddmm(iniSemana - 86400000) + ")" };
    if (periodo === "7d") return { ini: hoje - 6 * 86400000, fim: agora, rotulo: "Últimos 7 dias" };
    if (periodo === "30d") return { ini: hoje - 29 * 86400000, fim: agora, rotulo: "Últimos 30 dias" };
    return { ini: hoje, fim: agora, rotulo: "Hoje" };
  }
  function origemChave(pr) { return pr.origem === "totem" ? "totem" : (pr.origemPedido === "site" || pr.origem === "site") ? "site" : "atacado"; }

  function calcularIndicadores(periodo) {
    const { ini, fim, rotulo } = janela(periodo);
    const dentro = (t) => t >= ini && t <= fim;
    const { mapa: marcos, log } = marcosDoLog();

    // pedidos criados (registro local)
    const porOrigem = { atacado: { qtd: 0, valor: 0 }, totem: { qtd: 0, valor: 0 }, site: { qtd: 0, valor: 0 } };
    const porHora = Array.from({ length: 24 }, () => 0); const porDia = {};
    let totalPed = 0, valorPed = 0;
    Object.values(lerPropostas() || {}).forEach((pr) => {
      if (!pr || !pr.criadoEm || !dentro(pr.criadoEm) || pr.status === "cancelada") return;
      if (pr.tipo === "proposta" && origemChave(pr) !== "site" && !pr.pedidoBlingId) return; // rascunho de atacado ainda não virou pedido
      const o = origemChave(pr); const v = Number(pr.total) || 0;
      porOrigem[o].qtd++; porOrigem[o].valor += v; totalPed++; valorPed += v; porHora[horaBR(pr.criadoEm)]++;
      const d = diaBR(pr.criadoEm); porDia[d] = porDia[d] || { qtd: 0, valor: 0 }; porDia[d].qtd++; porDia[d].valor += v;
    });
    Object.values(porOrigem).forEach((o) => { o.valor = r2(o.valor); });

    // caixa
    const caixa = { atacado: { qtd: 0, valor: 0 }, frente: { qtd: 0, valor: 0 } }; const porForma = {};
    try {
      for (const s of lerCaixaSessoes().sessoes || []) for (const m of s.movimentos || []) {
        if (m.tipo !== "venda" || m.cancelado || !dentro(m.em || 0)) continue;
        const k = (s.tipoCaixa || "frente") === "atacado" ? "atacado" : "frente";
        caixa[k].qtd++; caixa[k].valor += Number(m.total) || 0;
        let trocoPend = Number(m.troco) || 0;
        (m.pagamentos || []).forEach((x) => { let v = Number(x.valor) || 0;
          if (trocoPend > 0.004 && /dinheiro/i.test(x.formaNome || "")) { const d = Math.min(v, trocoPend); v -= d; trocoPend -= d; }
          const nome = x.formaNome || "—"; porForma[nome] = (porForma[nome] || 0) + v; });
      }
    } catch (e) {}
    caixa.atacado.valor = r2(caixa.atacado.valor); caixa.frente.valor = r2(caixa.frente.valor);
    const formas = Object.entries(porForma).map(([nome, valor]) => ({ nome, valor: r2(valor) })).sort((a, b) => b.valor - a.valor).slice(0, 8);

    // tempos por etapa (mediana) e por pessoa
    const tFila = [], tSep = [], tConf = [], tEnt = [], tCiclo = []; const pessoas = {};
    for (const pid of Object.keys(marcos)) {
      const m = marcos[pid];
      const dur = (a, b, max = 24 * 3600 * 1000) => (a && b && b > a && b - a < max ? minutos(b - a) : null);
      if (m.fimSep && dentro(m.fimSep)) {
        const f = dur(m.envio, m.inicioSep), s = dur(m.inicioSep, m.fimSep);
        if (f != null) tFila.push(f);
        if (s != null) { tSep.push(s); const nome = m.fimSepPor || "—"; (pessoas[nome] = pessoas[nome] || { nome, pedidos: 0, tempos: [] }).pedidos++; pessoas[nome].tempos.push(s); }
        else { const nome = m.fimSepPor || "—"; (pessoas[nome] = pessoas[nome] || { nome, pedidos: 0, tempos: [] }).pedidos++; }
      }
      if (m.conferido && dentro(m.conferido)) { const c = dur(m.fimSep, m.conferido); if (c != null) tConf.push(c); }
      if (m.entregue && dentro(m.entregue)) { const e = dur(m.conferido, m.entregue); if (e != null) tEnt.push(e); const ci = dur(m.envio, m.entregue, 3 * 86400000); if (ci != null) tCiclo.push(ci); }
    }
    const etapasTempo = [
      { key: "fila", rotulo: "Espera na fila", n: tFila.length, mediana: mediana(tFila), media: media(tFila) },
      { key: "separacao", rotulo: "Separação", n: tSep.length, mediana: mediana(tSep), media: media(tSep) },
      { key: "conferencia", rotulo: "Espera pela conferência", n: tConf.length, mediana: mediana(tConf), media: media(tConf) },
      { key: "entrega", rotulo: "Da conferência à entrega", n: tEnt.length, mediana: mediana(tEnt), media: media(tEnt) },
    ].map((x) => ({ ...x, mediana: x.mediana == null ? null : Math.round(x.mediana), media: x.media == null ? null : Math.round(x.media) }));
    const candidatas = etapasTempo.filter((x) => x.n >= 2 && x.mediana != null).sort((a, b) => b.mediana - a.mediana);
    const gargalo = candidatas.length ? { rotulo: candidatas[0].rotulo, mediana: candidatas[0].mediana } : null;
    const pessoasLista = Object.values(pessoas).map((p) => ({ nome: p.nome, pedidos: p.pedidos, mediana: p.tempos.length ? Math.round(mediana(p.tempos)) : null })).sort((a, b) => b.pedidos - a.pedidos).slice(0, 8);

    // itens que mais saem do pedido (sinal de falta de estoque)
    const retirados = {};
    for (const pid of Object.keys(log)) for (const e of log[pid] || []) {
      if (e.evento !== "itens_retirados" || !dentro(e.em || 0)) continue;
      const lista = (e.detalhes?.detalhe && e.detalhes.detalhe.length ? e.detalhes.detalhe : e.detalhes?.itens) || [];
      lista.forEach((s) => { const mm = String(s).match(/^(\d+(?:[.,]\d+)?)\s*x\s+(.+)$/i); const q = mm ? Number(mm[1].replace(",", ".")) : 1; const nome = (mm ? mm[2] : String(s)).trim();
        const r = (retirados[nome] = retirados[nome] || { nome, qtd: 0, pedidos: new Set() }); r.qtd += q; r.pedidos.add(pid); });
    }
    const itensRetirados = Object.values(retirados).map((r) => ({ nome: r.nome, qtd: r2(r.qtd), pedidos: r.pedidos.size })).sort((a, b) => b.qtd - a.qtd).slice(0, 8);

    // entregas
    const entregas = { total: 0, comOcorrencia: 0, aPrazo: { qtd: 0, valor: 0 }, recebido: 0, porMotorista: {} };
    Object.values(lerViagensAtivas()).forEach((v) => { if (!v || v.canceladaEm) return;
      Object.values(v.entregas || {}).forEach((e) => { if (e.status !== "entregue" || !dentro(e.em || 0)) return;
        entregas.total++; if (e.ocorrencia) entregas.comOcorrencia++;
        if (e.prazo) { entregas.aPrazo.qtd++; entregas.aPrazo.valor += Number(e.valorFinal) || 0; } else entregas.recebido += Number(e.valorFinal) || 0;
        const nome = v.motoristaNome || "—"; entregas.porMotorista[nome] = (entregas.porMotorista[nome] || 0) + 1; }); });
    entregas.aPrazo.valor = r2(entregas.aPrazo.valor); entregas.recebido = r2(entregas.recebido);
    const motoristas = Object.entries(entregas.porMotorista).map(([nome, qtd]) => ({ nome, qtd })).sort((a, b) => b.qtd - a.qtd);

    const dias = Object.keys(porDia).sort().map((d) => ({ dia: d, qtd: porDia[d].qtd, valor: r2(porDia[d].valor) }));
    const out = { periodo: periodo || "hoje", rotulo, ini, fim, pedidos: { total: totalPed, valor: r2(valorPed), ticket: totalPed ? r2(valorPed / totalPed) : 0, porOrigem },
      caixa, formas, etapasTempo, gargalo, cicloMediano: tCiclo.length ? Math.round(mediana(tCiclo)) : null, pessoas: pessoasLista, itensRetirados,
      entregas: { total: entregas.total, comOcorrencia: entregas.comOcorrencia, aPrazo: entregas.aPrazo, recebido: entregas.recebido, motoristas }, porHora, dias };
    out.texto = textoResumo(out);
    return out;
  }
  const brl = (v) => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function textoResumo(o) {
    const L = [`📊 B13: resumo de ${o.rotulo.toLowerCase()}`];
    const po = o.pedidos.porOrigem;
    L.push(`Pedidos: ${o.pedidos.total} (${brl(o.pedidos.valor)}), ticket médio ${brl(o.pedidos.ticket)}`);
    L.push(`Origem: atacado ${po.atacado.qtd}, totem ${po.totem.qtd}, site ${po.site.qtd}`);
    L.push(`Caixa: atacado ${o.caixa.atacado.qtd} vendas (${brl(o.caixa.atacado.valor)}), frente ${o.caixa.frente.qtd} vendas (${brl(o.caixa.frente.valor)})`);
    L.push(`Entregas concluídas: ${o.entregas.total}${o.entregas.motoristas.length ? " (" + o.entregas.motoristas.map((m) => `${m.nome} ${m.qtd}`).join(", ") + ")" : ""}` + (o.entregas.aPrazo.qtd ? `, a prazo ${o.entregas.aPrazo.qtd} (${brl(o.entregas.aPrazo.valor)})` : "") + (o.entregas.comOcorrencia ? `, com ocorrência ${o.entregas.comOcorrencia}` : ""));
    const t = o.etapasTempo.filter((x) => x.mediana != null);
    if (t.length) L.push("Tempo típico: " + t.map((x) => `${x.rotulo.toLowerCase()} ${x.mediana} min`).join(", ") + (o.gargalo ? `. Maior espera: ${o.gargalo.rotulo.toLowerCase()}` : ""));
    if (o.itensRetirados.length) L.push("Itens mais retirados dos pedidos: " + o.itensRetirados.slice(0, 4).map((i) => `${i.nome} (${i.qtd})`).join(", "));
    return L.join("\n");
  }
  app.get("/api/gestao/indicadores", (req, res) => {
    try { res.json(calcularIndicadores(String(req.query.periodo || "hoje"))); }
    catch (e) { res.status(500).json({ erro: e.message }); }
  });

  // --------------------------------------------------------------------- LINHA DO TEMPO de um pedido
  function resumoEvento(e) {
    const d = e.detalhes || {}; const n = String(e.evento || "");
    if (n === "situacao_alterada") return [d.de, d.para].filter(Boolean).join(" → ");
    if (n.startsWith("itens_")) { const l = (d.detalhe && d.detalhe.length ? d.detalhe : d.itens || d.retirados || d.acrescentados || d.alterados) || []; return Array.isArray(l) ? l.slice(0, 4).join(", ") : ""; }
    if (n.startsWith("entrega_finalizada_")) return d.prazo ? "venda a prazo" : (d.temAvaria ? "com item avariado" : "");
    if (n === "pagamento_registrado" || n.startsWith("pagamento_editado")) return d.para || d.forma || "";
    if (n === "tipo_entrega_alterado") return [d.de, d.para].filter(Boolean).join(" → ");
    return "";
  }
  app.get("/api/gestao/linha-do-tempo/:id", (req, res) => {
    try {
      const id = String(req.params.id);
      const { mapa } = marcosDoLog();
      const eventos = (lerLog()[id] || []).slice().sort((a, b) => (a.em || 0) - (b.em || 0));
      let anterior = 0;
      const lista = eventos.map((e) => { const item = { em: e.em || 0, evento: e.evento, rotulo: ROTULOS_EVENTO[e.evento] || String(e.evento || "").replace(/_/g, " "),
        quem: e.funcionarioNome || "", resumo: resumoEvento(e), apos: anterior ? minutos((e.em || 0) - anterior) : null }; anterior = e.em || anterior; return item; });
      const m = mapa[id] || {};
      const dur = (a, b) => (a && b && b > a ? minutos(b - a) : null);
      const etapas = [
        { rotulo: "Espera na fila", min: dur(m.envio, m.inicioSep), quem: "" },
        { rotulo: "Separação", min: dur(m.inicioSep, m.fimSep), quem: m.fimSepPor || m.sepPor || "" },
        { rotulo: "Espera pela conferência", min: dur(m.fimSep, m.conferido), quem: m.confPor || "" },
        { rotulo: "Da conferência à entrega", min: dur(m.conferido, m.entregue), quem: "" },
      ].filter((x) => x.min != null);
      res.json({ pedidoId: id, eventos: lista, etapas, cicloMin: dur(m.envio || m.criado, m.entregue) });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
}
