/* ═══════════════════════════════════════════════════════
   Leitura da balança Urano (UR 10000 Light) pela porta USB
   do computador, direto no navegador (Chrome ou Edge).

   Funciona com:
   • kit Novus USB-i485 (o sinal chega invertido e é "desembaralhado" aqui);
   • cabo Urano RS232/USB ou conversor USB-TTL (sinal normal).

   O computador pede o peso várias vezes por segundo (caractere 05h),
   então a leitura é em tempo real, sem apertar ENVIA.

   Uso:
     const b = new Balanca({ aoLer: ({ kg, est }) => …, aoMudar: estado => … });
     b.religar();            // reabre sozinho a porta já autorizada neste computador
     b.escolher();           // abre a janela do navegador para escolher a porta (precisa de um clique)
   ═══════════════════════════════════════════════════════ */

class Balanca {
  constructor({ aoLer, aoMudar, baud = 9600, pedirCadaMs = 150 } = {}) {
    this.aoLer = aoLer || (() => {});
    this.aoMudar = aoMudar || (() => {});
    this.baud = baud;
    this.pedirCadaMs = pedirCadaMs;
    this.porta = null;
    this.ativo = false;
    this.buf = [];
    this.estado = 'desligada';       // desligada | abrindo | sem-sinal | lendo | erro
    this.ultLeitura = 0;
    this.ultRx = 0;
    this.invertido = false;
    this.memoria = new Map();        // mensagens já decifradas (o mesmo peso se repete muito)
    this.msgErro = '';
    this._relogios = [];
    if (Balanca.suportado) {
      navigator.serial.addEventListener('disconnect', e => { if (this.porta && e.target === this.porta) this._caiu('Cabo USB da balança foi desligado'); });
      navigator.serial.addEventListener('connect', () => { if (!this.ativo) this.religar(); });
    }
  }

  static get suportado() { return typeof navigator !== 'undefined' && 'serial' in navigator; }

  _mudar(estado, msg = '') {
    if (estado === this.estado && msg === this.msgErro) return;
    this.estado = estado; this.msgErro = msg;
    try { this.aoMudar(estado, msg); } catch (e) { console.error(e); }
  }

  /** Reabre a porta que este computador já autorizou (sem precisar de clique). */
  async religar() {
    if (!Balanca.suportado || this.ativo || this._abrindo) return false;
    let portas = [];
    try { portas = await navigator.serial.getPorts(); } catch (e) { return false; }
    if (!portas.length) return false;
    const preferida = Balanca._lembrada();
    const p = portas.find(x => Balanca._chave(x) === preferida) || portas[0];
    return this._abrir(p);
  }

  /** Abre a janela do navegador para escolher a porta USB (só funciona a partir de um clique). */
  async escolher() {
    if (!Balanca.suportado) { this._mudar('erro', 'Use o Chrome ou o Edge neste computador'); return false; }
    let p;
    try { p = await navigator.serial.requestPort(); } catch (e) { return false; }     // fechou a janela sem escolher
    await this.desligar();
    try { localStorage.setItem('balanca_porta', Balanca._chave(p)); } catch (e) { /* sem armazenamento */ }
    return this._abrir(p);
  }

  static _chave(p) { try { const i = p.getInfo(); return (i.usbVendorId || 0) + ':' + (i.usbProductId || 0); } catch (e) { return ''; } }
  static _lembrada() { try { return localStorage.getItem('balanca_porta') || ''; } catch (e) { return ''; } }

  async _abrir(p) {
    this._abrindo = true;
    this._mudar('abrindo');
    try {
      await p.open({ baudRate: this.baud, dataBits: 8, parity: 'none', stopBits: 2, bufferSize: 4096, flowControl: 'none' });
    } catch (e) {
      this._abrindo = false;
      this._mudar('erro', /already open|in use|Failed to open/i.test(e.message)
        ? 'A porta da balança está aberta em outra aba ou programa. Feche o outro e tente de novo.' : 'Não consegui abrir a porta: ' + e.message);
      return false;
    }
    this.porta = p; this.ativo = true; this._abrindo = false;
    this.buf = []; this.ultLeitura = 0; this.ultRx = 0;
    this._mudar('sem-sinal');
    this._ler();
    this._relogios.push(setInterval(() => this._pedir(), this.pedirCadaMs));
    this._relogios.push(setInterval(() => this._vigia(), 500));
    return true;
  }

