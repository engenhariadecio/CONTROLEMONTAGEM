/* ═══════════════════════════════════════════════════════
   Cadenciador central — contas de tempo compartilhadas
   pelo painel do admin e pela tela do tablet.
   ═══════════════════════════════════════════════════════ */

const Cadc = {
  seg(hms) {
    const p = String(hms || '0').split(':').map(Number);
    return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
  },
  hms(seg) {
    const t = Math.max(0, Math.round(seg));
    return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map(n => String(n).padStart(2, '0')).join(':');
  },
  /** mm:ss quando cabe, hh:mm:ss quando passa de uma hora */
  curto(seg) {
    const t = Math.max(0, Math.round(seg));
    if (t >= 3600) return Cadc.hms(t);
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  },
  off(hms, turno) {
    let o = Cadc.seg(hms) - Cadc.seg(turno.hora_inicio);
    if (o < 0) o += 86400;
    return o;
  },
  dur(turno) {
    const i = Cadc.seg(turno.hora_inicio), f = Cadc.seg(turno.hora_fim);
    return f > i ? f - i : (86400 - i) + f;
  },

  /**
   * Relógio oficial = o do servidor (hora da fábrica), não o do aparelho.
   * PC e tablets ficam no mesmo segundo mesmo que o relógio de um deles esteja errado.
   * `r` é a resposta do servidor ({ hora, hora_seg }); t0/t1 = performance.now() antes/depois da consulta.
   */
  _base: null,
  acertar(r, t0, t1) {
    if (!r) return;
    const agora = performance.now();
    if (t1 == null) t1 = agora;
    if (t0 == null) t0 = t1;
    const ida = Math.max(0, t1 - t0);
    let seg = typeof r.hora_seg === 'number' ? r.hora_seg : (r.hora ? Cadc.seg(r.hora) + 0.5 : null);
    if (seg == null) return;
    seg += ida / 2000;                       // metade do tempo de ida e volta
    const b = Cadc._base;
    if (b) {
      let dif = seg - (b.seg + (t1 - b.em) / 1000);
      if (dif > 43200) dif -= 86400;
      if (dif < -43200) dif += 86400;
      const velho = t1 - b.em > 120000;
      // Mantém a referência atual enquanto ela estiver boa (evita o relógio "tremer")
      if (Math.abs(dif) < 0.35 && !(velho && ida <= b.ida)) return;
      if (Math.abs(dif) < 1.5 && ida > b.ida + 150 && !velho) return;
    }
    Cadc._base = { seg, em: t1, ida };
  },
  sincronizado() { return !!Cadc._base; },
  /** Segundos do dia, com fração. Sem contato com o servidor ainda, usa o relógio do aparelho. */
  agoraFrac() {
    const b = Cadc._base;
    if (b) return (((b.seg + (performance.now() - b.em) / 1000) % 86400) + 86400) % 86400;
    const d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
  },
  agoraSeg() { return Math.floor(Cadc.agoraFrac()); },
  agora() { return Cadc.hms(Cadc.agoraSeg()); },
  /**
   * Chama fn() exatamente na virada de cada segundo do relógio oficial —
   * assim todas as telas trocam o número ao mesmo tempo.
   */
  aCadaSegundo(fn) {
    let parar = false;
    const passo = () => {
      if (parar) return;
      try { fn(); } catch (e) { console.error(e); }
      const f = Cadc.agoraFrac();
      setTimeout(passo, Math.max(40, (1 - (f - Math.floor(f))) * 1000 + 12));
    };
    passo();
    return () => { parar = true; };
  },

  /**
   * Pausa em andamento: { decorrido, restante (null se sem hora para voltar), total }.
   * Calculada pelo relógio oficial, então PC e tablets mostram o mesmo número.
   */
  pausa(cel) {
    if (!cel || !cel.pausada) return null;
    const agora = Cadc.agoraSeg();      // segundo cheio: todas as telas fazem a mesma conta
    const volta = v => { let d = v % 86400; if (d < 0) d += 86400; return d; };
    let decorrido = cel.pausa_decorrido_seg || 0;
    if (cel.pausa_inicio_seg != null && decorrido < 80000) decorrido = volta(agora - cel.pausa_inicio_seg);
    let restante = null, total = null;
    if (cel.pausa_fim_seg != null) {
      let r = volta(cel.pausa_fim_seg - agora);
      if (r > 43200) r = 0;                 // já passou da hora de voltar
      restante = r;
      total = cel.pausa_inicio_seg != null ? volta(cel.pausa_fim_seg - cel.pausa_inicio_seg) : decorrido + r;
    } else if (cel.pausa_restante_seg != null) {
      restante = cel.pausa_restante_seg; total = decorrido + restante;
    }
    return { decorrido: Math.floor(decorrido), restante: restante == null ? null : Math.ceil(restante), total };
  },

  /**
   * Onde a célula está agora.
   * fase: 'sem-config' | 'fora' | 'intervalo' | 'rodando' | 'encerrado'
   */
  situacao(cel, agoraHMS) {
    if (!cel || !cel.pronto || !cel.turno || !cel.ciclos) return { fase: 'sem-config', total: 0, feitos: 0, ciclo: 0 };
    const t = cel.turno;
    const dur = Cadc.dur(t);
    const o = Cadc.off(agoraHMS, t);
    const total = cel.ciclos.length;

    if (o > dur) {
      return { fase: 'fora', total, feitos: 0, ciclo: 0,
               proximo: { rot: 'Início do turno', restante: 86400 - o, janela: Math.max(1, 86400 - dur) } };
    }

    // Programação com hora de fim (2 produtos no mesmo turno): depois dela esta produção acabou
    const fim = cel.fim_off_seg != null && cel.fim_off_seg < dur ? cel.fim_off_seg : null;
    if (fim != null && o >= fim) return { fase: 'encerrado', total, feitos: total, ciclo: total, programacao: true };

    const eventos = [];
    let feitos = 0;
    for (const h of cel.ciclos) {
      const off = Cadc.off(h, t);
      eventos.push({ rot: 'Próximo ciclo', off });
      if (off <= o) feitos++;
    }
    let intervalo = null;
    for (const i of (t.intervalos || [])) {
      const a = Cadc.off(i.hora_inicio, t), b = Cadc.off(i.hora_fim, t);
      if (fim != null && a >= fim) continue;
      eventos.push({ rot: 'Início do ' + i.nome, off: a });
      if (fim == null || b < fim) eventos.push({ rot: 'Retorno do ' + i.nome, off: b });
      if (o >= a && o < b) intervalo = i.nome;
    }
    eventos.push(fim != null ? { rot: 'Fim da programação', off: fim } : { rot: 'Fim do turno', off: dur });

    const futuros = eventos.filter(e => e.off > o).sort((x, y) => x.off - y.off);
    if (!futuros.length) return { fase: 'encerrado', total, feitos, ciclo: total };

    const ev = futuros[0];
    const inicioCadencia = (cel.inicio_off_seg || 0) + (cel.tempo_parado_seg || 0);
    const passados = eventos.filter(e => e.off <= o).map(e => e.off);
    passados.push(Math.min(inicioCadencia, o));
    const base = Math.max(...passados);

    return {
      fase: intervalo ? 'intervalo' : 'rodando',
      intervalo,
      total, feitos,
      ciclo: Math.min(total, feitos + 1),
      proximo: { rot: ev.rot, restante: ev.off - o, janela: Math.max(1, ev.off - base) }
    };
  },

  /**
   * Ciclos já encerrados (mais recente primeiro), com a marcação do admin:
   * [{ numero, hora, produto, concluido, observacao, atrasado, pesados }] + totais ok / nok / atrasados.
   * atrasado = o ciclo fechou sem nenhum produto pesado dentro do prazo do takt.
   * Inclui contagens anteriores do mesmo dia (ex.: antes de uma troca de produto).
   */
  historico(cel, agoraHMS) {
    const lista = [];
    if (!cel) return { lista, ok: 0, nok: 0, atrasados: 0 };
    for (const a of (cel.anteriores || [])) lista.push({ ...a });
    if (cel.pronto && cel.turno && cel.ciclos) {
      const t = cel.turno, o = Cadc.off(agoraHMS, t), fora = o > Cadc.dur(t);
      const marcas = cel.marcas || {};
      cel.ciclos.forEach((h, i) => {
        if (!fora && Cadc.off(h, t) > o) return;
        const m = marcas[i + 1];
        lista.push({ numero: i + 1, hora: h, produto: cel.produto ? cel.produto.nome : '',
                     concluido: m ? m.c : true, observacao: m ? m.o : '',
                     atrasado: !!(m && m.at && !m.c), pesados: m && m.p != null ? m.p : null });
      });
    }
    lista.reverse();
    const nok = lista.filter(x => !x.concluido).length;
    return { lista, ok: lista.length - nok, nok, atrasados: lista.filter(x => x.atrasado).length };
  },

  /**
   * Gráfico de LINHA (SVG): tempo de saída de cada produto contra o takt.
   * Eixo X = horário do dia em que o produto foi pesado; eixo Y = minutos desde o produto anterior.
   * saidas = [{ n, h: 'HH:MM:SS', s: série, min }]; ponto verde = dentro do takt, vermelho = acima.
   */
  graficoSaidas(saidas, takt, { largura = 900, altura = 300, max = 300 } = {}) {
    const d = (saidas || []).slice(-max);
    const W = largura, H = altura, mE = 48, mD = 18, mT = 18, mB = 40;
    const iw = W - mE - mD, ih = H - mT - mB;
    const cor = { ok: '#26b247', nok: '#f26d6d', takt: '#f5c542', txt: '#9fb3c8', grade: 'rgba(159,179,200,.18)', linha: '#7fb6e6' };
    const e = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fm = v => String(Math.round(v * 10) / 10).replace('.', ',');
    const svg = g => `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;margin:auto" role="img" aria-label="Takt x tempo de saída de cada produto">${g}</svg>`;
    if (!d.length) return svg(`<text x="${W / 2}" y="${H / 2}" fill="${cor.txt}" font-size="15" text-anchor="middle">Nenhum produto pesado ainda nesta programação.</text>`);

    // horário de cada ponto em segundos (turno que cruza a meia-noite continua subindo)
    let ant = -1, volta = 0;
    const pts = d.map(x => { let t = Cadc.seg(x.h) + volta; if (t < ant - 43200) { volta += 86400; t += 86400; } ant = t; return { ...x, t }; });
    const t = Number(takt) || 0;
    let x0 = pts[0].t, x1 = pts[pts.length - 1].t;
    const folga = Math.max(120, (x1 - x0) * 0.04); x0 -= folga; x1 += folga;
    const topo = Math.max(t * 1.6, ...pts.map(p => Math.min(p.min, t ? t * 5 : p.min)), 1) * 1.08;
    const X = v => mE + (v - x0) / (x1 - x0) * iw;
    const Y = v => mT + ih - Math.min(v, topo) / topo * ih;
    const hhmm = v => { const m = Math.floor(((v % 86400) + 86400) % 86400 / 60); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = topo * i / 4, yy = Y(v);
      g += `<line x1="${mE}" y1="${yy}" x2="${W - mD}" y2="${yy}" stroke="${cor.grade}"/><text x="${mE - 6}" y="${yy + 4}" fill="${cor.txt}" font-size="11" text-anchor="end">${fm(v)}</text>`;
    }
    // marcas de horário "redondas" no eixo X
    const passo = [300, 600, 900, 1800, 3600, 7200].find(p => (x1 - x0) / p <= 9) || 14400;
    for (let v = Math.ceil(x0 / passo) * passo; v <= x1; v += passo) {
      g += `<line x1="${X(v)}" y1="${mT}" x2="${X(v)}" y2="${mT + ih}" stroke="${cor.grade}"/><text x="${X(v)}" y="${mT + ih + 15}" fill="${cor.txt}" font-size="11" text-anchor="middle">${hhmm(v)}</text>`;
    }
    if (t > 0) {
      g += `<rect x="${mE}" y="${mT}" width="${iw}" height="${Math.max(0, Y(t) - mT)}" fill="rgba(242,109,109,.06)"/>
            <line x1="${mE}" y1="${Y(t)}" x2="${W - mD}" y2="${Y(t)}" stroke="${cor.takt}" stroke-width="2" stroke-dasharray="7 5"/>
            <text x="${mE + 6}" y="${Y(t) - 5}" fill="${cor.takt}" font-size="12" font-weight="700">takt ${fm(t)} min</text>`;
    }
    g += `<polyline fill="none" stroke="${cor.linha}" stroke-width="2" stroke-linejoin="round" points="${pts.map(p => X(p.t).toFixed(1) + ',' + Y(p.min).toFixed(1)).join(' ')}"/>`;
    const r = pts.length > 80 ? 2.5 : pts.length > 30 ? 3.5 : 4.5;
    for (const p of pts) {
      const alto = t > 0 && p.min > t * 1.0001;
      g += `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.min).toFixed(1)}" r="${r}" fill="${alto ? cor.nok : cor.ok}" stroke="#0c1a26" stroke-width="1">
              <title>#${p.n} · ${e(p.s)} · pesado às ${e(String(p.h).slice(0, 8))} · saiu em ${fm(p.min)} min${t ? ' (takt ' + fm(t) + ')' : ''}</title></circle>`;
      if (p.min > topo) g += `<text x="${X(p.t)}" y="${mT - 4}" fill="${cor.nok}" font-size="10" text-anchor="middle">${fm(p.min)}</text>`;
    }
    g += `<text x="13" y="${mT + ih / 2}" fill="${cor.txt}" font-size="11" text-anchor="middle" transform="rotate(-90 13 ${mT + ih / 2})">tempo de saída (min)</text>
          <text x="${mE + iw / 2}" y="${H - 6}" fill="${cor.txt}" font-size="11" text-anchor="middle">horário do dia em que cada produto foi pesado</text>`;
    return svg(g);
  },

  /** Avisos automáticos de voz (iguais aos do cadenciador comum), em offset no turno. */
  falasAutomaticas(cel) {
    if (!cel || !cel.pronto || !cel.turno || !cel.ciclos) return [];
    const t = cel.turno, dur = Cadc.dur(t);
    const m = new Map();     // um aviso por segundo; o de maior prioridade ganha
    const por = (off, fala, prio) => { const a = m.get(off); if (!a || prio > a.prio) m.set(off, { off, fala, prio }); };

    for (const h of cel.ciclos) por(Cadc.off(h, t), 'Ciclo finalizado', 1);
    const fim = cel.fim_off_seg != null && cel.fim_off_seg < dur ? cel.fim_off_seg : null;
    for (const i of (t.intervalos || [])) {
      const a = Cadc.off(i.hora_inicio, t), b = Cadc.off(i.hora_fim, t);
      if (fim != null && a >= fim) continue;
      por(a, i.aviso_voz || `Intervalo de ${i.nome} iniciado`, 3);
      if (fim == null || b < fim) por(b, 'Ciclo iniciado', 3);
    }
    por(0, 'Ciclo iniciado', 4);
    if (fim == null) por(dur, 'Turno finalizado', 4);
    return [...m.values()].sort((a, b) => a.off - b.off);
  }
};
