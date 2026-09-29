// ohmypi dashboard. Talks to the gateway with the session cookie set by
// POST /auth/login; the token never lives in page storage.
function omp() {
  const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  return {
    THINKING,
    TABS: ['chat', 'session', 'config', 'skills', 'models', 'usage'],
    phase: 'loading',
    tokenInput: '', loginError: '', loggingIn: false,
    system: null, live: [], saved: [],
    drawer: false, tab: 'chat', toastMsg: '',
    showNew: false, ns: { cwd: '', model: '', thinking: '', approvalMode: 'yolo' }, spawning: false,
    active: null, info: null, items: [], byMsg: {}, byTool: {},
    ws: null, wsState: 'off', lastSeq: 0, retry: 0, retryTimer: null,
    draft: '', thinking: '',
    configRaw: '', configMsg: '', configErr: false, skills: [], modelsRaw: '', modelQuery: '',
    usageRaw: '', stateRows: [], statsRaw: '',

    async api(path, opts = {}) {
      const o = Object.assign({ credentials: 'same-origin' }, opts);
      o.headers = Object.assign({}, opts.headers || {});
      if (o.body !== undefined && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
      if (o.body !== undefined && !o.headers['Content-Type']) o.headers['Content-Type'] = 'application/json';
      const r = await fetch(path, o);
      let data = null;
      try { data = await r.json(); } catch (e) { /* non-JSON */ }
      if (r.status === 401 && path !== '/auth/login') { this.toLogin(); throw new Error('signed out'); }
      if (!r.ok) throw new Error((data && data.error) || r.statusText || ('HTTP ' + r.status));
      return data;
    },
    toast(m) { this.toastMsg = m; clearTimeout(this._tt); this._tt = setTimeout(() => { this.toastMsg = ''; }, 3500); },

    async init() {
      try { await this.api('/api/me'); this.enter(); } catch (e) { this.phase = 'login'; }
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.active && !this.ws && this.phase === 'app') { this.retry = 0; this.connect(); }
      });
    },
    toLogin() { this.closeWs(); this.phase = 'login'; },
    async login() {
      this.loggingIn = true; this.loginError = '';
      try {
        await this.api('/auth/login', { method: 'POST', body: { token: this.tokenInput.trim() } });
        this.tokenInput = ''; this.enter();
      } catch (e) { this.loginError = e.message; }
      this.loggingIn = false;
    },
    async logout() {
      try { await this.api('/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
      this.active = null; this.info = null; this.items = [];
      history.replaceState(null, '', location.pathname);
      this.toLogin();
    },
    enter() {
      this.phase = 'app';
      this.refresh();
      this.api('/api/system').then(s => { this.system = s; }).catch(() => {});
      if (!this._poll) {
        this._poll = setInterval(() => { if (this.phase === 'app' && !document.hidden) this.refresh(); }, 6000);
      }
      const want = new URLSearchParams(location.hash.slice(1)).get('s');
      if (want) this.open(want);
    },
    async refresh() {
      try {
        const d = await this.api('/api/sessions?limit=60');
        this.live = d.live; this.saved = d.saved;
        const mine = this.active && d.live.find(s => s.gwId === this.active);
        if (mine && this.info) Object.assign(this.info, { contextUsage: mine.contextUsage, model: mine.model,
          ompSessionName: mine.ompSessionName });
      } catch (e) { /* offline; next tick retries */ }
    },
    liveLabel(s) { return s.ompSessionName || s.cwd.split('/').filter(Boolean).pop() || s.cwd; },
    modelLabel(m) { return !m ? '?' : (typeof m === 'string' ? m : (m.id || '?')); },
    ctxLabel() {
      const c = this.info && this.info.contextUsage;
      return c && typeof c.percent === 'number' ? c.percent.toFixed(1) + '% ctx' : '';
    },
    ago(ts) {
      const s = Date.now() / 1000 - ts;
      if (s < 90) return 'just now';
      if (s < 5400) return Math.round(s / 60) + 'm ago';
      if (s < 129600) return Math.round(s / 3600) + 'h ago';
      return Math.round(s / 86400) + 'd ago';
    },

    // ---------------------------------------------------------------- sessions
    async spawn() {
      this.spawning = true;
      const body = { approvalMode: this.ns.approvalMode };
      for (const k of ['cwd', 'model', 'thinking']) if (this.ns[k].trim()) body[k] = this.ns[k].trim();
      try {
        const s = await this.api('/api/sessions', { method: 'POST', body });
        this.showNew = false; this.ns.model = '';
        await this.refresh(); this.open(s.gwId);
      } catch (e) { this.toast('Start failed: ' + e.message); }
      this.spawning = false;
    },
    async resume(f) {
      if (f.running) {
        const s = this.live.find(x => x.ompSessionFile === f.file);
        if (s) return this.open(s.gwId);
      }
      this.toast('Resuming…');
      try {
        const s = await this.api('/api/sessions', { method: 'POST', body: { resumeFrom: f.file } });
        await this.refresh(); this.open(s.gwId);
      } catch (e) { this.toast('Resume failed: ' + e.message); }
    },
    async stop() {
      if (!this.active || !confirm('Stop this session? The transcript stays in History.')) return;
      try { await this.api('/api/sessions/' + this.active, { method: 'DELETE' }); } catch (e) { /* already gone */ }
      this.closeWs(); this.active = null; this.info = null; this.items = [];
      history.replaceState(null, '', location.pathname); this.refresh();
    },
    async rename() {
      const name = prompt('Session name', (this.info && this.info.ompSessionName) || '');
      if (!name) return;
      try {
        await this.api('/api/sessions/' + this.active + '/name', { method: 'POST', body: { name } });
        if (this.info) this.info.ompSessionName = name;
        this.refresh();
      } catch (e) { this.toast(e.message); }
    },

    async open(id) {
      this.closeWs();
      this.active = id; this.tab = 'chat'; this.drawer = false;
      this.items = []; this.byMsg = {}; this.byTool = {};
      history.replaceState(null, '', '#s=' + id);
      try {
        this.info = await this.api('/api/sessions/' + id);
        this.thinking = this.info.thinkingLevel || '';
        // Snapshot the event cursor BEFORE reading history: anything newer
        // arrives over the socket, anything older is in the history.
        this.lastSeq = this.info.lastEventSeq || 0;
        const hist = await this.api('/api/sessions/' + id + '/messages');
        for (const m of hist.messages || []) this.addHistory(m);
      } catch (e) {
        this.toast('Could not open session: ' + e.message);
        this.active = null; this.info = null;
        history.replaceState(null, '', location.pathname);
        return;
      }
      this.scroll(true);
      this.retry = 0; this.connect();
    },

    // --------------------------------------------------------------- rendering
    blocks(content) {
      if (typeof content === 'string') return { text: content, thinking: '', calls: [] };
      let text = '', thinking = '';
      const calls = [];
      for (const c of content || []) {
        if (c.type === 'text') text += c.text || '';
        else if (c.type === 'thinking') thinking += c.thinking || '';
        else if (c.type === 'toolCall' || c.type === 'tool_use') calls.push(c);
      }
      return { text, thinking, calls };
    },
    argSummary(args) {
      if (!args) return '';
      if (typeof args === 'string') return args;
      return args.command || args.path || args.file_path || args.pattern || args.query || args.url
        || JSON.stringify(args);
    },
    resultText(r) {
      if (!r) return '';
      if (typeof r === 'string') return r;
      const c = r.content !== undefined ? r.content : r;
      if (Array.isArray(c)) return c.filter(x => x.type === 'text').map(x => x.text).join('\n');
      if (typeof c === 'string') return c;
      return JSON.stringify(r, null, 2);
    },
    addTool(id, name, args, intent) {
      const it = { kind: 'tool', id, name, args: this.argSummary(args), intent: intent || '',
                   output: '', error: false, done: false };
      const i = this.items.push(it) - 1;
      if (id) this.byTool[id] = i;
      return i;
    },
    addHistory(m) {
      if (m.role === 'user') {
        const b = this.blocks(m.content);
        if (b.text) this.items.push({ kind: 'user', text: b.text });
      } else if (m.role === 'assistant') {
        const b = this.blocks(m.content);
        if (b.text || b.thinking) this.items.push({ kind: 'assistant', text: b.text, thinking: b.thinking });
        for (const call of b.calls) this.addTool(call.id, call.name, call.arguments || call.input);
      } else if (m.role === 'toolResult') {
        let i = this.byTool[m.toolCallId];
        if (i === undefined) i = this.addTool(m.toolCallId, m.toolName, null);
        Object.assign(this.items[i], { output: this.resultText(m), error: !!m.isError, done: true });
      }
    },
    handle(e) {
      switch (e.type) {
        case 'auth_ok':
          if (e.session && this.info) Object.assign(this.info, e.session);
          return;
        case 'agent_start': if (this.info) this.info.isStreaming = true; return;
        case 'agent_end': if (this.info) this.info.isStreaming = false; this.refresh(); return;
        case 'message_start':
        case 'message_update':
        case 'message_end': {
          const m = e.message || (e.assistantMessageEvent && e.assistantMessageEvent.partial);
          if (!m) return;
          if (m.role === 'user') {
            // echo of our own send (already shown) or a prompt from another client
            const b = this.blocks(m.content);
            const key = e.messageId && ('u:' + e.messageId);
            if (e.type !== 'message_start' || !b.text || (key && this.byMsg[key] !== undefined)) return;
            if (key) this.byMsg[key] = -1;
            const pending = this.items.findIndex(x => x.kind === 'user' && x.pending && x.text === b.text);
            if (pending >= 0) { this.items[pending].pending = false; return; }
            this.items.push({ kind: 'user', text: b.text, note: 'other client' });
            this.scroll();
            return;
          }
          if (m.role !== 'assistant') return;
          const b = this.blocks(m.content);
          for (const call of b.calls) {
            if (call.id && this.byTool[call.id] === undefined) this.addTool(call.id, call.name, call.arguments || call.input);
          }
          if (!b.text && !b.thinking) return;
          const key = e.messageId;
          if (key && this.byMsg[key] !== undefined) {
            Object.assign(this.items[this.byMsg[key]], { text: b.text, thinking: b.thinking });
          } else {
            const i = this.items.push({ kind: 'assistant', text: b.text, thinking: b.thinking }) - 1;
            if (key) this.byMsg[key] = i;
          }
          this.scroll();
          return;
        }
        case 'tool_execution_start': {
          const i = this.byTool[e.toolCallId];
          if (i === undefined) this.addTool(e.toolCallId, e.toolName, e.args, e.intent);
          else if (e.intent) this.items[i].intent = e.intent;
          this.scroll();
          return;
        }
        case 'tool_execution_update':
        case 'tool_execution_end': {
          let i = this.byTool[e.toolCallId];
          if (i === undefined) i = this.addTool(e.toolCallId, e.toolName, e.args);
          const end = e.type === 'tool_execution_end';
          Object.assign(this.items[i], {
            output: this.resultText(end ? e.result : e.partialResult),
            error: end ? !!e.isError : this.items[i].error,
            done: end || this.items[i].done,
          });
          this.scroll();
          return;
        }
        case 'auto_compaction_start': this.items.push({ kind: 'notice', text: 'compacting context…' }); return;
        case 'auto_compaction_end': this.items.push({ kind: 'notice', text: 'context compacted' }); return;
        case 'rpc_response': if (!e.success) this.toast(e.command + ': ' + e.error); return;
        case 'ws_error': this.toast(e.error); return;
        default: return;
      }
    },
    scroll(force) {
      const el = document.getElementById('chatlog');
      if (!el) return;
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      if (force || near) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    },

    // --------------------------------------------------------------- websocket
    connect() {
      if (!this.active) return;
      const id = this.active;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(proto + '://' + location.host + '/omp-ws/' + id + '?after=' + this.lastSeq);
      this.ws = ws; this.wsState = 'connecting';
      ws.onmessage = (ev) => {
        let d;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d.seq > 0) {
          if (d.seq <= this.lastSeq) return;
          this.lastSeq = d.seq;
        }
        if (d.event && d.event.type === 'auth_ok') { this.wsState = 'live'; this.retry = 0; }
        this.handle(d.event || {});
      };
      ws.onclose = (ev) => {
        if (this.ws !== ws) return;
        this.ws = null; this.wsState = 'off';
        if (ev.code === 4401) { this.toLogin(); return; }
        if (ev.code === 4404) {
          this.toast('That session is no longer running');
          this.active = null; this.info = null;
          history.replaceState(null, '', location.pathname);
          this.refresh();
          return;
        }
        if (document.hidden) return;         // reconnect on visibilitychange
        const delay = Math.min(30000, 1000 * 2 ** this.retry++);
        this.wsState = 'retrying';
        this.retryTimer = setTimeout(() => { if (this.active === id && !this.ws) this.connect(); }, delay);
      };
    },
    closeWs() {
      clearTimeout(this.retryTimer);
      if (this.ws) { const w = this.ws; this.ws = null; try { w.close(); } catch (e) { /* ignore */ } }
      this.wsState = 'off';
    },

    // ------------------------------------------------------------------ actions
    get busy() { return !!(this.info && this.info.isStreaming); },
    async post(mode, note) {
      const message = this.draft.trim();
      if (!message || !this.active) return;
      this.draft = '';
      this.items.push({ kind: 'user', text: message, note, pending: true });
      this.scroll(true);
      try {
        await this.api('/api/sessions/' + this.active + '/prompt', { method: 'POST', body: { message, mode } });
      } catch (e) {
        this.items.push({ kind: 'notice', text: 'send failed: ' + e.message });
        this.draft = message;
      }
    },
    send() { return this.busy ? this.post('steer', 'steer') : this.post('prompt', ''); },
    queue() { return this.post('follow_up', 'queued'); },
    async abort() {
      try { await this.api('/api/sessions/' + this.active + '/abort', { method: 'POST' }); }
      catch (e) { this.toast(e.message); }
    },
    async compact() {
      this.toast('Compacting…');
      try { await this.api('/api/sessions/' + this.active + '/compact', { method: 'POST', body: {} }); this.toast('Compacted'); }
      catch (e) { this.toast(e.message); }
    },
    async setThinking() {
      if (!this.thinking) return;
      try {
        await this.api('/api/sessions/' + this.active + '/thinking', { method: 'POST', body: { level: this.thinking } });
        this.toast('Thinking: ' + this.thinking);
      } catch (e) { this.toast(e.message); }
    },
    keydown(ev) {
      // Enter sends on keyboards; on touch devices Enter is a newline.
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && window.matchMedia('(pointer: fine)').matches) {
        ev.preventDefault();
        this.send();
      }
    },

    // -------------------------------------------------------------------- panes
    go(t) {
      this.tab = t; this.drawer = false;
      if (t === 'session') this.loadState();
      if (t === 'config') this.loadConfig();
      if (t === 'skills' && !this.skills.length) {
        this.api('/api/skills').then(d => { this.skills = d.installed; }).catch(e => this.toast(e.message));
      }
      if (t === 'models' && !this.modelsRaw) this.loadModels();
      if (t === 'usage') {
        this.usageRaw = 'loading…';
        this.api('/api/usage').then(d => { this.usageRaw = d.raw || d.error || '(empty)'; })
          .catch(e => { this.usageRaw = e.message; });
      }
    },
    async loadState() {
      if (!this.active) return;
      try {
        const st = await this.api('/api/sessions/' + this.active + '/state');
        this.stateRows = Object.entries(st).filter(([k]) => k !== 'todoPhases')
          .map(([k, v]) => [k, v && typeof v === 'object' ? JSON.stringify(v) : String(v)]);
        const s = await this.api('/api/sessions/' + this.active + '/stats');
        this.statsRaw = JSON.stringify(s.data, null, 2);
      } catch (e) { this.toast(e.message); }
    },
    async loadConfig() {
      this.configMsg = ''; this.configErr = false;
      try { this.configRaw = (await this.api('/api/config')).raw; }
      catch (e) { this.configMsg = e.message; this.configErr = true; }
    },
    async saveConfig() {
      this.configMsg = 'validating with omp…'; this.configErr = false;
      try {
        const r = await this.api('/api/config', { method: 'PUT', body: this.configRaw,
                                                   headers: { 'Content-Type': 'text/yaml' } });
        this.configMsg = 'Saved. ' + r.note;
      } catch (e) { this.configMsg = e.message; this.configErr = true; }
    },
    async loadModels() {
      this.modelsRaw = 'loading…';
      const q = this.modelQuery ? '?q=' + encodeURIComponent(this.modelQuery) : '';
      try { this.modelsRaw = (await this.api('/api/models' + q)).raw; }
      catch (e) { this.modelsRaw = e.message; }
    },
  };
}
