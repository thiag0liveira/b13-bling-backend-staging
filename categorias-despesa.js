/* Painel "Categorias das despesas": adicionar, renomear e remover.
   Uso: B13Categorias.abrir({ aoMudar: function (rotulos) {...}, aoFechar: function () {...} })
   aoMudar recebe a lista (texto) das categorias que aparecem nas escolhas, para a tela atualizar os seletores na hora. */
(function () {
  var DADOS = null, OPC = {}, FILTRO = "", MOSTRAR_REMOVIDAS = false, MUDOU = false, EM_MOVER = null;

  function tok() { try { return (b13GetSession() || {}).token || ""; } catch (e) { return ""; } }
  function req(path, metodo, corpo) {
    return fetch(path, { method: metodo || "GET", headers: { "Content-Type": "application/json", "X-Auth-Token": tok() }, body: corpo ? JSON.stringify(corpo) : undefined })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j || {} }; }); })
      .catch(function () { return { ok: false, j: { erro: "Sem conexão com o servidor." } }; });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function norm(s) { return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
  function el(id) { return document.getElementById(id); }

  function abrir(opc) {
    OPC = opc || {}; MUDOU = false; EM_MOVER = null; FILTRO = ""; MOSTRAR_REMOVIDAS = false;
    var bg = el("b13CatBg");
    if (bg) bg.remove();
    bg = document.createElement("div");
    bg.id = "b13CatBg";
    bg.style.cssText = "position:fixed;inset:0;background:rgba(5,4,20,.85);z-index:100000;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:16px 8px";
    bg.innerHTML = '<div id="b13CatBox" style="background:#17143a;border:1px solid #514c96;border-radius:14px;max-width:660px;width:100%;padding:16px;color:#fff;font-family:inherit"></div>';
    bg.addEventListener("mousedown", function (e) { if (e.target === bg) fechar(); });
    document.body.appendChild(bg);
    desenhar();
    carregar();
  }
  function fechar() {
    var bg = el("b13CatBg");
    if (bg) bg.remove();
    if (OPC.aoFechar) { try { OPC.aoFechar(MUDOU); } catch (e) {} }
  }
  function carregar() {
    return req("/api/categorias-despesa").then(function (r) {
      if (!r.ok) { var b = el("b13CatLista"); if (b) b.innerHTML = '<div style="color:#ff8aa3">' + esc(r.j.erro || "Não consegui carregar as categorias.") + "</div>"; return; }
      DADOS = r.j; desenhar(); avisarMudanca();
    });
  }
  function avisarMudanca() {
    if (!DADOS || !OPC.aoMudar) return;
    try { OPC.aoMudar(DADOS.categorias.filter(function (c) { return !c.oculta; }).map(function (c) { return c.rotulo; })); } catch (e) {}
  }
  function msg(html, ok) {
    var m = el("b13CatMsg");
    if (m) m.innerHTML = html ? '<div style="margin:8px 0;padding:7px 10px;border-radius:8px;font-size:13px;background:' + (ok ? "#0e3a22" : "#3a1020") + ";border:1px solid " + (ok ? "#3ce88a" : "#ff5f8a") + '">' + html + "</div>" : "";
  }

  function desenhar() {
    var box = el("b13CatBox");
    if (!box) return;
    if (EM_MOVER) { desenharMover(box); return; }
    var tipos = (DADOS && DADOS.tipos) || [];
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px"><h3 style="margin:0;flex:1">⚙️ Categorias das despesas</h3><button class="btn btn-ghost" onclick="B13Categorias.fechar()">✕ Fechar</button></div>' +
      '<div style="font-size:12px;color:#b9b4e6;margin:6px 0 10px;line-height:1.45">Cada categoria tem um <b>tipo</b>, que decide onde a despesa aparece no resultado. As categorias originais, quando removidas, só somem das listas (as despesas já lançadas continuam como estão). As que você cria podem ser apagadas.</div>' +
      '<div style="background:#0f0d24;border:1px solid #2b2760;border-radius:10px;padding:10px;margin-bottom:10px"><div style="font-weight:800;font-size:13px;margin-bottom:6px">➕ Nova categoria</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap"><input id="b13CatNome" placeholder="Ex.: Cursos e treinamentos" maxlength="60" style="flex:2 1 200px">' +
      '<select id="b13CatTipo" style="flex:1 1 200px">' + tipos.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.nome) + "</option>"; }).join("") + "</select>" +
      '<button class="btn btn-mag" onclick="B13Categorias.adicionar()">Adicionar</button></div></div>' +
      '<div id="b13CatMsg"></div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px"><input id="b13CatBusca" placeholder="🔎 buscar categoria" value="' + esc(FILTRO) + '" oninput="B13Categorias.filtrar(this.value)" style="flex:1 1 180px">' +
      '<label style="font-size:12px;color:#b9b4e6;white-space:nowrap"><input type="checkbox" id="b13CatRem" ' + (MOSTRAR_REMOVIDAS ? "checked" : "") + ' onchange="B13Categorias.alternarRemovidas(this.checked)"> mostrar as removidas</label></div>' +
      '<div id="b13CatLista">' + listaHtml() + "</div>";
  }
  function listaHtml() {
    if (!DADOS) return '<div style="color:#b9b4e6;padding:8px">Carregando…</div>';
    var f = norm(FILTRO), grupos = {}, ordem = [];
    DADOS.categorias.forEach(function (c) {
      if (c.oculta && !MOSTRAR_REMOVIDAS) return;
      if (f && norm(c.rotulo + " " + c.tipoNome + " " + c.grupoNome).indexOf(f) < 0) return;
      if (!grupos[c.grupoNome]) { grupos[c.grupoNome] = []; ordem.push(c.grupoNome); }
      grupos[c.grupoNome].push(c);
    });
    if (!ordem.length) return '<div style="color:#b9b4e6;padding:8px">Nenhuma categoria nesse filtro.</div>';
    return ordem.map(function (g) {
      return '<div style="margin-top:10px;font-size:12px;font-weight:800;color:#9fd2ff;text-transform:uppercase;letter-spacing:.4px">' + esc(g) + "</div>" + grupos[g].map(linhaHtml).join("");
    }).join("");
  }
  function linhaHtml(c) {
    var uso = c.emUso && c.emUso.total ? '<span style="font-size:11px;color:#ffd23f"> · ' + c.emUso.total + " lançamento(s)</span>" : "";
    var tag = (c.custom ? ' <span style="font-size:10px;background:#0e5a32;border-radius:6px;padding:1px 6px">criada por você</span>' : "") + (c.oculta ? ' <span style="font-size:10px;background:#5a1a2a;border-radius:6px;padding:1px 6px">removida</span>' : "") + (c.protegida ? ' <span style="font-size:10px;background:#2b2760;border-radius:6px;padding:1px 6px" title="O sistema usa esta categoria para o que não reconhece">do sistema</span>' : "");
    var cod = esc(c.cod).replace(/'/g, "");
    var btns = '<button class="btn btn-ghost" style="padding:3px 8px" title="Renomear" onclick="B13Categorias.renomear(\'' + cod + '\')">✏️</button>' +
      (c.oculta ? '<button class="btn btn-ghost" style="padding:3px 8px" onclick="B13Categorias.restaurar(\'' + cod + '\')">↩️ Restaurar</button>' : (c.protegida ? "" : '<button class="btn btn-ghost" style="padding:3px 8px" title="Remover" onclick="B13Categorias.remover(\'' + cod + '\')">🗑</button>'));
    return '<div style="display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid #221e4f;' + (c.oculta ? "opacity:.6" : "") + '"><div style="flex:1;min-width:0"><b>' + esc(c.rotulo) + "</b>" + tag + uso +
      '<div style="font-size:11px;color:#9a95c9">' + esc(c.tipoNome) + '</div></div><div style="white-space:nowrap;display:flex;gap:4px">' + btns + "</div></div>";
  }

  function achar(cod) { return DADOS && DADOS.categorias.filter(function (c) { return c.cod === cod; })[0]; }

  function adicionar() {
    var nome = (el("b13CatNome").value || "").trim(), tipo = el("b13CatTipo").value;
    if (nome.length < 2) { msg("Digite o nome da categoria."); return; }
    req("/api/categorias-despesa", "POST", { nome: nome, tipo: tipo }).then(function (r) {
      if (!r.ok) { msg(esc(r.j.erro || "Não consegui adicionar.")); return; }
      MUDOU = true; FILTRO = "";
      carregar().then(function () { msg("✅ Categoria <b>" + esc(r.j.categoria.rotulo) + "</b> adicionada. Já aparece na lista de escolha.", true); var n = el("b13CatNome"); if (n) n.focus(); });
    });
  }
  function renomear(cod) {
    var c = achar(cod); if (!c) return;
    var novo = prompt("Novo nome da categoria " + c.cod + ":", c.nome);
    if (novo == null) return;
    req("/api/categorias-despesa/" + encodeURIComponent(cod), "POST", { nome: novo }).then(function (r) {
      if (!r.ok) { msg(esc(r.j.erro || "Não consegui renomear.")); return; }
      MUDOU = true;
      carregar().then(function () { msg("✅ Renomeada" + (r.j.atualizados ? " (" + r.j.atualizados + " lançamento(s) já mostram o nome novo)" : "") + ".", true); });
    });
  }
  function restaurar(cod) {
    req("/api/categorias-despesa/" + encodeURIComponent(cod), "POST", { oculta: false }).then(function (r) {
      if (!r.ok) { msg(esc(r.j.erro || "Não consegui restaurar.")); return; }
      MUDOU = true; carregar().then(function () { msg("✅ Categoria de volta nas listas.", true); });
    });
  }
  function remover(cod) {
    var c = achar(cod); if (!c) return;
    if (c.custom && c.emUso && c.emUso.total > 0) { EM_MOVER = { cod: cod }; desenhar(); return; }
    var txt = c.custom ? "Apagar a categoria \"" + c.rotulo + "\"?" : "Remover \"" + c.rotulo + "\" das listas?\n\nÉ uma categoria original do plano: as despesas já lançadas nela continuam como estão, e você pode restaurá-la depois." + (c.emUso && c.emUso.total ? "\n\nHoje há " + c.emUso.total + " lançamento(s) nela." : "");
    if (!confirm(txt)) return;
    req("/api/categorias-despesa/" + encodeURIComponent(cod), "DELETE", {}).then(function (r) {
      if (!r.ok) { msg(esc(r.j.erro || "Não consegui remover.")); return; }
      MUDOU = true; carregar().then(function () { msg(r.j.acao === "removida" ? "✅ Categoria apagada." : "✅ Categoria removida das listas (dá para restaurar em \"mostrar as removidas\").", true); });
    });
  }
  // categoria criada por você e em uso: escolhe para onde mover os lançamentos antes de apagar
  function desenharMover(box) {
    var c = achar(EM_MOVER.cod), grupos = {}, ordem = [];
    DADOS.categorias.forEach(function (x) { if (x.cod === c.cod || x.oculta) return; if (!grupos[x.grupoNome]) { grupos[x.grupoNome] = []; ordem.push(x.grupoNome); } grupos[x.grupoNome].push(x); });
    var opts = ordem.map(function (g) { return '<optgroup label="' + esc(g) + '">' + grupos[g].map(function (x) { return '<option value="' + esc(x.cod) + '"' + (x.cod === "5.9" ? " selected" : "") + ">" + esc(x.rotulo) + "</option>"; }).join("") + "</optgroup>"; }).join("");
    box.innerHTML = '<h3 style="margin:0 0 8px">🗑 Apagar "' + esc(c.rotulo) + '"</h3>' +
      '<div style="font-size:13px;line-height:1.5;margin-bottom:10px">Esta categoria está em uso: <b>' + c.emUso.titulos + "</b> conta(s) a pagar/despesa(s), <b>" + c.emUso.fixas + "</b> despesa(s) fixa(s)" + (c.emUso.gastosFixos ? " e <b>" + c.emUso.gastosFixos + "</b> gasto(s) fixo(s)" : "") + ". Escolha para qual categoria mover tudo:</div>" +
      '<select id="b13CatDest" style="width:100%">' + opts + "</select>" +
      '<div style="font-size:12px;color:#ffd23f;margin-top:8px;line-height:1.4">Atenção: se a categoria de destino for de outro tipo (por exemplo, despesa fixa para variável), esses valores passam a aparecer em outro lugar do resultado.</div>' +
      '<div id="b13CatMsg"></div><div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-ghost" style="flex:1" onclick="B13Categorias.cancelarMover()">Voltar</button><button class="btn btn-mag" style="flex:1" onclick="B13Categorias.confirmarMover()">Mover e apagar</button></div>';
  }
  function cancelarMover() { EM_MOVER = null; desenhar(); }
  function confirmarMover() {
    var dest = el("b13CatDest").value, cod = EM_MOVER.cod;
    req("/api/categorias-despesa/" + encodeURIComponent(cod), "DELETE", { moverPara: dest }).then(function (r) {
      if (!r.ok) { msg(esc(r.j.erro || "Não consegui mover.")); return; }
      MUDOU = true; EM_MOVER = null;
      carregar().then(function () { msg("✅ Categoria apagada e " + (r.j.movidos || 0) + " lançamento(s) movido(s).", true); });
    });
  }
  function filtrar(v) { FILTRO = v; var l = el("b13CatLista"); if (l) l.innerHTML = listaHtml(); }
  function alternarRemovidas(v) { MOSTRAR_REMOVIDAS = !!v; var l = el("b13CatLista"); if (l) l.innerHTML = listaHtml(); }

  window.B13Categorias = { abrir: abrir, fechar: fechar, adicionar: adicionar, renomear: renomear, restaurar: restaurar, remover: remover, cancelarMover: cancelarMover, confirmarMover: confirmarMover, filtrar: filtrar, alternarRemovidas: alternarRemovidas };
})();
