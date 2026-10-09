/* =============================================================================
   Envio de FOTO e VÍDEO (vários por vez) — componente compartilhado.
   Usado na conferência (celular e computador) e na ocorrência da entrega do motorista.

   - Escolher mais de uma foto ou vídeo; cada um aparece numa lista, com miniatura,
     tamanho e situação, e pode ser tirado antes de enviar (✕).
   - O arquivo vai em BINÁRIO direto pro servidor (nada de base64, que incha o arquivo e
     era o que estourava o limite do servidor), com barra de progresso e nova tentativa
     automática se a internet falhar no meio.
   - Escrito em JavaScript simples (var/function) pra funcionar em aparelhos antigos.

   Uso:
     var midia = B13Midia.criar({
       container: "idDoElemento",     // onde desenhar
       base: BACKEND,                 // endereço do servidor ("" = o mesmo)
       comprimirVideo: fn(file, cb),  // opcional: cb(blobMenor, erro)
       imediato: { pedidoId: fn, meta: fn },  // opcional: envia assim que escolhe
       aoMudar: fn                    // opcional
     });
     midia.enviarTodos(pedidoId, {funcionarioId, funcionarioNome, eventoFoto, eventoVideo})
          .then(function(enviados){ ... }).catch(function(err){ ... });
   ============================================================================= */