  async desligar() {
    this.ativo = false;
    this._relogios.forEach(clearInterval); this._relogios = [];
    try { if (this.leitor) await this.leitor.cancel(); } catch (e) { /* já fechou */ }
    await new Promise(r => setTimeout(r, 60));
    try { if (this.porta) await this.porta.close(); } catch (e) { /* já fechou */ }
    this.porta = null;
    this._mudar('desligada');
  }

  _caiu(msg) {
    this.ativo = false;
    this._relogios.forEach(clearInterval); this._relogios = [];
    const p = this.porta; this.porta = null;
    try { if (p) p.close().catch(() => {}); } catch (e) { /* já fechou */ }
    this._mudar('erro', msg);
    // tenta voltar sozinho (cabo recolocado, notebook voltou do descanso…)
    clearTimeout(this._volta);
    this._volta = setTimeout(() => this.religar(), 2500);
  }

  async _pedir() {
    if (!this.ativo || !this.porta || !this.porta.writable || this._escrevendo) return;
    this._escrevendo = true;
    try { const w = this.porta.writable.getWriter(); await w.write(new Uint8Array([0x05])); w.releaseLock(); }
    catch (e) { /* a leitura acusa se a porta caiu */ }
    this._escrevendo = false;
  }

  _vigia() {
    if (!this.ativo) return;
    const agora = Date.now();
    if (this.buf.length && agora - this.ultRx > 400) this._sobra();
    if (this.estado === 'lendo' && agora - this.ultLeitura > 2500) this._mudar('sem-sinal');
  }

