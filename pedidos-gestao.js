/* =============================================================================
   PAINEL DE GESTÃO DOS PEDIDOS — menu por etapa dentro da tela de Pedidos
   -----------------------------------------------------------------------------
   Carregado no fim de pedidos-online.html e se encaixa no render() dela. Usa as funções
   e os cards que a tela já tem (cardPedido, alternar, buscarPedido...), então todas as ações
   do pedido continuam iguais; o que muda é a ORGANIZAÇÃO e a forma de buscar os dados:
   uma consulta só ao Bling por etapa aberta (/api/gestao/pipeline), nunca pedido a pedido.
   A aba "Clássica" volta ao desenho antigo.
   ============================================================================= */
(function () {
  "use strict";

  var ABAS = [
    { k: "visao", t: "🧭 Visão geral", pipe: true },
    { k: "aguardando", t: "🟡 Aguardando", pipe: true, etapas: ["aguardando"] },
    { k: "separacao", t: "📦 Separação", pipe: true, etapas: ["fila_sep", "separando", "pendencia", "separado"] },
    { k: "conferencia", t: "🔍 Conferência", pipe: true, etapas: ["conferencia"] },
    { k: "entrega", t: "🛵 Entrega", pipe: true, etapas: ["rota", "entregue"] },
    { k: "financeiro", t: "💰 Financeiro", pipe: true },
    { k: "atendidos", t: "🏁 Atendidos" },
    { k: "aberto", t: "📂 Em aberto" },
    { k: "indicadores", t: "📊 Indicadores" },
    { k: "classica", t: "📋 Clássica" },
  ];
  var ORDEM_ETAPAS = ["aguardando", "fila_sep", "separando", "pendencia", "separado", "conferencia", "rota", "entregue", "prazo"];
  var PAGAMENTO_IMPORTA = { separado: 1, conferencia: 1, rota: 1 };

  var G = {
    aba: (function () { try { return localStorage.getItem("b13_ped_aba") || "visao"; } catch (e) { return "visao"; } })(),
    pipe: null, carregando: false, erro: "", ind: null, indPeriodo: "hoje", indCarregando: false,
    filtro: "todos", sub: "todas", tempoCarregou: 0,
  };
  if (!ABAS.some(function (a) { return a.k === G.aba; })) G.aba = "visao";

  // ----------------------------------------------------------------- utilidades
  function abaDef(k) { return ABAS.filter(function (a) { return a.k === k; })[0]; }
  function fmtDur(min) {
    if (min == null) return "—";
    if (min < 60) return min + " min";
    var h = Math.floor(min / 60), m = min % 60;
    if (h >= 24) return Math.floor(h / 24) + "d " + (h % 24) + "h";
    return h + "h" + (m ? (m < 10 ? "0" : "") + m : "");
  }
  function cor(n) { return n >= 2 ? "#ff4d5e" : n === 1 ? "#ffd23f" : "#3ce88a"; }
  function origemTxt(p) { return p.origem === "totem" ? "🖥️ Totem" : p.origem === "site" ? "🌐 Site" : "🧑‍💼 " + (p.vendedor || "Atacado"); }
  function idadeTxt() {
    if (!G.pipe) return "";
    var s = Math.max(0, Math.round((Date.now() - (G.tempoCarregou || G.pipe.em)) / 1000));
    return s < 60 ? "há " + s + " s" : "há " + Math.round(s / 60) + " min";
  }
  function listaDaAba(k) {
    if (!G.pipe) return [];
    var def = abaDef(k);
    var et = def && def.etapas ? def.etapas : [];
    return G.pipe.pedidos.filter(function (p) { return et.indexOf(p.g.etapa) >= 0; });
  }
  function etapaInfo(key) {
    if (!G.pipe) return { qtd: 0, valor: 0, nivel: 0, maisAntigoMin: null, semPagamento: 0 };
    return G.pipe.etapas.filter(function (e) { return e.key === key; })[0] || { qtd: 0, valor: 0, nivel: 0, maisAntigoMin: null, semPagamento: 0 };
  }
  function somaEtapas(keys) {
    var r = { qtd: 0, valor: 0, nivel: 0 };
    keys.forEach(function (k) { var e = etapaInfo(k); r.qtd += e.qtd; r.valor += e.valor; r.nivel = Math.max(r.nivel, e.nivel); });
    return r;
  }

  // ----------------------------------------------------------------- estilo
  function estilo() {
    if (document.getElementById("gestao-css")) return;
    var st = document.createElement("style"); st.id = "gestao-css";
    st.textContent =
      ".gMenu{position:sticky;top:0;z-index:20;background:#0f0d24;display:flex;gap:6px;overflow-x:auto;padding:8px 0 10px;margin:0 -2px 10px;-webkit-overflow-scrolling:touch;scrollbar-width:none}" +
      ".gMenu::-webkit-scrollbar{display:none}" +
      ".gAba{flex:0 0 auto;background:#1c1846;border:1px solid #37327a;border-radius:12px;padding:9px 12px;font-size:12.5px;font-weight:800;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:6px;color:#fff}" +
      ".gAba.on{background:#FF0082;border-color:#FF0082}" +
      ".gBadge{background:#2c2660;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:900}" +
      ".gBadge.n1{background:#ffd23f;color:#000}.gBadge.n2{background:#ff4d5e;color:#fff}" +
      ".gTitulo{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:4px 0 10px}" +
      ".gTitulo h2{font-size:17px;margin:0}" +
      ".gFita{display:flex;gap:8px;overflow-x:auto;padding:2px 0 8px;-webkit-overflow-scrolling:touch}" +
      // no COMPUTADOR as abas e a fita de etapas quebram em mais de uma linha (antes rolavam pro lado sem avisar e
      // Atendidos, Em aberto, Indicadores e Clássica ficavam escondidas); no celular continua deslizando
      '@media(min-width:768px){.gMenu{flex-wrap:wrap;overflow-x:visible}.gFita{flex-wrap:wrap;overflow-x:visible}}' +
      ".gEtapa{flex:1 0 118px;max-width:200px;background:#151233;border:2px solid #2c2660;border-radius:14px;padding:10px;cursor:pointer;position:relative;text-align:left}" +
      ".gEtapa.vazia{opacity:.55}" +
      ".gEtapa .gi{font-size:18px}.gEtapa .gq{font-size:26px;font-weight:900;line-height:1.1}" +
      ".gEtapa .gr{font-size:11px;color:#cfc9f5;font-weight:700;margin-top:2px}.gEtapa .gv{font-size:11px;color:#9a95c9}" +
      ".gEtapa .gt{font-size:11px;font-weight:800;margin-top:4px}" +
      ".gEtapa.n1{border-color:#ffd23f}.gEtapa.n2{border-color:#ff4d5e;background:#26101a}" +
      ".gKpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:6px 0 12px}" +
      ".gKpi{background:#151233;border:1px solid #2c2660;border-radius:12px;padding:10px}" +
      ".gKpi b{display:block;font-size:20px}.gKpi span{font-size:11px;color:#9a95c9}" +
      ".gSecao{background:#12102b;border:1px solid #2c2660;border-radius:14px;padding:10px 12px;margin-bottom:12px}" +
      ".gSecao h3{font-size:14px;margin:0 0 8px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".gRow{background:#151233;border:1px solid #2c2660;border-left:5px solid #3ce88a;border-radius:12px;padding:9px 10px;margin-bottom:7px;cursor:pointer}" +
      ".gRow.n1{border-left-color:#ffd23f}.gRow.n2{border-left-color:#ff4d5e}" +
      ".gRow .l1{display:flex;align-items:baseline;gap:8px;justify-content:space-between}" +
      ".gRow .gcli{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}" +
      ".gRow .gval{font-weight:900;color:#ffd23f;white-space:nowrap}" +
      ".gRow .l2{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:6px}" +
      ".gChip{display:inline-block;border-radius:8px;font-size:10.5px;font-weight:800;padding:3px 8px;background:#1c1846;color:#d6d2ff;border:1px solid #37327a}" +
      ".gChip.ver{background:#0a2a1a;color:#3ce88a;border-color:#1f6b43}.gChip.amar{background:#3a2a0a;color:#ffd23f;border-color:#6b5513}" +
      ".gChip.verm{background:#3a1018;color:#ff9aa8;border-color:#7a2433}.gChip.azul{background:#10243a;color:#9fd2ff;border-color:#24567a}" +
      ".gTempo{font-size:11px;font-weight:900}" +
      ".gAlerta{font-size:11.5px;margin-top:5px;font-weight:700}" +
      ".gFiltros{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}" +
      ".gF{background:#1c1846;border:1px solid #514c96;border-radius:16px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;color:#fff}.gF.on{background:#29ABE2;border-color:#29ABE2;color:#000}" +
      ".gVazio{padding:18px;text-align:center;color:#9a95c9;font-size:13px}" +
      ".gBarra{height:10px;border-radius:5px;background:#2c2660;overflow:hidden}.gBarra i{display:block;height:100%;background:#29ABE2}" +
      ".gLinhaBarra{display:grid;grid-template-columns:140px 1fr minmax(60px,auto);gap:8px;align-items:center;font-size:12px;margin:5px 0}.gLinhaBarra b{white-space:nowrap}" +
      ".gHoras{display:flex;align-items:flex-end;gap:2px;height:70px}.gHoras i{flex:1;background:#29ABE2;border-radius:2px 2px 0 0;min-height:2px}" +
      ".gTL{border-left:3px solid #37327a;margin:6px 0 0 8px;padding-left:12px}" +
      ".gTL .ev{position:relative;padding:5px 0 9px}.gTL .ev:before{content:'';position:absolute;left:-19px;top:9px;width:11px;height:11px;border-radius:50%;background:#29ABE2;border:2px solid #0f0d24}" +
      ".gTL .ev b{font-size:13px}.gTL .ev span{display:block;font-size:11px;color:#9a95c9}" +
      ".gToast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#2f9e6b;color:#fff;padding:10px 16px;border-radius:10px;font-weight:700;z-index:3000}" +
      "@media(max-width:560px){.gLinhaBarra{grid-template-columns:96px 1fr minmax(56px,auto)}.gEtapa{flex-basis:108px}}";
    document.head.appendChild(st);
  }

  // ----------------------------------------------------------------- dados
  function mesclarNoPEDIDOS() {
    if (!G.pipe) return;
    var idx = {};
    PEDIDOS.forEach(function (p) { idx[String(p.id)] = p; });
    G.pipe.pedidos.forEach(function (n) {
      var o = idx[String(n.id)];
      if (!o) { PEDIDOS.push(n); idx[String(n.id)] = n; return; }
      Object.keys(n).forEach(function (k) {
        var v = n[k];
        if (v === undefined || v === null) return;
        if (Array.isArray(v) && !v.length && Array.isArray(o[k]) && o[k].length) return; // não troca itens reais por lista vazia
        if (k === "criadoEm" && o[k]) return;
        o[k] = v;
      });
    });
  }
  G.reaplicar = function () { mesclarNoPEDIDOS(); }; // a tela recria PEDIDOS a cada recarga local: junta de novo, sem rede

  G.atualizar = function (forcar) {
    if (G.carregando) return Promise.resolve();
    G.carregando = true; G.erro = "";
    if (G.ativo()) render();
    return fetch(B + "/api/gestao/pipeline" + (forcar ? "?forcar=1" : "")).then(function (r) { return r.json(); }).then(function (j) {
      if (j.erro) throw new Error(j.erro);
      G.pipe = j; G.tempoCarregou = Date.now() - ((j.idadeSeg || 0) * 1000);
      mesclarNoPEDIDOS();
    }).catch(function (e) { G.erro = e.message || "erro"; }).then(function () {
      G.carregando = false;
      if (G.aba === "visao") G.carregarIndicadores(false);
      if (G.ativo()) render();
    });
  };
  G.carregarIndicadores = function (mostrarCarregando) {
    G.indCarregando = true; if (mostrarCarregando && G.ativo()) render();
    return fetch(B + "/api/gestao/indicadores?periodo=" + encodeURIComponent(G.indPeriodo)).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.erro) G.ind = j;
    }).catch(function () {}).then(function () { G.indCarregando = false; if (G.ativo()) render(); });
  };
  G.ativo = function () { return G.aba !== "classica"; };
  G.usaPipeline = function () { var d = abaDef(G.aba); return !!(d && d.pipe); };

  G.irAba = function (k) {
    G.aba = k; G.filtro = "todos"; G.sub = "todas";
    try { localStorage.setItem("b13_ped_aba", k); } catch (e) {}
    var d = abaDef(k);
    render();
    if (k === "classica") return;
    if (d && d.pipe) {
      var velho = !G.pipe || (Date.now() - G.tempoCarregou) > 45000;
      if (velho) G.atualizar(false);
      if (k === "visao") G.carregarIndicadores(false);
    }
    if (k === "indicadores") G.carregarIndicadores(true);
    if (k === "atendidos" && !statusDoMenu("atendido").pronto && !statusDoMenu("atendido").buscando) buscarStatus("atendido");
    if (k === "aberto" && !statusDoMenu("aberto").pronto && !statusDoMenu("aberto").buscando) buscarStatus("aberto");
    window.scrollTo(0, 0);
  };
  G.setFiltro = function (f) { G.filtro = f; render(); };
  G.setSub = function (s) { G.sub = s; render(); };
  G.setPeriodo = function (p) { G.indPeriodo = p; G.ind = null; G.carregarIndicadores(true); };

  // ----------------------------------------------------------------- peças da tela
  function pagChip(p) {
    var g = p.g || {}; var pg = g.pag || {};
    if (pg.prazo) return g.etapa === "prazo" ? "" : '<span class="gChip amar">🗓️ A prazo</span>';
    if (pg.pago) {
      var formas = (pg.formas || []).map(function (f) { return f.formaNome; }).filter(Boolean);
      var uniq = formas.filter(function (x, i) { return formas.indexOf(x) === i; }).slice(0, 2).join(" + ");
      return '<span class="gChip ver">✅ Pago' + (uniq ? " · " + esc(uniq) : "") + "</span>";
    }
    if (pg.parcial) return '<span class="gChip amar">◐ Pagamento parcial</span>';
    return PAGAMENTO_IMPORTA[g.etapa] ? '<span class="gChip verm">⏳ Sem pagamento</span>' : '<span class="gChip">⏳ A receber</span>';
  }
  function agendaChip(p) {
    if (!p.agendamento || !p.agendamento.data) return "";
    var d = String(p.agendamento.data).split("-");
    return '<span class="gChip azul">📅 ' + d[2] + "/" + d[1] + (p.agendamento.turno && p.agendamento.turno !== "qualquer" ? " · " + esc(p.agendamento.turno) : "") + "</span>";
  }
  function linha(p) {
    if (EXPANDIDO[p.id]) {
      return '<div style="margin-bottom:10px">' + cardPedido(p) +
        '<div style="margin-top:6px"><button class="btn btn-ghost" style="margin-top:0" onclick="GESTAO.timeline(\'' + p.id + '\')">🕒 Linha do tempo deste pedido</button></div></div>';
    }
    var g = p.g || {}; var nivel = g.nivel || 0;
    var etInfo = g.etapa ? (G.pipe && G.pipe.etapas.filter(function (e) { return e.key === g.etapa; })[0]) : null;
    var etRot = etInfo ? etInfo.icone + " " + etInfo.rotulo : (p.situacao ? esc(p.situacao) : "");
    var alertas = (g.alertas || []).slice().sort(function (a, b) { return b.n - a.n; }).slice(0, 2).map(function (a) {
      return '<div class="gAlerta" style="color:' + cor(a.n) + '">' + (a.n >= 2 ? "🔴" : "🟡") + " " + esc(a.t) + "</div>";
    }).join("");
    return '<div class="gRow n' + nivel + '" onclick="alternar(\'' + p.id + '\')">' +
      '<div class="l1"><span class="gcli"><b>#' + esc(p.numero) + "</b> " + esc(p.cliente) + '</span><span class="gval">' + brl(p.total) + "</span></div>" +
      '<div class="l2">' +
      '<span class="gChip">' + origemTxt(p) + "</span>" +
      '<span class="gChip ' + (p.tipo === "entrega" ? "azul" : "") + '">' + (p.tipo === "entrega" ? "🛵 Entrega" : "🏪 Retirada") + "</span>" + agendaChip(p) +
      (etRot ? '<span class="gChip">' + etRot + "</span>" : "") +
      (g.min != null ? '<span class="gTempo" style="color:' + cor(nivel) + '">⏱ ' + fmtDur(g.min) + "</span>" : "") +
      (g.resp ? '<span class="gChip">👤 ' + esc(g.resp) + "</span>" : "") +
      (g.pag ? pagChip(p) : "") +
      "</div>" +
      (p.entregaLocal ? '<div class="l2">' + chipEntregaMini(p) + "</div>" : "") +
      ((p.teveRetirada || (p.acrescentados && p.acrescentados.length) || (p.alterados && p.alterados.length)) ? chipMini(p) : "") +
      alertas + "</div>";
  }
  function aplicarFiltro(lista) {
    var f = G.filtro;
    return lista.filter(function (p) {
      if (f === "entrega") return p.tipo === "entrega";
      if (f === "retirada") return p.tipo === "retirada";
      if (f === "online") return p.origem === "totem" || p.origem === "site";
      if (f === "atacado") return p.origem !== "totem" && p.origem !== "site";
      return true;
    });
  }
  function ordenarPorEspera(lista) {
    return lista.slice().sort(function (a, b) { return (b.g.nivel - a.g.nivel) || ((b.g.min || 0) - (a.g.min || 0)); });
  }
  function filtrosHTML(lista) {
    function n(f) { return aplicarFiltro2(lista, f).length; }
    var fs = [["todos", "Todos"], ["entrega", "🛵 Entrega"], ["retirada", "🏪 Retirada"], ["online", "🖥️ Totem/Site"], ["atacado", "🧑‍💼 Atacado"]];
    return '<div class="gFiltros">' + fs.map(function (x) {
      return '<span class="gF ' + (G.filtro === x[0] ? "on" : "") + '" onclick="GESTAO.setFiltro(\'' + x[0] + '\')">' + x[1] + " (" + n(x[0]) + ")</span>";
    }).join("") + "</div>";
  }
  function aplicarFiltro2(lista, f) { var old = G.filtro; G.filtro = f; var r = aplicarFiltro(lista); G.filtro = old; return r; }
  function vazio(txt) { return '<div class="gVazio">' + txt + "</div>"; }
  function cabecalhoSecao(titulo, qtd, valor) {
    return '<div class="gTitulo"><h2>' + titulo + ' <span class="muted">(' + qtd + ")</span></h2>" + (valor != null ? '<b style="color:#ffd23f">' + brl(valor) + "</b>" : "") + "</div>";
  }
  function rodapeAtualizacao() {
    return '<div class="muted" style="margin:8px 0 2px;text-align:center">Atualizado ' + idadeTxt() + (G.pipe && G.pipe.desatualizado ? ' · <span style="color:#ffd23f">o Bling não respondeu, mostrando o último que consegui</span>' : "") +
      ' · <a href="#" onclick="GESTAO.atualizar(true);return false" style="color:#29ABE2">atualizar agora</a></div>';
  }

  // ----------------------------------------------------------------- aba: VISÃO GERAL (torre de controle)
  function abaVisao() {
    if (!G.pipe) return G.erro ? '<div class="card"><div class="ruim" style="color:#ff8090">' + esc(G.erro) + '</div><button class="btn btn-mag" onclick="GESTAO.atualizar(true)">Tentar de novo</button></div>' : vazio('<span class="spin"></span> Consultando o Bling…');
    var P = G.pipe; var h = "";
    h += '<div class="gTitulo"><h2>🧭 Torre de controle</h2><span class="muted">atualizado ' + idadeTxt() + "</span></div>";
    // a fita das etapas: o caminho do pedido, com quantos estão em cada ponto e o mais antigo
    var abaDaEtapa = { aguardando: "aguardando", fila_sep: "separacao", separando: "separacao", pendencia: "separacao", separado: "separacao", conferencia: "conferencia", rota: "entrega", entregue: "entrega", prazo: "financeiro" };
    h += '<div class="gFita">' + ORDEM_ETAPAS.map(function (k) {
      var e = etapaInfo(k); var def = P.etapas.filter(function (x) { return x.key === k; })[0]; if (!def) return "";
      return '<div class="gEtapa n' + e.nivel + (e.qtd ? "" : " vazia") + '" onclick="GESTAO.irAba(\'' + abaDaEtapa[k] + '\')">' +
        '<div class="gi">' + def.icone + '</div><div class="gq">' + e.qtd + '</div><div class="gr">' + esc(def.rotulo) + '</div>' +
        '<div class="gv">' + (e.qtd ? brl(e.valor) : "—") + "</div>" +
        (e.maisAntigoMin != null && k !== "entregue" ? '<div class="gt" style="color:' + cor(e.nivel) + '">⏱ mais antigo ' + fmtDur(e.maisAntigoMin) + "</div>" : "") +
        (e.semPagamento ? '<div class="gt" style="color:#ff9aa8">💸 ' + e.semPagamento + " sem pagamento</div>" : "") + "</div>";
    }).join("") + "</div>";
    // números de hoje (vêm do que o sistema já registra, sem custo)
    var I = G.ind;
    h += '<div class="gKpis">' +
      kpi(I ? I.pedidos.total : "…", "pedidos hoje") + kpi(I ? brl(I.pedidos.valor) : "…", "vendido hoje") +
      kpi(I ? I.entregas.total : "…", "entregas concluídas") +
      kpi(I && I.etapasTempo[1] && I.etapasTempo[1].mediana != null ? I.etapasTempo[1].mediana + " min" : "—", "separação (típico)") +
      kpi(I && I.gargalo ? esc(I.gargalo.rotulo) : "—", "maior espera hoje") +
      kpi(P.totais.atencao, "precisam de atenção") + "</div>";
    // precisa de atenção
    var atencao = P.atencao.map(function (id) { return P.pedidos.filter(function (p) { return String(p.id) === String(id); })[0]; }).filter(Boolean);
    h += '<div class="gSecao"><h3>⚠️ Precisa de atenção agora <span class="muted">(' + atencao.length + ")</span></h3>" +
      (atencao.length ? atencao.slice(0, 12).map(linha).join("") + (atencao.length > 12 ? '<div class="muted" style="text-align:center">+ ' + (atencao.length - 12) + " nas abas de cada etapa</div>" : "") : vazio("✅ Nada parado ou fora do normal neste momento.")) + "</div>";
    // propostas do site
    if (P.site && P.site.length) {
      h += '<div class="gSecao" style="border-color:#1f6b43"><h3>🌐 Propostas do site esperando revisão <span class="muted">(' + P.site.length + ")</span></h3>" + P.site.map(function (s) {
        return '<div class="gRow n' + s.nivel + '" onclick="location.href=\'/propostas?abrir=' + encodeURIComponent(s.id) + '\'">' +
          '<div class="l1"><span class="gcli"><b>' + esc(s.cliente) + '</b></span><span class="gval">' + brl(s.total) + "</span></div>" +
          '<div class="l2"><span class="gTempo" style="color:' + cor(s.nivel) + '">⏱ ' + fmtDur(s.min) + '</span><span class="gChip">' + (s.tipo === "entrega" ? "🛵 Entrega" : "🏪 Retirada") + '</span><span class="gChip">' + s.qtdItens + ' item(ns)</span>' +
          (s.clienteAssociado ? "" : '<span class="gChip amar">cliente a associar</span>') + '<span class="gChip azul">abrir em Propostas ›</span></div></div>';
      }).join("") + "</div>";
    }
    // equipe agora
    var eq = [];
    P.equipe.forEach(function (e) { eq.push("🧑‍🔧 <b>" + esc(e.nome) + "</b> " + (e.tipo === "conferencia" ? "conferindo" : "separando") + " #" + esc(e.numero) + (e.min != null ? " (" + fmtDur(e.min) + ")" : "")); });
    P.viagens.forEach(function (v) { eq.push("🛵 <b>" + esc(v.motorista || "motorista") + "</b>" + (v.carro ? " (" + esc(v.carro) + ")" : "") + ": " + v.entregues + " de " + v.total + " entregas · saiu " + fmtDur(Math.round((Date.now() - v.iniciadaEm) / 60000)) + " atrás"); });
    h += '<div class="gSecao"><h3>👥 Equipe agora</h3>' + (eq.length ? eq.map(function (x) { return '<div style="padding:4px 0;font-size:13px">' + x + "</div>"; }).join("") : vazio("Ninguém separando nem em rota neste momento.")) + "</div>";
    if (P.emRotaAntigosNoBling) h += '<div class="muted" style="margin-bottom:8px">🧹 ' + P.emRotaAntigosNoBling + " pedido(s) já entregue(s) há mais de 1 dia ainda constam como “Em rota” no Bling. É esperado: a entrega é registrada só no nosso sistema.</div>";
    h += '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost" style="width:auto" onclick="GESTAO.copiarResumo()">📋 Copiar resumo do dia</button><button class="btn btn-ghost" style="width:auto" onclick="GESTAO.irAba(\'indicadores\')">📊 Ver indicadores</button></div>';
    return h + rodapeAtualizacao();
  }
  function kpi(v, rot) { return '<div class="gKpi"><b>' + v + "</b><span>" + rot + "</span></div>"; }

  // ----------------------------------------------------------------- abas por etapa
  function abaEtapa(k, titulo, subtitulo) {
    if (!G.pipe) return G.erro ? '<div class="card" style="color:#ff8090">' + esc(G.erro) + "</div>" : vazio('<span class="spin"></span> Consultando o Bling…');
    var base = listaDaAba(k);
    var h = cabecalhoSecao(titulo, base.length, base.reduce(function (s, p) { return s + p.total; }, 0));
    if (subtitulo) h += '<div class="muted" style="margin:-4px 0 10px">' + subtitulo + "</div>";
    h += filtrosHTML(base);
    var lista = ordenarPorEspera(aplicarFiltro(base));
    h += lista.length ? lista.map(linha).join("") : vazio("Nenhum pedido aqui" + (G.filtro !== "todos" ? " com esse filtro" : "") + ".");
    return h + rodapeAtualizacao();
  }
  function abaSeparacao() {
    if (!G.pipe) return abaEtapa("separacao", "📦 Separação");
    var subs = [["todas", "Todos", ["fila_sep", "separando", "pendencia", "separado"]], ["fila_sep", "📋 Na fila", ["fila_sep"]], ["separando", "🧑‍🔧 Sendo separados", ["separando"]], ["pendencia", "🛠️ Pendências", ["pendencia"]], ["separado", "✅ Separados", ["separado"]]];
    var atual = subs.filter(function (s) { return s[0] === G.sub; })[0] || subs[0];
    var base = G.pipe.pedidos.filter(function (p) { return atual[2].indexOf(p.g.etapa) >= 0; });
    var tudo = listaDaAba("separacao");
    var h = cabecalhoSecao("📦 Separação", tudo.length, tudo.reduce(function (s, p) { return s + p.total; }, 0));
    h += '<div class="gFiltros">' + subs.map(function (s) {
      var n = G.pipe.pedidos.filter(function (p) { return s[2].indexOf(p.g.etapa) >= 0; }).length;
      return '<span class="gF ' + (G.sub === s[0] ? "on" : "") + '" onclick="GESTAO.setSub(\'' + s[0] + '\')">' + s[1] + " (" + n + ")</span>";
    }).join("") + "</div>";
    h += filtrosHTML(base);
    var lista = ordenarPorEspera(aplicarFiltro(base));
    h += lista.length ? lista.map(linha).join("") : vazio("Nenhum pedido aqui.");
    return h + rodapeAtualizacao();
  }
  function abaEntrega() {
    if (!G.pipe) return abaEtapa("entrega", "🛵 Entrega");
    var P = G.pipe; var h = "";
    var rota = P.pedidos.filter(function (p) { return p.g.etapa === "rota"; });
    var entregues = P.pedidos.filter(function (p) { return p.g.etapa === "entregue"; }).sort(function (a, b) { return (b.g.desde || 0) - (a.g.desde || 0); });
    h += cabecalhoSecao("🛵 Em rota agora", rota.length, rota.reduce(function (s, p) { return s + p.total; }, 0));
    var usados = {};
    P.viagens.forEach(function (v) {
      var doVeiculo = rota.filter(function (p) { return v.pedidoIds.indexOf(String(p.id)) >= 0; });
      doVeiculo.forEach(function (p) { usados[p.id] = 1; });
      var pct = v.total ? Math.round(v.entregues * 100 / v.total) : 0;
      h += '<div class="gSecao"><h3><span>🛵 ' + esc(v.motorista || "Motorista") + (v.carro ? " · " + esc(v.carro) : "") + '</span><span class="muted">saiu ' + fmtDur(Math.round((Date.now() - v.iniciadaEm) / 60000)) + " atrás</span></h3>" +
        '<div class="gBarra" style="margin-bottom:4px"><i style="width:' + pct + '%;background:#3ce88a"></i></div><div class="muted" style="margin-bottom:8px">' + v.entregues + " de " + v.total + " entregues" + (v.naoEntregues ? " · " + v.naoEntregues + " não entregue(s)" : "") + "</div>" +
        (doVeiculo.length ? doVeiculo.map(linha).join("") : '<div class="muted">Sem pedidos pendentes nesta viagem.</div>') + "</div>";
    });
    var soltos = rota.filter(function (p) { return !usados[p.id]; });
    if (soltos.length) h += '<div class="gSecao"><h3>Em rota sem viagem aberta <span class="muted">(' + soltos.length + ")</span></h3>" + ordenarPorEspera(soltos).map(linha).join("") + "</div>";
    if (!rota.length && !P.viagens.length) h += vazio("Nenhum pedido em rota agora.");
    h += '<div class="gSecao"><h3>🏠 Entregues (registradas no sistema) <span class="muted">(' + entregues.length + ")</span></h3>" +
      '<div class="muted" style="margin-bottom:8px">A entrega não muda o pedido para Atendido no Bling; fica registrada aqui, com quem entregou e o que foi recebido.</div>' +
      (entregues.length ? entregues.map(linha).join("") : vazio("Nenhuma entrega registrada nas últimas 36 horas.")) + "</div>";
    return h + rodapeAtualizacao();
  }
  function abaFinanceiro() {
    if (!G.pipe) return abaEtapa("financeiro", "💰 Financeiro");
    var P = G.pipe; var h = "";
    var semPag = P.pedidos.filter(function (p) { return PAGAMENTO_IMPORTA[p.g.etapa] && !p.g.pag.pago && !p.g.pag.prazo; });
    h += cabecalhoSecao("💸 Prontos ou em rota sem pagamento registrado", semPag.length, semPag.reduce(function (s, p) { return s + p.total; }, 0));
    h += '<div class="muted" style="margin:-4px 0 10px">Não libere a entrega ou a retirada sem receber.</div>';
    h += semPag.length ? ordenarPorEspera(semPag).map(linha).join("") : vazio("✅ Todos os pedidos prontos ou em rota têm pagamento registrado.");
    var total = P.prazos.reduce(function (s, x) { return s + x.total; }, 0);
    h += '<div class="gSecao" style="margin-top:14px"><h3>⏰ Vendas a prazo em aberto <span class="muted">(' + P.prazos.length + ")</span><b style=\"color:#ffd23f\">" + brl(total) + "</b></h3>" +
      (P.prazos.length ? P.prazos.map(function (x) {
        var v = x.venceEm ? new Date(x.venceEm - 3 * 3600 * 1000).toISOString().slice(8, 10) + "/" + new Date(x.venceEm - 3 * 3600 * 1000).toISOString().slice(5, 7) : "—";
        return '<div class="gRow n' + (x.atrasada ? 2 : 0) + '" style="cursor:default"><div class="l1"><span class="gcli"><b>#' + esc(x.numero) + "</b> " + esc(x.cliente) + '</span><span class="gval">' + brl(x.total) + "</span></div>" +
          '<div class="l2"><span class="gChip ' + (x.atrasada ? "verm" : "amar") + '">' + (x.atrasada ? "🔴 vencida em " + v : "vence em " + v + (x.diasParaVencer != null ? " (" + x.diasParaVencer + " d)" : "")) + '</span><span class="gChip">' + esc(x.origem === "entrega" ? "🛵 registrada na entrega" : "🧾 caixa") + "</span></div></div>";
      }).join("") : vazio("Nenhuma venda a prazo em aberto.")) + "</div>";
    return h + rodapeAtualizacao();
  }
  function abaStatusBling(key, titulo, aviso) {
    var st = statusDoMenu(key);
    var lista = key === "atendido" ? PEDIDOS.filter(function (p) { return ehAtendido(p) && !p.cancelado; }) : PEDIDOS.filter(function (p) { return Number(p.situacaoId) === 6; });
    var h = '<div class="gTitulo"><h2>' + titulo + ' <span class="muted">(' + lista.length + ")</span></h2><div>" +
      '<span class="chipSem ' + (SEMANA === 0 ? "on" : "") + '" onclick="verSemana(0)">📅 Esta semana</span><span class="chipSem ' + (SEMANA === 1 ? "on" : "") + '" onclick="verSemana(1)">⏪ Semana anterior</span></div></div>';
    h += '<div class="muted" style="margin:-4px 0 10px">' + aviso + "</div>";
    h += '<button class="btn btn-ghost" style="width:auto;margin:0 0 10px" onclick="buscarStatus(\'' + key + '\')" ' + (st.buscando ? "disabled" : "") + ">" + (st.buscando ? "Buscando no Bling… " + st.progresso + "%" : (st.pronto ? "🔄 Buscar de novo no Bling" : "Buscar no Bling")) + "</button>";
    lista = lista.slice().sort(function (a, b) { return Number(b.numero || 0) - Number(a.numero || 0); });
    h += lista.length ? lista.slice(0, 80).map(linha).join("") + (lista.length > 80 ? '<div class="muted" style="text-align:center">mostrando 80 de ' + lista.length + "; use a busca por número para os demais</div>" : "") : vazio(st.buscando ? '<span class="spin"></span> Buscando…' : "Nenhum pedido carregado. Use o botão acima.");
    return h;
  }

  // ----------------------------------------------------------------- aba: INDICADORES
  function barra(rot, valor, max, texto, corBarra) {
    var pct = max > 0 ? Math.max(2, Math.round(valor * 100 / max)) : 0;
    return '<div class="gLinhaBarra"><span>' + rot + '</span><div class="gBarra"><i style="width:' + pct + "%" + (corBarra ? ";background:" + corBarra : "") + '"></i></div><b style="text-align:right">' + texto + "</b></div>";
  }
  function abaIndicadores() {
    var per = [["hoje", "Hoje"], ["ontem", "Ontem"], ["semana", "Semana"], ["semana_passada", "Sem. passada"], ["7d", "7 dias"], ["30d", "30 dias"]];
    var h = '<div class="gTitulo"><h2>📊 Indicadores</h2><div class="gFiltros" style="margin:0">' + per.map(function (x) {
      return '<span class="gF ' + (G.indPeriodo === x[0] ? "on" : "") + '" onclick="GESTAO.setPeriodo(\'' + x[0] + '\')">' + x[1] + "</span>";
    }).join("") + "</div></div>";
    var I = G.ind;
    if (!I) return h + vazio('<span class="spin"></span> Calculando…');
    h += '<div class="muted" style="margin:-4px 0 10px">Tudo calculado com o que o sistema já registra (histórico de cada pedido, caixa e viagens), sem consultar o Bling.</div>';
    h += '<div class="gKpis">' + kpi(I.pedidos.total, "pedidos") + kpi(brl(I.pedidos.valor), "valor dos pedidos") + kpi(brl(I.pedidos.ticket), "ticket médio") +
      kpi(I.cicloMediano != null ? fmtDur(I.cicloMediano) : "—", "ciclo típico (envio à entrega)") + kpi(I.entregas.total, "entregas concluídas") +
      kpi(brl(I.caixa.atacado.valor + I.caixa.frente.valor), "vendido nos caixas") + "</div>";
    // tempo por etapa
    var maxT = Math.max.apply(null, I.etapasTempo.map(function (x) { return x.mediana || 0; }).concat([1]));
    h += '<div class="gSecao"><h3>⏱ Tempo típico por etapa' + (I.gargalo ? '<span class="gChip amar">maior espera: ' + esc(I.gargalo.rotulo) + " (" + fmtDur(I.gargalo.mediana) + ")</span>" : "") + "</h3>" +
      I.etapasTempo.map(function (x) {
        var ehG = I.gargalo && I.gargalo.rotulo === x.rotulo;
        return x.mediana != null ? barra(esc(x.rotulo), x.mediana, maxT, fmtDur(x.mediana) + ' <span class="muted">(' + x.n + ")</span>", ehG ? "#ffd23f" : "") : barra(esc(x.rotulo), 0, 1, "—", "");
      }).join("") + '<div class="muted" style="margin-top:6px">Valor típico (mediana) dos pedidos do período; entre parênteses, quantos pedidos entraram na conta.</div></div>';
    // origem
    var o = I.pedidos.porOrigem; var maxO = Math.max(o.atacado.qtd, o.totem.qtd, o.site.qtd, 1);
    h += '<div class="gSecao"><h3>🧾 Pedidos por origem</h3>' + barra("🧑‍💼 Atacado", o.atacado.qtd, maxO, o.atacado.qtd + " · " + brl(o.atacado.valor)) + barra("🖥️ Totem", o.totem.qtd, maxO, o.totem.qtd + " · " + brl(o.totem.valor)) + barra("🌐 Site", o.site.qtd, maxO, o.site.qtd + " · " + brl(o.site.valor)) + "</div>";
    // pico por hora
    var maxH = Math.max.apply(null, I.porHora.concat([1]));
    h += '<div class="gSecao"><h3>🕐 Pedidos por hora do dia</h3><div class="gHoras">' + I.porHora.map(function (n, hr) { return '<i title="' + hr + "h: " + n + ' pedido(s)" style="height:' + Math.round(n * 100 / maxH) + '%;opacity:' + (n ? 1 : .25) + '"></i>'; }).join("") +
      '</div><div class="muted" style="display:flex;justify-content:space-between"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div></div>';
    // equipe
    var T = I.tamanhoPedido || {};
    var resumoKg = T.kgMedio != null
      ? '<div class="muted" style="margin:-2px 0 8px">Tamanho do pedido separado: <b>' + T.kgMedio + ' kg em média</b> (o do meio tem ' + T.kgMediano + ' kg, o maior ' + T.kgMax + ' kg). Peso estimado pelos itens' + (T.semPeso ? "; " + T.semPeso + " pedido(s) sem itens no sistema ficaram de fora" : "") + ".</div>" : "";
    if (T.kgMedio != null && T.semVolume && T.semVolume.length) resumoKg += '<div class="muted" style="margin:-2px 0 8px;font-size:12px">⚠️ Sem volume no nome nem na categoria da tabela (assumi 500 ml): <b>' + T.semVolume.map(function (x) { return esc(x.nome) + " (" + x.qtd + " un)"; }).join(", ") + "</b>. Põe o volume no nome do produto ou na categoria da tabela para o peso ficar mais certo.</div>";
    h += '<div class="gSecao"><h3>🧑‍🔧 Equipe de separação</h3>' + resumoKg + (I.pessoas.length ? I.pessoas.map(function (p) { return barra("👤 " + esc(p.nome), p.pedidos, I.pessoas[0].pedidos, p.pedidos + " pedido(s)" + (p.mediana != null ? " · " + fmtDur(p.mediana) : "") + (p.kgMedio != null ? " · " + p.kgMedio + " kg/ped." : "")); }).join("") : vazio("Sem separações concluídas no período.")) + "</div>";
    // itens retirados
    h += '<div class="gSecao"><h3>✂️ Itens que mais saem dos pedidos <span class="muted">(sinal de falta de estoque)</span></h3>' + (I.itensRetirados.length ? I.itensRetirados.map(function (it) { return barra(esc(it.nome), it.qtd, I.itensRetirados[0].qtd, it.qtd + " un · " + it.pedidos + " ped.", "#ff9aa8"); }).join("") : vazio("Nenhum item retirado no período.")) + "</div>";
    // entregas e caixa
    h += '<div class="gSecao"><h3>🛵 Entregas</h3>' + (I.entregas.total ? I.entregas.motoristas.map(function (m) { return barra("👤 " + esc(m.nome), m.qtd, I.entregas.motoristas[0].qtd, m.qtd + " entrega(s)", "#3ce88a"); }).join("") +
      '<div class="muted" style="margin-top:6px">Recebido na entrega: <b>' + brl(I.entregas.recebido) + "</b> · a prazo: <b>" + I.entregas.aPrazo.qtd + "</b> (" + brl(I.entregas.aPrazo.valor) + ") · com ocorrência: <b>" + I.entregas.comOcorrencia + "</b></div>" : vazio("Nenhuma entrega concluída no período.")) + "</div>";
    var maxF = I.formas.length ? I.formas[0].valor : 1;
    h += '<div class="gSecao"><h3>💳 Recebido no caixa, por forma</h3>' + (I.formas.length ? I.formas.map(function (f) { return barra(esc(f.nome), f.valor, maxF, brl(f.valor), "#a98bff"); }).join("") : vazio("Sem vendas no caixa no período.")) + "</div>";
    h += '<button class="btn btn-ghost" style="width:auto" onclick="GESTAO.copiarResumo()">📋 Copiar resumo deste período</button>';
    return h;
  }

  // ----------------------------------------------------------------- ações
  function toast(t) {
    var e = document.createElement("div"); e.className = "gToast"; e.textContent = t; document.body.appendChild(e);
    setTimeout(function () { try { document.body.removeChild(e); } catch (x) {} }, 2600);
  }
  G.copiarResumo = function () {
    function copiar(txt) {
      var legado = function () { try { var ta = document.createElement("textarea"); ta.value = txt; ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select(); var ok = document.execCommand("copy"); document.body.removeChild(ta); return ok; } catch (e) { return false; } };
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) navigator.clipboard.writeText(txt).then(function () { toast("Resumo copiado"); }).catch(function () { toast(legado() ? "Resumo copiado" : "Não consegui copiar"); });
      else toast(legado() ? "Resumo copiado" : "Não consegui copiar");
    }
    if (G.ind && G.ind.texto && G.ind.periodo === G.indPeriodo) return copiar(G.ind.texto);
    fetch(B + "/api/gestao/indicadores?periodo=" + encodeURIComponent(G.indPeriodo)).then(function (r) { return r.json(); }).then(function (j) { G.ind = j; copiar(j.texto || ""); }).catch(function () { toast("Não consegui gerar o resumo"); });
  };
  G.timeline = function (id) {
    var m = document.getElementById("modais");
    m.innerHTML = '<div class="modalBg" onclick="if(event.target===this)fechar()"><div class="modal"><div class="muted center"><span class="spin"></span> Montando a linha do tempo…</div></div></div>';
    fetch(B + "/api/gestao/linha-do-tempo/" + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (j) {
      if (j.erro) throw new Error(j.erro);
      var p = (typeof acharPedido === "function") ? acharPedido(id) : null;
      var h = '<h3 style="margin:0 0 6px">🕒 Linha do tempo' + (p ? " · #" + esc(p.numero) : "") + "</h3>";
      if (j.etapas && j.etapas.length) {
        h += '<div class="gSecao" style="margin:8px 0">' + j.etapas.map(function (e) { return '<div class="gLinhaBarra" style="grid-template-columns:1fr auto"><span>' + esc(e.rotulo) + (e.quem ? ' <span class="muted">· ' + esc(e.quem) + "</span>" : "") + "</span><b>" + fmtDur(e.min) + "</b></div>"; }).join("") +
          (j.cicloMin != null ? '<div class="muted" style="margin-top:4px">Do envio à entrega: <b>' + fmtDur(j.cicloMin) + "</b></div>" : "") + "</div>";
      }
      h += j.eventos.length ? '<div class="gTL">' + j.eventos.map(function (e) {
        var q = new Date(e.em - 3 * 3600 * 1000).toISOString();
        return '<div class="ev"><b>' + esc(e.rotulo) + "</b><span>" + q.slice(8, 10) + "/" + q.slice(5, 7) + " " + q.slice(11, 16) + (e.quem ? " · " + esc(e.quem) : "") + (e.apos != null ? " · +" + fmtDur(e.apos) : "") + "</span>" + (e.resumo ? "<span>" + esc(e.resumo) + "</span>" : "") + "</div>";
      }).join("") + "</div>" : vazio("Este pedido ainda não tem histórico registrado.");
      h += '<button class="btn btn-ghost" style="width:100%;margin-top:10px" onclick="fechar()">Fechar</button>';
      m.innerHTML = '<div class="modalBg" onclick="if(event.target===this)fechar()"><div class="modal">' + h + "</div></div>";
    }).catch(function (e) {
      m.innerHTML = '<div class="modalBg" onclick="if(event.target===this)fechar()"><div class="modal"><div style="color:#ff8090">Não consegui montar: ' + esc(e.message) + '</div><button class="btn btn-ghost" style="width:100%" onclick="fechar()">Fechar</button></div></div>';
    });
  };

  // ----------------------------------------------------------------- desenho
  function menuHTML() {
    return '<div class="gMenu">' + ABAS.map(function (a) {
      var b = "", nivel = 0;
      if (G.pipe && a.k === "visao") { if (G.pipe.totais.atencao) { b = G.pipe.totais.atencao; nivel = 2; } }
      else if (G.pipe && a.etapas) { var s = somaEtapas(a.etapas); if (s.qtd) { b = s.qtd; nivel = s.nivel; } }
      else if (G.pipe && a.k === "financeiro") { var n = G.pipe.totais.semPagamento + G.pipe.prazos.length; if (n) { b = n; nivel = G.pipe.totais.semPagamento || G.pipe.prazos.some(function (x) { return x.atrasada; }) ? 2 : 0; } }
      return '<span class="gAba ' + (G.aba === a.k ? "on" : "") + '" onclick="GESTAO.irAba(\'' + a.k + '\')">' + a.t + (b !== "" ? ' <span class="gBadge n' + nivel + '">' + b + "</span>" : "") + "</span>";
    }).join("") + "</div>";
  }
  function cabecalhoHTML() {
    return '<div class="top"><img src="/logo"><div class="t">🛒 Pedidos</div><div style="flex:1"></div>' +
      '<input id="buscaPed" placeholder="🔎 nº do pedido" inputmode="numeric" value="' + esc(window._buscaTxt || "") + '" oninput="window._buscaTxt=this.value" onkeydown="if(event.key===\'Enter\')buscarPedido()" style="background:#1c1846;border:1px solid #37327a;border-radius:8px;color:#fff;padding:7px;width:130px">' +
      '<button class="btn btn-ghost" style="width:auto;margin:0" onclick="buscarPedido()">' + (BUSCANDO ? "…" : "Buscar") + "</button>" +
      (BUSCA_RES ? '<button class="btn btn-ghost" style="width:auto;margin:0" onclick="limparBusca()">✕ limpar</button>' : "") +
      '<button class="btn btn-ghost" style="width:auto;margin:0" onclick="GESTAO.atualizar(true)" title="Atualizar agora">' + (G.carregando ? "⏳" : "🔄") + "</button>" +
      '<button class="btn btn-ghost" style="width:auto;margin:0" onclick="marcarVistos()">✓ Marcar vistos</button></div>';
  }
  G.render = function (app) {
    estilo();
    var scrollY = window.scrollY || 0;
    var b = document.getElementById("buscaPed"); var foco = b && document.activeElement === b; var sel = foco ? [b.selectionStart, b.selectionEnd] : null;
    var menuAnt = document.querySelector(".gMenu"); var menuScroll = menuAnt ? menuAnt.scrollLeft : 0;
    var corpo = "";
    if (BUSCA_RES) {
      corpo += '<div class="gSecao" style="border-color:#29ABE2"><h3>🔎 Resultado da busca por “' + esc(window._buscaTxt || "") + '” <a href="#" onclick="limparBusca();return false" style="color:#29ABE2;font-size:12px">voltar ao painel</a></h3>' +
        (BUSCA_RES.length ? BUSCA_RES.map(linha).join("") : vazio("Pedido não encontrado.")) + "</div>";
    }
    switch (G.aba) {
      case "visao": corpo += abaVisao(); break;
      case "aguardando": corpo += abaEtapa("aguardando", "🟡 Aguardando separação", "Pedidos criados que ainda não foram para a mesa de separação."); break;
      case "separacao": corpo += abaSeparacao(); break;
      case "conferencia": corpo += abaEtapa("conferencia", "🔍 Conferência de entrega", "Separados e conferidos, prontos para sair."); break;
      case "entrega": corpo += abaEntrega(); break;
      case "financeiro": corpo += abaFinanceiro(); break;
      case "atendidos": corpo += abaStatusBling("atendido", "🏁 Atendidos", "Pedidos concluídos no Bling. Buscados no Bling só quando você pede."); break;
      case "aberto": corpo += abaStatusBling("aberto", "📂 Em aberto", "Pedidos ainda em aberto no Bling. Buscados só quando você pede."); break;
      case "indicadores": corpo += abaIndicadores(); break;
    }
    app.innerHTML = cabecalhoHTML() + '<div class="wrap">' + menuHTML() + corpo + "</div>";
    var menuNovo = document.querySelector(".gMenu"); if (menuNovo) menuNovo.scrollLeft = menuScroll;
    var nb = document.getElementById("buscaPed");
    if (foco && nb) { nb.focus(); try { nb.setSelectionRange(sel[0], sel[1]); } catch (e) {} }
    if (scrollY > 0) setTimeout(function () { window.scrollTo(0, scrollY); }, 0);
  };

  // atualização automática: só enquanto a pessoa está olhando uma aba de etapa e a janela está visível
  setInterval(function () {
    if (document.hidden || !G.ativo() || !G.usaPipeline() || G.carregando) return;
    if (document.querySelector("#modais .modalBg")) return; // não mexe na tela com um modal aberto
    G.atualizar(false);
  }, 60000);

  window.GESTAO = G;
  // se a tela já tinha desenhado o modo antigo antes deste arquivo carregar, troca agora
  estilo();
  if (G.ativo()) { render(); if (G.usaPipeline()) G.atualizar(false).then(function () { if (G.aba === "visao") G.carregarIndicadores(false); }); else if (G.aba === "indicadores") G.carregarIndicadores(true); }
})();