(function () {
  var LIM_FOTO = 30 * 1024 * 1024, LIM_VIDEO = 200 * 1024 * 1024, MAX_ARQUIVOS = 10;

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]); }
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function legivel(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
  }
  function tipoDe(file) {
    var t = String(file.type || "").toLowerCase();
    if (t.indexOf("video/") === 0) return "video";
    if (t.indexOf("image/") === 0) return "foto";
    var n = String(file.name || "").toLowerCase();
    if (/\.(mp4|mov|webm|3gp|mkv|m4v)$/.test(n)) return "video";
    if (/\.(jpe?g|png|webp|gif|heic|heif)$/.test(n)) return "foto";
    return null;
  }

  // injeta o estilo uma vez
  function estilo() {
    if (document.getElementById("b13m-css")) return;
    var st = el("style", { id: "b13m-css" },
      ".b13m-btns{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}" +
      ".b13m-btn{flex:1 1 45%;min-width:120px;background:#1c1846;color:#fff;border:1px solid #514c96;border-radius:10px;padding:11px 8px;font-size:13px;font-weight:800;cursor:pointer;text-align:center}" +
      ".b13m-btn:active{background:#2a1740}" +
      ".b13m-item{display:flex;gap:8px;align-items:center;background:#151233;border:1px solid #2c2660;border-radius:10px;padding:6px;margin-bottom:6px;text-align:left}" +
      ".b13m-th{width:54px;height:54px;border-radius:8px;object-fit:cover;background:#0f0d24;flex-shrink:0}" +
      ".b13m-info{flex:1;min-width:0;font-size:12px;color:#d6d2ff}" +
      ".b13m-info b{display:block;color:#fff;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".b13m-ok{color:#3ce88a}.b13m-err{color:#ff8090}.b13m-w{color:#ffd23f}" +
      ".b13m-barra{height:5px;background:#2c2660;border-radius:3px;margin-top:4px;overflow:hidden}" +
      ".b13m-barra i{display:block;height:100%;background:#FF0082;width:0}" +
      ".b13m-x{background:#3a0010;color:#ff8f7a;border:none;border-radius:8px;width:34px;height:34px;font-size:14px;cursor:pointer;flex-shrink:0}" +
      ".b13m-re{background:#1c1846;color:#fff;border:1px solid #514c96;border-radius:8px;padding:4px 8px;font-size:11px;cursor:pointer;margin-top:4px}" +
      ".b13m-msg{font-size:12px;margin:4px 0}");
    document.head.appendChild(st);
  }

  // MINIATURA: depois que o arquivo sobe, gera uma capa pequena (JPEG ~360px) do PRÓPRIO arquivo que está no aparelho
  // e manda pro servidor. O painel de comprovantes mostra essa capa em vez de baixar o vídeo/foto inteiro.
  // Silencioso: se falhar (aparelho antigo, sem sessão), nada muda para quem está conferindo.
  function gerarMiniatura(file, tipo) {
    return new Promise(function (res) {
      var obj = null; try { obj = URL.createObjectURL(file); } catch (e) { return res(null); }
      var to = setTimeout(function () { limpar(); res(null); }, 15000);
      function limpar() { try { URL.revokeObjectURL(obj); } catch (e) {} }
      function desenhar(fonte, w, h) {
        try { var W = 360, H = Math.round(W * (h || 3) / (w || 4)); var cv = document.createElement("canvas"); cv.width = W; cv.height = H;
          cv.getContext("2d").drawImage(fonte, 0, 0, W, H); clearTimeout(to); limpar(); res(cv.toDataURL("image/jpeg", 0.72)); }
        catch (e) { clearTimeout(to); limpar(); res(null); }
      }
      if (tipo === "video") {
        var v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto";
        v.onloadeddata = function () { try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch (e) { desenhar(v, v.videoWidth, v.videoHeight); } };
        v.onseeked = function () { desenhar(v, v.videoWidth, v.videoHeight); };
        v.onerror = function () { clearTimeout(to); limpar(); res(null); };
        v.src = obj;
      } else {
        var im = new Image();
        im.onload = function () { desenhar(im, im.naturalWidth, im.naturalHeight); };
        im.onerror = function () { clearTimeout(to); limpar(); res(null); };
        im.src = obj;
      }
    });
  }
  function enviarMiniatura(base, urlArquivo, file, tipo) {
    var tk = ""; try { var s = JSON.parse(localStorage.getItem("b13sess") || "null"); tk = (s && s.token) || ""; } catch (e) {}
    if (!tk || !urlArquivo) return;
    gerarMiniatura(file, tipo).then(function (d) {
      if (!d) return;
      fetch((base || "") + "/api/comprovantes/miniatura", { method: "POST", headers: { "Content-Type": "application/json", "X-Auth-Token": tk }, body: JSON.stringify({ url: urlArquivo, dataUrl: d }) }).catch(function () {});
    });
  }

  // Envia UM arquivo em binário, com progresso. Tenta de novo (até 3x) só se for falha de rede.
  function enviarArquivo(base, pedidoId, file, tipo, meta, onPct) {
    meta = meta || {};
    var evento = tipo === "video" ? (meta.eventoVideo || "video_conferencia") : (meta.eventoFoto || "foto_conferencia");
    var url = (base || "") + "/api/comprovante-arquivo/" + encodeURIComponent(pedidoId) +
      "?tipo=" + tipo + "&evento=" + encodeURIComponent(evento) +
      "&funcionarioId=" + encodeURIComponent(meta.funcionarioId || "") +
      "&funcionarioNome=" + encodeURIComponent(meta.funcionarioNome || "");
    var contentType = file.type || (tipo === "video" ? "video/mp4" : "image/jpeg");
    function tentar(n) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.setRequestHeader("Content-Type", contentType);
        xhr.timeout = 15 * 60 * 1000;
        xhr.upload.onprogress = function (e) { if (e.lengthComputable && onPct) onPct(Math.round(e.loaded * 100 / e.total)); };
        xhr.onload = function () {
          var j = {}; try { j = JSON.parse(xhr.responseText); } catch (e) {}
          if (xhr.status >= 200 && xhr.status < 300 && j.ok) return resolve(j);
          var e2 = new Error(j.erro || (xhr.status >= 500 ? "o servidor está indisponível agora" : "o servidor recusou o arquivo (" + xhr.status + ")"));
          e2.definitivo = xhr.status >= 400 && xhr.status < 500; // erro do arquivo: repetir não adianta
          reject(e2);
        };
        xhr.onerror = function () { reject(new Error("sem conexão com o servidor")); };
        xhr.ontimeout = function () { reject(new Error("o envio demorou demais")); };
        xhr.send(file);
      }).catch(function (err) {
        if (err.definitivo || n >= 2) throw err;
        return new Promise(function (r) { setTimeout(r, 1500 * (n + 1)); }).then(function () { if (onPct) onPct(0); return tentar(n + 1); });
      });
    }
    return tentar(0);
  }

  function criar(opts) {
    estilo();
    var cont = typeof opts.container === "string" ? document.getElementById(opts.container) : opts.container;
    if (!cont) return null;
    var base = opts.base || "";
    var itens = [], seq = 0;

    cont.innerHTML = "";
    var btns = el("div", { "class": "b13m-btns" });
    var lista = el("div", { "class": "b13m-lista" });
    var msg = el("div", { "class": "b13m-msg" });
    cont.appendChild(btns); cont.appendChild(lista); cont.appendChild(msg);

    var entradas = [];
    function entradaArquivo(rotulo, accept, capture, multiplo) {
      var inp = el("input", { type: "file", accept: accept, style: "display:none" });
      if (capture) inp.setAttribute("capture", "environment");
      if (multiplo) inp.setAttribute("multiple", "multiple");
      inp.onchange = function () { adicionar(inp.files); try { inp.value = ""; } catch (e) {} };
      var b = el("button", { type: "button", "class": "b13m-btn" }, rotulo);
      b.onclick = function () { inp.click(); };
      btns.appendChild(b); cont.appendChild(inp); entradas.push(inp);
    }
    entradaArquivo("📷 Tirar foto", "image/*", true, false);
    entradaArquivo("🖼️ Fotos da galeria", "image/*", false, true);
    entradaArquivo("🎥 Gravar vídeo", "video/*", true, false);
    entradaArquivo("🎞️ Vídeos da galeria", "video/*", false, true);

    function aviso(t, cls) { msg.innerHTML = t ? '<span class="' + (cls || "b13m-w") + '">' + esc(t) + "</span>" : ""; }
    function mudou() { desenhar(); if (opts.aoMudar) { try { opts.aoMudar(api); } catch (e) {} } }

    function desenhar() {
      lista.innerHTML = "";
      itens.forEach(function (it) {
        var th = it.tipo === "foto"
          ? el("img", { "class": "b13m-th", src: it.previa })
          : el("video", { "class": "b13m-th", src: it.previa + "#t=0.1", muted: "muted", preload: "metadata", playsinline: "playsinline" });
        var estado;
        if (it.estado === "preparando") estado = '<span class="b13m-w">preparando o vídeo…</span>';
        else if (it.estado === "enviando") estado = '<span class="b13m-w">enviando <span class="b13m-pct">' + it.pct + '%</span></span><div class="b13m-barra"><i style="width:' + it.pct + '%"></i></div>';
        else if (it.estado === "enviado") estado = '<span class="b13m-ok">✅ enviado</span>';
        else if (it.estado === "erro") estado = '<span class="b13m-err">❌ ' + esc(it.erro || "erro") + "</span>";
        else estado = '<span class="muted">pronto pra enviar</span>';
        var row = el("div", { "class": "b13m-item", "data-id": String(it.id) });
        row.appendChild(th);
        var info = el("div", { "class": "b13m-info" }, "<b>" + (it.tipo === "video" ? "🎥 " : "📷 ") + esc(it.nome) + "</b>" + legivel(it.tamanho) + " · " + estado);
        if (it.estado === "erro" && opts.imediato) {
          var re = el("button", { type: "button", "class": "b13m-re" }, "Tentar de novo");
          re.onclick = function () { enviarUm(it); };
          info.appendChild(re);
        }
        row.appendChild(info);
        var x = el("button", { type: "button", "class": "b13m-x", title: "Tirar da lista" }, "✕");
        x.disabled = it.estado === "enviando" || it.estado === "preparando";
        x.onclick = function () { remover(it.id); };
        row.appendChild(x);
        lista.appendChild(row);
      });
    }

    // durante o envio só mexe na barra (redesenhar a lista inteira recriava a miniatura do vídeo a cada avanço)
    function atualizarPct(it) {
      var r = lista.querySelector('[data-id="' + it.id + '"]');
      if (!r) { desenhar(); return; }
      var t = r.querySelector(".b13m-pct"), b = r.querySelector(".b13m-barra i");
      if (t) t.textContent = it.pct + "%";
      if (b) b.style.width = it.pct + "%";
    }
    function remover(id) {
      itens = itens.filter(function (i) { if (i.id === id) { try { URL.revokeObjectURL(i.previa); } catch (e) {} return false; } return true; });
      mudou();
    }

    function adicionar(files) {
      if (!files || !files.length) return;
      aviso("");
      var rejeitados = [];
      for (var i = 0; i < files.length; i++) {
        (function (file) {
          var tipo = tipoDe(file);
          if (!tipo) { rejeitados.push(file.name + " (não é foto nem vídeo)"); return; }
          if (itens.length >= MAX_ARQUIVOS) { rejeitados.push(file.name + " (máximo de " + MAX_ARQUIVOS + " arquivos)"); return; }
          var limite = tipo === "video" ? LIM_VIDEO : LIM_FOTO;
          // vídeo grande pode ser comprimido antes; o limite vale pro arquivo que vai de fato
          var pode = tipo === "video" && opts.comprimirVideo && file.size > 6 * 1048576;
          if (file.size > limite && !pode) {
            rejeitados.push((file.name || tipo) + " tem " + legivel(file.size) + " (máximo " + legivel(limite) + "; grave um trecho mais curto)");
            return;
          }
          var it = { id: ++seq, file: file, tipo: tipo, nome: file.name || (tipo === "video" ? "video" : "foto"), tamanho: file.size, estado: "pronto", pct: 0, previa: URL.createObjectURL(file), url: null };
          itens.push(it);
          if (pode) preparar(it, limite); else if (opts.imediato) enviarUm(it);
        })(files[i]);
      }
      if (rejeitados.length) aviso("Não adicionei: " + rejeitados.join("; ") + ".", "b13m-err");
      mudou();
    }

    // comprime o vídeo (se a tela forneceu a função); se não der, segue com o original, desde que caiba
    function preparar(it, limite) {
      it.estado = "preparando"; mudou();
      var respondeu = false;
      function seguir(blob, err) {
        if (respondeu) return; respondeu = true; clearTimeout(timer);
        if (blob && !err && blob.size > 0 && blob.size < it.file.size) {
          try { URL.revokeObjectURL(it.previa); } catch (e) {}
          it.file = blob; it.tamanho = blob.size; it.previa = URL.createObjectURL(blob);
        }
        if (it.file.size > limite) { it.estado = "erro"; it.erro = "vídeo grande demais (" + legivel(it.file.size) + "); grave um trecho mais curto"; mudou(); return; }
        it.estado = "pronto"; mudou();
        if (opts.imediato) enviarUm(it);
      }
      var timer = setTimeout(function () { seguir(null, "demorou"); }, 25000);
      try { opts.comprimirVideo(it.file, seguir); } catch (e) { seguir(null, "sem suporte"); }
    }

    function enviarUm(it, metaFixa, pedidoFixo) {
      var pedidoId = pedidoFixo != null ? pedidoFixo : (opts.imediato && opts.imediato.pedidoId ? opts.imediato.pedidoId() : null);
      var meta = metaFixa || (opts.imediato && opts.imediato.meta ? opts.imediato.meta() : {});
      if (pedidoId == null || pedidoId === "") { it.estado = "erro"; it.erro = "pedido não identificado"; mudou(); return Promise.resolve(false); }
      it.estado = "enviando"; it.pct = 0; it.erro = null; mudou();
      return enviarArquivo(base, pedidoId, it.file, it.tipo, meta, function (p) { it.pct = p; atualizarPct(it); })
        .then(function (j) { it.estado = "enviado"; it.url = j.url; mudou(); try { enviarMiniatura(base, j.url, it.file, it.tipo); } catch (e) {} return true; })
        .catch(function (e) { it.estado = "erro"; it.erro = e.message || "falha no envio"; mudou(); return false; });
    }

    var api = {
      itens: function () { return itens.slice(); },
      quantidade: function () { return itens.length; },
      ocupado: function () { return itens.some(function (i) { return i.estado === "preparando" || i.estado === "enviando"; }); },
      enviados: function () { return itens.filter(function (i) { return i.estado === "enviado" && i.url; }).map(function (i) { return { url: i.url, tipo: i.tipo }; }); },
      // telas que redesenham o próprio HTML (ex.: o modal do motorista) chamam isto depois de
      // cada redesenho: leva a lista (com tudo o que já foi escolhido/enviado) pro container novo
      moverPara: function (container) {
        var novo = typeof container === "string" ? document.getElementById(container) : container;
        if (!novo || novo === cont) return;
        cont = novo; cont.innerHTML = "";
        cont.appendChild(btns); cont.appendChild(lista); cont.appendChild(msg);
        entradas.forEach(function (inp) { cont.appendChild(inp); });
      },
      limpar: function () { itens.forEach(function (i) { try { URL.revokeObjectURL(i.previa); } catch (e) {} }); itens = []; aviso(""); mudou(); },
      // envia (em fila, um de cada vez) tudo o que ainda não foi; os já enviados não repetem.
      // aoProgredir(feitos, total) é opcional. Falha se algum não for.
      enviarTodos: function (pedidoId, meta, aoProgredir) {
        var fila = itens.filter(function (i) { return i.estado !== "enviado"; });
        var total = itens.length, feitos = total - fila.length;
        if (!fila.length) return Promise.resolve(api.enviados());
        if (itens.some(function (i) { return i.estado === "preparando"; })) return Promise.reject(new Error("Espere terminar de preparar os vídeos."));
        var falhas = [];
        var cadeia = Promise.resolve();
        fila.forEach(function (it) {
          cadeia = cadeia.then(function () {
            if (aoProgredir) aoProgredir(feitos, total);
            return enviarUm(it, meta, pedidoId).then(function (ok) { if (ok) feitos++; else falhas.push((it.nome || it.tipo) + ": " + (it.erro || "falhou")); });
          });
        });
        return cadeia.then(function () {
          if (aoProgredir) aoProgredir(feitos, total);
          if (falhas.length) throw new Error(falhas.length + " de " + fila.length + " arquivo(s) não foram enviados — " + falhas.join("; "));
          return api.enviados();
        });
      },
    };
    mudou();
    return api;
  }

  window.B13Midia = { criar: criar, enviarArquivo: enviarArquivo, LIM_FOTO: LIM_FOTO, LIM_VIDEO: LIM_VIDEO };
})();