  async _ler() {
    let falhas = 0;
    while (this.ativo && this.porta && this.porta.readable) {
      this.leitor = this.porta.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.leitor.read();
          if (done) break;
          if (value && value.length) {
            falhas = 0; this.ultRx = Date.now();
            for (const x of value) this.buf.push(x);
            this._normais(); this._invertidos();
            if (this.buf.length > 4000) this.buf.splice(0, this.buf.length - 200);
          }
        }
      } catch (e) {
        // "Break received" / "Framing error" são normais com o kit Novus (sinal invertido): segue lendo
        if (!/break|framing|parity|overrun|buffer/i.test(e.message || '')) {
          if (++falhas > 3) { try { this.leitor.releaseLock(); } catch (x) { /* ok */ } this._caiu('A balança parou de responder (cabo USB?)'); return; }
        }
      } finally { try { this.leitor.releaseLock(); } catch (e) { /* ok */ } }
    }
    if (this.ativo) this._caiu('A balança parou de responder (cabo USB?)');
  }

  _entrega(kg, est, modo) {
    this.ultLeitura = Date.now();
    this.invertido = modo === 'invertido';
    if (this.estado !== 'lendo') this._mudar('lendo');
    try { this.aoLer({ kg, est, modo, em: this.ultLeitura }); } catch (e) { console.error(e); }
  }

  /* ---------- sinal normal: quadro ESC T … ESC P 0 1 (manual UR LIGHT) ---------- */
  _normais() {
    const b = this.buf;
    for (;;) {
      let ini = -1;
      for (let i = 0; i < b.length - 1; i++) if (b[i] === 0x1B && b[i + 1] === 0x54) { ini = i; break; }
      if (ini < 0) return;
      let fim = -1;
      for (let i = ini + 2; i < b.length - 3; i++) if (b[i] === 0x1B && b[i + 1] === 0x50 && b[i + 2] === 0x30 && b[i + 3] === 0x31) { fim = i + 4; break; }
      if (fim < 0) { if (ini > 0) b.splice(0, ini); return; }
      const q = b.slice(ini, fim); b.splice(0, fim);
      const r = Balanca.interpretar(q);
      if (r) this._entrega(r.kg, r.est, 'normal');
    }
  }
  static interpretar(q) {
    const s = String.fromCharCode(...q);
    if (q[0] !== 0x1B || s[1] !== 'T') return null;
    const est = s[24] === '*';
    if (s[2] === '2') {        // Urano C: peso 36–41, unidade 42
      const n = parseFloat(s.slice(35, 41).replace(',', '.').replace(/[^\d.\-]/g, ''));
      return isFinite(n) ? { kg: s[41] !== 'k' ? n / 1000 : n, est } : null;
    }
    // Urano 12: sinal 32, peso 33–38, unidade 39
    const n = parseFloat(s.slice(32, 38).replace(',', '.').replace(/[^\d.]/g, ''));
    return isFinite(n) ? { kg: (s[31] === '-' ? -1 : 1) * (s[38] !== 'k' ? n / 1000 : n), est } : null;
  }

  /* ---------- sinal invertido (kit Novus): cada mensagem termina com um byte 00 ---------- */
  _invertidos() {
    const b = this.buf;
    const e = b.indexOf(0x1B);
    if (e >= 0 && e < b.length - 1 && b[e + 1] === 0x54) return;       // é quadro normal chegando
    for (;;) {
      const z = b.indexOf(0);
      if (z < 0) return;
      const q = b.splice(0, z + 1);
      if (q.length >= 30) this._decifra(q.slice(0, -1));
    }
  }
  _sobra() {
    const q = this.buf.splice(0, this.buf.length);
    if (q.length >= 30) this._decifra(q.filter(x => x !== 0));
  }
  _decifra(q) {
    const chave = q.join(',');
    let r = this.memoria.get(chave);
    if (r === undefined) {
      let c = [];
      try { c = Balanca.desinverter(q); } catch (e) { console.error(e); }
      r = c[0] && c[0].limpo ? { kg: c[0].kg, est: c[0].est } : null;
      if (this.memoria.size > 3000) this.memoria.clear();
      this.memoria.set(chave, r);
    }
    if (r) this._entrega(r.kg, r.est, 'invertido');
  }

  /**
   * Sinal TTL lido "de cabeça para baixo" pelo conversor RS-485: reconstrói os bits da linha
   * e relê do jeito certo. Devolve os pesos possíveis, o melhor primeiro
   * ({ kg, est, limpo, texto }); "limpo" = bateu com o formato "PESO: 12.34kg" sem dúvida.
   */
  static desinverter(rx) {
    const votos = new Map();
    let nos = 0;
    const imprimivel = b => b === 0x1B || (b >= 0x20 && b < 0x7F);
    const RE = /([+\- ]?)\s*((?:\d[\d ]{0,2})?\d[.,]\d{1,3})\s*kg/;
    // estado: [fase (0 ocioso, 1..8 dados, 9 stop), byte, texto]
    function alimenta(st, v) {
      const f = st[0], by = st[1], tx = st[2];
      if (f === 0) return v ? [1, 0, tx] : st;
      if (f <= 8) return [f + 1, by | ((1 - v) << (f - 1)), tx];
      if (v !== 0 || !imprimivel(by)) return null;
      return [0, 0, tx + String.fromCharCode(by)];
    }
    function anota(tx) {
      const m = tx.match(RE);
      if (!m) return;
      const kg = parseFloat(m[2].replace(/ /g, '').replace(',', '.')) * (m[1] === '-' ? -1 : 1);
      if (!isFinite(kg)) return;
      const k = kg.toFixed(3), a = votos.get(k) || { kg, n: 0, peso: 0, est: false, limpo: false, texto: tx };
      a.n++;
      const limpo = /PESO:\s?[+\- ]?[\d ]{0,3}\d[.,]\d{1,3}\s*kg/.test(tx);
      const forca = (limpo ? 16 : 0) + (/[+\- ][\d ]{2,3}\d?[.,]\d{1,3}kg|[+\- ]\d{1,2}[.,]\d{3}kg/.test(tx) ? 4 : 0) + (/PESO/.test(tx) ? 4 : 0) +
                    (/\x1bB \*|\x1bB  /.test(tx) ? 2 : 0) + (/kg\x1bE/.test(tx) ? 2 : 0) + Math.min(tx.length, 46) / 46;
      if (forca > a.peso) { a.peso = forca; a.texto = tx; a.limpo = limpo; a.est = /\*\s*PESO|\x1bB \*/.test(tx); }
      votos.set(k, a);
    }
    function dfs(i, st) {
      if (++nos > 400000) return;
      if (i === rx.length) { anota(st[2]); return; }
      let s = alimenta(st, 0);
      for (let k = 0; s && k < 8; k++) s = alimenta(s, (rx[i] >> k) & 1);
      if (!s) { anota(st[2]); return; }
      dfs(i + 1, s);                         // erro de quadro: o "stop" já é o início do próximo
      for (let k = 1; k <= 9; k++) { s = alimenta(s, 1); if (!s) break; dfs(i + 1, s); }
    }
    for (let ini = 0; ini < rx.length && ini < 40; ini++) { dfs(ini, [0, 0, '']); dfs(ini, [1, 0, '']); }
    return [...votos.values()].sort((a, b) => b.peso - a.peso || b.n - a.n);
  }
}

if (typeof module !== 'undefined') module.exports = { Balanca };
