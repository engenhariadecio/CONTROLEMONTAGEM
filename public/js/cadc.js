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

  /** Relógio corrigido pelo servidor: todos os tablets marcam o mesmo segundo. */
  desvio: 0,
  acertar(horaServidor) {
    if (!horaServidor) return;
    const d = new Date();
    const local = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    let dif = Cadc.seg(horaServidor) - local;
    if (dif > 43200) dif -= 86400;
    if (dif < -43200) dif += 86400;
    // Diferença grande = fuso diferente do esperado: nesse caso vale o relógio do aparelho
    Cadc.desvio = Math.abs(dif) <= 300 ? dif : 0;
  },
  agoraSeg() {
    const d = new Date();
    return (((d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + Cadc.desvio) % 86400) + 86400) % 86400;
  },
  agora() { return Cadc.hms(Cadc.agoraSeg()); },

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
