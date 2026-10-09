/* =============================================================================
   FICHA DO PEDIDO — componente compartilhado (Central de Entregas, Comprovantes...).
   Uso: <script src="/ficha-pedido.js"></script>  e  B13Ficha.abrir(pedidoId)
   Busca /api/pedido-ficha/:id (dados locais, rápido) e mostra tudo sobre o pedido:
   pedido, separação, conferência, entrega/retirada, pagamento, ocorrência, fotos e
   vídeos, assinatura, itens e linha do tempo.
   ============================================================================= */
(function () {
  var B = location.protocol.indexOf("http") === 0 ? "" : "https://app.b13bebidas.com.br";
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function brl(n) { return Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  function dmy(d) { return d ? String(d).split("-").reverse().join("/") : "—"; }
  function hora(ms) { return ms ? new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"; }
  function min(m) { if (m == null) return "—"; if (m < 60) return m + " min"; var h = Math.floor(m / 60), r = m % 60; return h + "h" + (r ? String(r).padStart(2, "0") : ""); }
  function token() { try { var s = JSON.parse(localStorage.getItem("b13sess") || "null"); return (s && s.token) || ""; } catch (e) { return ""; } }
  var ST = { entregue: ["✅ Entregue", "ok"], nao_entregue: ["↩️ Não entregue", "erro"], em_rota: ["🛵 Em rota", "azul"], sem_registro: ["⚠️ Viagem fechada sem registro", "warn"],
    aguardando_saida: ["🚚 No carro, aguardando saída", "neu"], aguardando_carro: ["⏳ Aguardando carro", "neu"], retirado: ["🏪 Retirado no local", "ok"], sem_rota: ["Sem rota de entrega", "neu"] };
  var PG = { pago_caixa: ["💳 pago no caixa", "ok"], pago_registro: ["📝 pago fora do caixa", "azul"], pago_entrega: ["💵 recebido na entrega", "ok"], ja_pago: ["pago antes", "ok"],
    prazo: ["🗓️ a prazo", "warn"], parcial: ["parcial", "warn"], pendente: ["não pago", "neu"], sem_pagamento: ["❗ sem pagamento", "erro"] };
  function css() {
    if (document.getElementById("b13FichaCss")) return;
    var st = document.createElement("style"); st.id = "b13FichaCss";
    st.textContent = ".b13f-fundo{position:fixed;inset:0;background:rgba(0,0,0,.62);display:none;align-items:flex-start;justify-content:center;z-index:300;overflow-y:auto;padding:24px 10px}" +
      ".b13f-fundo.aberto{display:flex}.b13f-modal{background:#151233;border:1px solid #2c2660;border-radius:14px;padding:16px;width:100%;max-width:880px;color:#fff;font-family:Arial,Helvetica,sans-serif}" +
      ".b13f-bloco{background:#120f2c;border:1px solid #2c2660;border-radius:10px;padding:12px;margin-top:10px}.b13f-bloco h4{font-size:13px;margin:0 0 8px;color:#cfcaf5}" +
      ".b13f-lin{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:4px 0;border-bottom:1px solid #1d1946}.b13f-lin:last-child{border-bottom:none}.b13f-lin span{color:#9a95c9}.b13f-lin b{text-align:right}" +
      ".b13f-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px}" +
      ".b13f-tag{display:inline-block;font-size:10.5px;font-weight:800;padding:3px 8px;border-radius:6px;white-space:nowrap;margin-right:4px}" +
      ".b13f-tag.ok{background:#11352a;color:#6be3a8}.b13f-tag.warn{background:#3a2a0a;color:#ffd23f}.b13f-tag.erro{background:#3d1020;color:#ff8aa3}.b13f-tag.neu{background:#24205a;color:#cfcaf5}.b13f-tag.azul{background:#0d2a44;color:#7fd0ff}" +
      ".b13f-gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}.b13f-gal a,.b13f-gal div{display:block;border:1px solid #2c2660;border-radius:8px;overflow:hidden;background:#0b0a1e;text-decoration:none;color:#cfcaf5}" +
      ".b13f-gal img{width:100%;height:110px;object-fit:cover;display:block}.b13f-gal video{width:100%;height:110px;display:block;background:#000}.b13f-gal small{display:block;padding:5px 7px;font-size:10.5px;color:#9a95c9}" +
      ".b13f-tl{border-left:2px solid #2c2660;padding-left:12px}.b13f-tl div{font-size:12.5px;padding:4px 0}.b13f-tl span{color:#9a95c9}" +
      ".b13f-btn{border:none;border-radius:9px;font-weight:800;cursor:pointer;font-size:12px;padding:8px 12px;color:#fff;background:#1c1846;border:1px solid #3a3480}" +
      ".b13f-desc{font-size:12px;color:#9a95c9}";
    document.head.appendChild(st);
  }
  function fundo() {
    var f = document.getElementById("b13FichaFundo");
    if (f) return f;
    css(); f = document.createElement("div"); f.id = "b13FichaFundo"; f.className = "b13f-fundo";
    f.innerHTML = '<div class="b13f-modal" id="b13FichaCorpo"></div>';
    f.addEventListener("click", function (e) { if (e.target === f) fechar(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") fechar(); });
    document.body.appendChild(f); return f;
  }
  function fechar() { var f = document.getElementById("b13FichaFundo"); if (f) f.classList.remove("aberto"); }
  function lin(a, b) { return '<div class="b13f-lin"><span>' + a + "</span><b>" + b + "</b></div>"; }
  function midia(m) {
    var orig = m.origem === "entrega" ? "entrega/ocorrência" : m.origem === "conferencia" ? "conferência" : "outro";
    if (m.tipo === "video") return '<div><video src="' + esc(B + m.url) + '" controls preload="none"' + (m.thumb ? ' poster="' + esc(B + m.thumb) + '"' : "") + '></video><small>🎥 ' + orig + " · " + hora(m.em) + " · " + esc(m.por) + "</small></div>";
    return '<a href="' + esc(B + m.url) + '" target="_blank" rel="noopener"><img src="' + esc(B + (m.thumb || m.url)) + '" loading="lazy" onerror="B13Ficha._semArquivo(this)"><small>📷 ' + orig + " · " + hora(m.em) + " · " + esc(m.por) + "</small></a>";
  }
  function render(x) {
    var st = ST[x.status] || [x.status, "neu"], pg = PG[x.pagamento.situacao] || [x.pagamento.situacao, "neu"];
    var conf = x.midias.filter(function (m) { return m.origem === "conferencia"; }), ent = x.midias.filter(function (m) { return m.origem !== "conferencia"; });
    var S = x.separacao, C = x.conferencia, E = x.entrega;
    var h = '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">' +
      '<div><div style="font-size:18px;font-weight:900">Pedido #' + esc(x.numero) + " · " + esc(x.cliente || "—") + "</div>" +
      '<div style="margin-top:6px"><span class="b13f-tag ' + st[1] + '">' + st[0] + '</span><span class="b13f-tag ' + pg[1] + '">' + pg[0] + "</span>" +
      (x.tipo ? '<span class="b13f-tag neu">' + (x.tipo === "retirada" ? "🏪 retirada" : "🛵 entrega") + "</span>" : "") +
      '<b style="font-size:15px;margin-left:4px">' + brl(x.total) + "</b></div></div>" +
      '<button class="b13f-btn" onclick="B13Ficha.fechar()">Fechar</button></div>';
    h += '<div class="b13f-grid2"><div class="b13f-bloco"><h4>🧾 Pedido</h4>' +
      lin("Criado", hora(x.criadoEm) + (x.criadoPor ? " · " + esc(x.criadoPor) : "")) + (x.vendedor ? lin("Vendedor", esc(x.vendedor)) : "") +
      (x.origem ? lin("Origem", esc(x.origem)) : "") + lin("Valor", brl(x.total) + (x.frete ? " (frete " + brl(x.frete) + ")" : "")) +
      (x.telefone ? lin("Telefone", esc(x.telefone)) : "") + (x.endereco ? lin("Endereço", esc(x.endereco)) : "") + "</div>" +
      '<div class="b13f-bloco"><h4>📦 Separação e conferência</h4>' +
      lin("Separado por", S ? esc(S.por || "—") + (S.comFalta ? ' <span class="b13f-tag warn">com falta</span>' : "") : "—") +
      lin("Separação", S ? (S.inicioEm ? hora(S.inicioEm) + " → " : "") + hora(S.em) + (S.duracaoMin != null ? " (" + min(S.duracaoMin) + ")" : "") : "—") +
      lin("Conferido por", C ? esc(C.por || "—") : "—") +
      lin("Conferência", C ? (C.inicioEm ? hora(C.inicioEm) + " → " : "") + hora(C.em) + (C.duracaoMin != null ? " (" + min(C.duracaoMin) + ")" : "") : "—") +
      (C && C.esperaMin != null ? lin("Esperou entre separar e conferir", min(C.esperaMin)) : "") +
      (C && C.ajustes ? lin("Ajustes na conferência", '<span class="b13f-tag warn">' + C.ajustes + "</span>") : "") + "</div></div>";
    h += '<div class="b13f-grid2"><div class="b13f-bloco"><h4>' + (x.tipo === "retirada" ? "🏪 Retirada" : "🛵 Entrega") + "</h4>" +
      (x.tipo === "retirada" ? lin("Retirado", C && C.tipo === "retirada" ? hora(C.em) : "—") :
        lin("Dia agendado", dmy(x.dataEntrega) + (x.turno && x.turno !== "qualquer" ? " · " + esc(x.turno) : "")) + (x.km ? lin("Distância", String(x.km).replace(".", ",") + " km") : "") +
        lin("Carro / viagem", esc(x.carro || "—") + (x.viagem ? " · viagem " + x.viagem.viagem : "")) + lin("Motorista", esc((x.viagem && x.viagem.motorista) || "—")) +
        lin("Saiu", hora(x.viagem && x.viagem.iniciadaEm)) + lin(x.status === "nao_entregue" ? "Tentativa" : "Entregue", E && E.em ? hora(E.em) : "—") +
        (E && E.peloGerente ? lin("Registrado por", esc(E.registradoPor || "escritório") + " (Resolver corrida)") : "") + (x.tentativas ? lin("Tentativas sem sucesso", x.tentativas) : "")) +
      (x.obsEntrega ? lin("Observação", esc(x.obsEntrega)) : "") + "</div>" +
      '<div class="b13f-bloco"><h4>💵 Pagamento</h4>' + lin("Situação", esc(x.pagamento.texto)) +
      (x.pagamento.detalhe ? lin(x.pagamento.situacao === "pago_registro" ? "Formas registradas" : "No caixa", esc(x.pagamento.detalhe)) : "") +
      (x.pagamento.operador ? lin(x.pagamento.situacao === "pago_registro" ? "Registrado por" : "Recebido por", esc(x.pagamento.operador)) : "") +
      (x.pagamento.quando ? lin("Quando", hora(x.pagamento.quando)) : "") +
      x.formas.map(function (f) { return lin(esc(f.forma) + (f.banco ? " (" + esc(f.banco) + ")" : ""), brl(f.valor)); }).join("") +
      (E && E.valorProblema > 0 ? lin("Abatido por problema", "− " + brl(E.valorProblema)) : "") + (x.recebidoEntrega ? lin("Recebido na entrega", brl(x.recebidoEntrega)) : "") + "</div></div>";
    if (E && (E.ocorrencia || (E.itensProblema || []).length || E.motivo)) {
      h += '<div class="b13f-bloco"><h4>⚠️ Ocorrência e problemas</h4>' + (E.ocorrencia ? lin("Ocorrência", esc(E.ocorrencia.descricao || "(sem descrição)")) : "") + (E.motivo ? lin("Motivo", esc(E.motivo)) : "") +
        (E.itensProblema || []).map(function (p) { return lin(esc(p.nome || p.descricao || "item"), esc((p.tipo || p.problema || "problema") + (p.quantidade ? " · " + p.quantidade + " un" : ""))); }).join("") + "</div>";
    }
    h += '<div class="b13f-bloco"><h4>📷 Fotos e vídeos da conferência (' + conf.length + ")</h4>" + (conf.length ? '<div class="b13f-gal">' + conf.map(midia).join("") + "</div>" : '<div class="b13f-desc">Nenhuma.</div>') + "</div>";
    if (x.tipo !== "retirada" || ent.length) h += '<div class="b13f-bloco"><h4>📷 Fotos e vídeos da entrega / ocorrência (' + ent.length + ")</h4>" + (ent.length ? '<div class="b13f-gal">' + ent.map(midia).join("") + "</div>" : '<div class="b13f-desc">Nenhuma.</div>') + "</div>";
    if (x.tipo !== "retirada") h += '<div class="b13f-bloco"><h4>✍️ Assinatura do cliente</h4><div id="b13fAssin">' + (E && E.temAssinatura ? '<button class="b13f-btn" onclick="B13Ficha.assinatura(\'' + esc((x.viagem && x.viagem.token) || "") + "','" + esc(x.pedidoId) + "')\">Ver assinatura</button>" : '<div class="b13f-desc">' + (E && E.peloGerente ? "Entrega registrada pelo escritório (sem assinatura)." : "Sem assinatura.") + "</div>") + "</div></div>";
    if (x.itens.length) h += '<div class="b13f-bloco"><h4>🧾 Itens (' + x.itens.length + ")</h4>" + x.itens.map(function (i) { return lin(esc(i.nome), (i.quantidade || 0) + " un · " + brl(i.valor)); }).join("") + "</div>";
    h += '<div class="b13f-bloco"><h4>🕓 Linha do tempo</h4><div class="b13f-tl">' + (x.linha.length ? x.linha.map(function (e) { return "<div><b>" + hora(e.em) + "</b> · " + esc(e.texto) + " <span>" + (e.por ? "· " + esc(e.por) : "") + "</span></div>"; }).join("") : "—") + "</div></div>";
    document.getElementById("b13FichaCorpo").innerHTML = h;
  }
  function abrir(pid) {
    var f = fundo(); f.classList.add("aberto");
    document.getElementById("b13FichaCorpo").innerHTML = '<div style="padding:30px;text-align:center;color:#9a95c9">Carregando o pedido…</div>';
    fetch(B + "/api/pedido-ficha/" + encodeURIComponent(pid), { headers: { "X-Auth-Token": token() } }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ficha) throw new Error(j.erro || "não consegui carregar");
      render(j.ficha);
    }).catch(function (e) { document.getElementById("b13FichaCorpo").innerHTML = '<div style="padding:20px">' + esc(e.message) + ' <button class="b13f-btn" onclick="B13Ficha.fechar()">Fechar</button></div>'; });
  }
  function assinatura(tok, pid) {
    var el = document.getElementById("b13fAssin"); el.innerHTML = '<span class="b13f-desc">Carregando…</span>';
    fetch(B + "/api/central-entregas/assinatura/" + encodeURIComponent(tok) + "/" + encodeURIComponent(pid), { headers: { "X-Auth-Token": token() } }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (r) { el.innerHTML = r.ok ? '<img src="' + r.j.dataUrl + '" style="max-width:100%;background:#fff;border-radius:8px;padding:6px">' : '<div class="b13f-desc">' + esc(r.j.erro || "Não encontrada.") + "</div>"; });
  }
  // arquivo apagado pela limpeza automática (ou que não existe mais): aviso no lugar da imagem quebrada
  function semArquivo(img) { var d = document.createElement("div"); d.style.cssText = "height:110px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:11px;color:#9a95c9;padding:8px"; d.textContent = "arquivo não está mais disponível (limpeza automática de arquivos antigos)"; if (img.parentNode) { var a = img.parentNode; if (a.tagName === "A") a.removeAttribute("href"); a.replaceChild(d, img); } }
  window.B13Ficha = { abrir: abrir, fechar: fechar, assinatura: assinatura, _semArquivo: semArquivo };
})();
