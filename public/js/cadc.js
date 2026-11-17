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
      eventos.push({ rot: 'Início do ' + i.nome, off: a });
      eventos.push({ rot: 'Retorno do ' + i.nome, off: b });
      if (o >= a && o < b) intervalo = i.nome;
    }
    eventos.push({ rot: 'Fim do turno', off: dur });

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
   * [{ numero, hora, produto, concluido, observacao }] + totais ok / nok.
   * Inclui contagens anteriores do mesmo dia (ex.: antes de uma troca de produto).
   */
  historico(cel, agoraHMS) {
    const lista = [];
    if (!cel) return { lista, ok: 0, nok: 0 };
    for (const a of (cel.anteriores || [])) lista.push({ ...a });
    if (cel.pronto && cel.turno && cel.ciclos) {
      const t = cel.turno, o = Cadc.off(agoraHMS, t), fora = o > Cadc.dur(t);
      const marcas = cel.marcas || {};
      cel.ciclos.forEach((h, i) => {
        if (!fora && Cadc.off(h, t) > o) return;
        const m = marcas[i + 1];
        lista.push({ numero: i + 1, hora: h, produto: cel.produto ? cel.produto.nome : '',
                     concluido: m ? m.c : true, observacao: m ? m.o : '' });
      });
    }
    lista.reverse();
    const nok = lista.filter(x => !x.concluido).length;
    return { lista, ok: lista.length - nok, nok };
  },

  /** Avisos automáticos de voz (iguais aos do cadenciador comum), em offset no turno. */
  falasAutomaticas(cel) {
    if (!cel || !cel.pronto || !cel.turno || !cel.ciclos) return [];
    const t = cel.turno, dur = Cadc.dur(t);
    const m = new Map();     // um aviso por segundo; o de maior prioridade ganha
    const por = (off, fala, prio) => { const a = m.get(off); if (!a || prio > a.prio) m.set(off, { off, fala, prio }); };

    for (const h of cel.ciclos) por(Cadc.off(h, t), 'Ciclo finalizado', 1);
    for (const i of (t.intervalos || [])) {
      por(Cadc.off(i.hora_inicio, t), i.aviso_voz || `Intervalo de ${i.nome} iniciado`, 3);
      por(Cadc.off(i.hora_fim, t), 'Ciclo iniciado', 3);
    }
    por(0, 'Ciclo iniciado', 4);
    por(dur, 'Turno finalizado', 4);
    return [...m.values()].sort((a, b) => a.off - b.off);
  }
};
