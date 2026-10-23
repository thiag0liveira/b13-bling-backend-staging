/* Comprovante único da B13 Bebidas (modelo do Caixa Atacado).
 * Usado por Caixa Atacado, Venda Atacado, Pedidos e Propostas.
 *
 * Dados esperados em v (todos opcionais, exceto itens):
 *   numero, pedidoId, numeroConfirmado, dataHora, situacao
 *   ehProposta (true = ainda não é pedido: sem QR e sem código de barras)
 *   cliente {nome}, vendedor, operador
 *   ehEntrega, endereco
 *   itens [{nome, quantidade, preco}]
 *   frete, outrasDespesas, desconto, total
 *   pagamentos [{formaNome, valor}], troco, pago
 *   obsImpressa  (texto da "Observação impressa na nota"; a observação do Bling nunca entra aqui)
 */
(function () {
  const W = 580, padd = 24;

  function brl(n) {
    return "R$ " + (+n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function esc(s) {
    return String(s !== null && s !== undefined ? s : "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // quebra o texto em até maxLinhas, sem cortar palavras; palavra maior que a linha é dividida
  function quebrar(ctx, texto, maxW, maxLinhas) {
    texto = String(texto || "").trim();
    if (!texto) return [""];
    const cabe = s => ctx.measureText(s).width <= maxW;
    const palavras = texto.split(/\s+/);
    const linhas = [];
    let atual = "";
    for (const p of palavras) {
      const teste = atual ? atual + " " + p : p;
      if (cabe(teste)) {
        atual = teste;
      } else {
        if (atual) linhas.push(atual);
        if (!cabe(p)) {
          let resto = p;
          while (resto.length && !cabe(resto)) {
            let corte = resto;
            while (corte.length > 1 && !cabe(corte)) corte = corte.slice(0, -1);
            linhas.push(corte);
            resto = resto.slice(corte.length);
          }
          atual = resto;
        } else {
          atual = p;
        }
      }
    }
    if (atual) linhas.push(atual);
    if (linhas.length <= maxLinhas) return linhas;
    const cortadas = linhas.slice(0, maxLinhas);
    let ult = cortadas[maxLinhas - 1];
    while (ult.length > 1 && !cabe(ult + "…")) ult = ult.slice(0, -1);
    cortadas[maxLinhas - 1] = ult + "…";
    return cortadas;
  }

  function desenhar(v, qrEl, barCanvas) {
    const itensArr = (v.itens || []).map(i => ({
      nome: i.nome || ("Produto " + (i.produtoId || "")),
      quantidade: i.quantidade,
      preco: i.preco != null ? i.preco : i.valor
    }));
    const itemH = 54, headerH = 136, qrSize = 210;
    const dpr = 3;
    const _mc = document.createElement("canvas").getContext("2d");
    _mc.font = "900 19px Arial";
    const maxNomeW = W - 200 - padd - 16;
    itensArr.forEach(i => { i._linhas = quebrar(_mc, i.nome, maxNomeW, 3); });
    const extraLinhasItens = itensArr.reduce((s, i) => s + (i._linhas.length - 1), 0);
    _mc.font = "700 20px Arial";
    const linhasEndereco = (v.ehEntrega && v.endereco) ? quebrar(_mc, v.endereco, W - padd * 2, 4) : [];
    _mc.font = "900 18px Arial";
    const obsTxt = v.obsImpressa && String(v.obsImpressa).trim() ? String(v.obsImpressa).trim() : "";
    const linhasObs = obsTxt ? obsTxt.split(/\n+/).flatMap(par => quebrar(_mc, par.trim() || " ", W - padd * 2, 60)) : [];
    const pagamentos = v.pagamentos || [];
    const outras = Number(v.outrasDespesas || 0), frete = Number(v.frete || 0), desconto = Number(v.desconto || 0);
    const temExtras = outras > 0.009 || frete > 0.009 || desconto > 0.009;
    const pago = v.pago === undefined ? pagamentos.length > 0 : !!v.pago;
    const semQr = !!v.ehProposta || !(v.pedidoId || v.numero);

    // estimativa generosa da altura; no final o canvas é aparado ao tamanho real
    const H = 1300 + itensArr.length * itemH + extraLinhasItens * 26 + pagamentos.length * 34
      + (Number(v.troco) > 0.009 ? 50 : 0) + (linhasObs.length ? 50 + linhasObs.length * 26 : 0)
      + (temExtras ? 140 : 0) + linhasEndereco.length * 28 + 200;

    const cv = document.createElement("canvas");
    cv.width = W * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "alphabetic";
    const cortes = [];

    // cabeçalho (fundo preto para sair sólido na térmica)
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, headerH - 14);
    ctx.fillStyle = "#fff";
    ctx.font = "900 34px Arial";
    ctx.textAlign = "left";
    ctx.fillText("B13 BEBIDAS", padd, 52);
    ctx.font = "900 15px Arial";
    ctx.fillText("Av. Brigadeiro Eduardo Gomes, 1668 — Glória, BH", padd, headerH - 40);
    ctx.fillText("(31) 99971-9888", padd, headerH - 22);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, headerH - 10, W, 4);
    let y = headerH + 30;

    // pedido (ou proposta) + código de barras
    ctx.fillStyle = "#000";
    ctx.textAlign = "left";
    if (v.ehProposta) {
      ctx.font = "900 15px Arial";
      ctx.fillText("PROPOSTA COMERCIAL", padd, y);
      ctx.font = "700 15px Arial";
      ctx.fillText("Ainda não é um pedido fechado, sujeita a confirmação.", padd, y + 26);
      ctx.font = "900 15px Arial";
      ctx.fillText(new Date(v.dataHora || Date.now()).toLocaleString("pt-BR"), padd, y + 52);
      y += 72;
    } else {
      ctx.font = "900 15px Arial";
      ctx.fillText("PEDIDO", padd, y);
      const ehId = v.numeroConfirmado === false || String(v.numero || "").length >= 10;
      ctx.font = "900 46px Arial";
      ctx.fillText("#" + (v.numero || "—"), padd, y + 46);
      let ySub = y + 72;
      if (ehId) {
        ctx.font = "700 15px Arial";
        ctx.fillText("(código interno, nº do pedido em confirmação)", padd, y + 68);
        ySub = y + 90;
      }
      ctx.font = "900 15px Arial";
      const rotuloData = new Date(v.dataHora || Date.now()).toLocaleString("pt-BR") + (v.situacao ? "  ·  " + v.situacao : "");
      ctx.fillText(rotuloData, padd, ySub);
      if (barCanvas && !semQr) {
        const bw = 250, bh = barCanvas.height * (bw / barCanvas.width);
        try {
          ctx.drawImage(barCanvas, W - padd - bw, y - 4, bw, bh);
          ctx.font = "900 13px Arial";
          ctx.textAlign = "center";
          ctx.fillText("Apresente no caixa", W - padd - bw / 2, y - 4 + bh + 16);
        } catch (e) {}
      }
      y = Math.max(y + 112, ySub + 28);
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, y, W, 2);
    y += 32;

    // cliente
    ctx.font = "900 15px Arial";
    ctx.fillStyle = "#000";
    ctx.textAlign = "left";
    ctx.fillText("CLIENTE", padd, y);
    ctx.font = "900 26px Arial";
    ctx.fillText((v.cliente && v.cliente.nome) || "Consumidor Final", padd, y + 30);
    y += 52;
    if (v.ehEntrega && v.endereco) {
      y += 10;
      ctx.font = "900 15px Arial";
      ctx.textAlign = "left";
      ctx.fillText("ENTREGAR EM", padd, y);
      ctx.font = "700 20px Arial";
      linhasEndereco.forEach((ln, ix) => ctx.fillText(ln, padd, y + 26 + ix * 25));
      y += 26 + linhasEndereco.length * 25 + 10;
    }
    if (v.vendedor) {
      y += 6;
      ctx.font = "900 15px Arial";
      ctx.fillText("MONTADO POR", padd, y);
      ctx.font = "900 22px Arial";
      ctx.fillText(v.vendedor, padd + 180, y);
      y += 34;
    }
    if (v.operador) {
      ctx.font = "900 15px Arial";
      ctx.fillText("RECEBIDO POR", padd, y);
      ctx.font = "900 22px Arial";
      ctx.fillText(v.operador, padd + 180, y);
      y += 34;
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, y, W, 2);
    y += 32;

    // itens
    ctx.font = "900 15px Arial";
    ctx.textAlign = "left";
    ctx.fillText("ITENS (" + itensArr.length + ")", padd, y);
    y += 26;
    ctx.font = "900 14px Arial";
    ctx.fillText("PRODUTO", padd, y);
    ctx.textAlign = "center";
    ctx.fillText("QTD", W - 200, y);
    ctx.textAlign = "right";
    ctx.fillText("UNIT.", W - padd, y);
    y += 10;
    ctx.fillRect(padd, y, W - padd * 2, 2);
    y += itemH - 14;
    itensArr.forEach((i, ix) => {
      ctx.font = "900 19px Arial";
      ctx.textAlign = "left";
      i._linhas.forEach((ln, li) => ctx.fillText(ln, padd, y + li * 24));
      ctx.font = "900 22px Arial";
      ctx.textAlign = "center";
      ctx.fillText(String(i.quantidade), W - 200, y);
      ctx.font = "900 17px Arial";
      ctx.textAlign = "right";
      ctx.fillText(brl(i.preco), W - padd, y);
      const extra = (i._linhas.length - 1) * 24;
      if (ix < itensArr.length - 1) ctx.fillRect(padd, y + extra + 18, W - padd * 2, 1);
      cortes.push(y + extra + 18); // pode trocar de página aqui (entre um item e outro)
      y += itemH + extra;
    });
    y += 8;
    ctx.fillRect(0, y, W, 2);
    cortes.push(y + 2);
    y += 36;

    // subtotal, outras despesas, frete e desconto, quando houver
    if (temExtras) {
      const sub = +itensArr.reduce((s, i) => s + (Number(i.quantidade) || 0) * (Number(i.preco) || 0), 0).toFixed(2);
      ctx.font = "900 20px Arial";
      ctx.textAlign = "left";
      ctx.fillText("Subtotal", padd, y);
      ctx.textAlign = "right";
      ctx.fillText(brl(sub), W - padd, y);
      y += 30;
      if (outras > 0.009) {
        ctx.textAlign = "left"; ctx.fillText("Outras despesas", padd, y);
        ctx.textAlign = "right"; ctx.fillText(brl(outras), W - padd, y);
        y += 30;
      }
      if (frete > 0.009) {
        ctx.textAlign = "left"; ctx.fillText("Frete", padd, y);
        ctx.textAlign = "right"; ctx.fillText(brl(frete), W - padd, y);
        y += 30;
      }
      if (desconto > 0.009) {
        ctx.textAlign = "left"; ctx.fillText("Desconto", padd, y);
        ctx.textAlign = "right"; ctx.fillText("- " + brl(desconto), W - padd, y);
        y += 30;
      }
      y += 18;
    } else {
      y += 12;
    }

    // total + PAGO
    ctx.font = "900 32px Arial";
    ctx.textAlign = "left";
    ctx.fillText("TOTAL", padd, y);
    ctx.textAlign = "right";
    ctx.font = "900 38px Arial";
    ctx.fillText(brl(v.total), W - padd, y);
    y += 40;
    if (pago) {
      ctx.textAlign = "left";
      ctx.font = "900 22px Arial";
      ctx.fillText("✓ PAGO", padd, y);
      y += 34;
    }
    if (pagamentos.length) {
      ctx.font = "700 15px Arial";
      ctx.textAlign = "left";
      ctx.fillText("Forma de pagamento", padd, y);
      y += 28;
    }
    pagamentos.forEach(p => {
      const valorTxt = brl(p.valor);
      const nomeForma = String(p.formaNome || "").trim() || "Forma não informada";
      ctx.textAlign = "left";
      ctx.font = "900 18px Arial";
      const maxW = W - 2 * padd - ctx.measureText(valorTxt).width - 14;
      let tam = 18;
      while (tam > 12) {
        ctx.font = "900 " + tam + "px Arial";
        if (ctx.measureText(nomeForma).width <= maxW) break;
        tam--;
      }
      ctx.fillText(nomeForma, padd, y);
      ctx.font = "900 18px Arial";
      ctx.textAlign = "right";
      ctx.fillText(valorTxt, W - padd, y);
      y += 30;
    });
    if (Number(v.troco) > 0.009) {
      y += 4;
      ctx.font = "900 24px Arial";
      ctx.textAlign = "left";
      ctx.fillText("TROCO", padd, y);
      ctx.textAlign = "right";
      ctx.font = "900 26px Arial";
      ctx.fillText(brl(v.troco), W - padd, y);
      y += 34;
    }

    // observação impressa na nota (texto do sistema, não o do Bling)
    if (linhasObs.length) {
      y += 8;
      ctx.font = "900 15px Arial";
      ctx.textAlign = "left";
      ctx.fillText("OBSERVAÇÃO", padd, y);
      y += 24;
      ctx.font = "900 18px Arial";
      linhasObs.forEach(l => { ctx.fillText(l, padd, y); y += 24; });
      y += 2;
    }
    y += 12;

    // divisor tracejado grosso
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    y += 36;

    // QR de acompanhamento (só pedido de verdade)
    if (qrEl && !semQr) {
      try { ctx.drawImage(qrEl, (W - qrSize) / 2, y, qrSize, qrSize); } catch (e) {}
      y += qrSize + 26;
      ctx.fillStyle = "#000";
      ctx.font = "900 15px Arial";
      ctx.textAlign = "center";
      ctx.fillText("Leia o QR para ver o status do pedido", W / 2, y);
      y += 26;
    }
    ctx.fillStyle = "#000";
    ctx.font = "900 17px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Obrigado pela preferência!", W / 2, y);
    y += 28;

    // apara para o tamanho real
    const cvFinal = document.createElement("canvas");
    cvFinal.width = W * dpr;
    cvFinal.height = Math.round(y * dpr);
    cvFinal.getContext("2d").drawImage(cv, 0, 0);
    cvFinal._cortes = cortes;
    cvFinal._dpr = dpr;
    cvFinal._W = W;
    return cvFinal;
  }

  // divide em páginas A4 sempre entre um item e outro
  function paginasA4(cv) {
    const dpr = cv._dpr || 3, pageH = Math.floor((cv._W || W) * 1.414) - 14, H = cv.height / dpr;
    const cortes = (cv._cortes || []).slice().sort((a, b) => a - b);
    const paginas = [];
    for (let ini = 0; ini < H - 1;) {
      let fim = ini + pageH;
      if (fim >= H) fim = H;
      else {
        const c = cortes.filter(x => x > ini + 120 && x <= fim).pop();
        if (c) fim = c;
      }
      const pc = document.createElement("canvas");
      pc.width = cv.width;
      pc.height = Math.round((fim - ini) * dpr);
      pc.getContext("2d").drawImage(cv, 0, Math.round(ini * dpr), cv.width, pc.height, 0, 0, cv.width, pc.height);
      paginas.push(pc.toDataURL("image/png"));
      ini = fim;
    }
    return paginas;
  }

  // monta QR e código de barras, desenha e manda para a impressora.
  // opts.janela: janela já aberta no clique (evita bloqueio de pop-up); opts.paginar: A4 em várias páginas
  function imprimir(v, opts) {
    opts = opts || {};
    if (!v) { alert("Nada para imprimir."); if (opts.janela && !opts.janela.closed) opts.janela.close(); return; }
    const w = opts.janela || window.open("", "_blank", "width=420,height=700");
    if (!w) {
      alert("O navegador bloqueou a janela de impressão. Permita pop-ups para este site (ícone na barra de endereço) e tente de novo.");
      return;
    }
    if (!opts.janela) w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Comprovante</title></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px;color:#888">Gerando comprovante…</body></html>');
    const idCodigo = String(v.pedidoId || v.numero || "");
    const semQr = !!v.ehProposta || !idCodigo;
    const tmpQr = document.createElement("div");
    tmpQr.style.cssText = "position:absolute;left:-9999px;top:-9999px";
    document.body.appendChild(tmpQr);
    let barCanvas = null;
    if (!semQr) {
      try {
        new QRCode(tmpQr, { text: location.origin + "/pedido/" + idCodigo + "/acompanhar", width: 340, height: 340, correctLevel: QRCode.CorrectLevel.M });
      } catch (e) {}
      barCanvas = document.createElement("canvas");
      try { JsBarcode(barCanvas, idCodigo, { format: "CODE128", width: 2, height: 70, fontSize: 16, margin: 0 }); } catch (e) {}
    }
    setTimeout(function () {
      const fecharTmp = () => { if (tmpQr.parentNode) tmpQr.parentNode.removeChild(tmpQr); };
      if (w.closed) { fecharTmp(); return; }
      const qrEl = tmpQr.querySelector("canvas") || tmpQr.querySelector("img");
      const cv = desenhar(v, qrEl, barCanvas);
      fecharTmp();
      const urls = opts.paginar ? paginasA4(cv) : [cv.toDataURL("image/png")];
      const titulo = v.ehProposta ? "Proposta" : "Pedido #" + esc(v.numero || "");
      w.document.open();
      w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + titulo + '</title>' +
        '<style>*{margin:0;padding:0}body{text-align:center;background:#fff}img{width:100%;max-width:400px;display:block;margin:0 auto;image-rendering:crisp-edges}@page{margin:0}' +
        '@media print{body{margin:0}img{max-width:100%;width:100%}.pg{break-after:page;page-break-after:always}.pg:last-child{break-after:auto;page-break-after:auto}}</style></head><body>' +
        urls.map(u => '<div class="pg"><img src="' + u + '"></div>').join("") +
        '<script>window.onload=function(){setTimeout(function(){window.print();},250);};<\/script></body></html>');
      w.document.close();
    }, 220);
  }

  window.B13Comprovante = { desenhar, imprimir, paginasA4, quebrar };
})();
