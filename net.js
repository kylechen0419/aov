// 點對點連線（WebRTC，透過 PeerJS 免費的配對伺服器），不需要自己架後端
// 房主是中繼站：每位玩家只連到房主，房主再把訊息轉給其他人
// 玩家斷線時會自動重連；房主用玩家自帶的 key 認出是誰回來了
const PREFIX = 'wikirace-tw-1v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RETRY_DELAYS = [800, 1500, 2500, 4000, 5000];

function randomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export class Net {
  constructor() {
    this.peer = null;
    this.conns = new Map(); // 房主：連線 id → 連線
    this.alias = new Map(); // 房主：連線 id → 玩家 id
    this.hostConn = null; // 玩家：連到房主的連線
    this.isHost = false;
    this.code = null;
    this.closing = false;
    this.retrying = false;
    this.retryTimer = null;
    this.onMessage = () => {};
    this.onPeerJoin = () => {};
    this.onPeerLeave = () => {};
    this.onHostLost = () => {};
    this.onHostBack = () => {};
  }

  // ---------- 房主 ----------
  // 指定 code 時是接手別人的房間：舊房主剛放掉這個代碼，可能要等一下才能用
  createRoom(tries = 0, code = null) {
    return new Promise((resolve, reject) => {
      this.isHost = true;
      this.closing = false;
      this.code = code || randomCode();
      const peer = new Peer(PREFIX + this.code);
      peer.on('open', () => { this.peer = peer; resolve(this.code); });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id' && code && tries < 20 && !this.peer) {
          peer.destroy();
          setTimeout(() => this.createRoom(tries + 1, code).then(resolve, reject), 1000);
        } else if (err.type === 'unavailable-id' && !code && tries < 5 && !this.peer) {
          peer.destroy();
          this.createRoom(tries + 1).then(resolve, reject);
        } else if (!this.peer) {
          reject(new Error(`無法建立房間（${err.type}）`));
        } else {
          console.warn(err);
        }
      });
      peer.on('connection', (conn) => this.attachGuest(conn));
      // 跟配對伺服器斷線（例如手機切到背景）時自動重新註冊，玩家才能重新連進來
      peer.on('disconnected', () => this.keepHostAlive());
    });
  }

  keepHostAlive() {
    const peer = this.peer;
    if (!peer || peer.destroyed || this.closing) return;
    if (peer.disconnected) {
      try { peer.reconnect(); } catch { /* 下次再試 */ }
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.keepHostAlive(), 3000);
    }
  }

  attachGuest(conn) {
    const cid = conn.connectionId || conn.peer + Math.random();
    conn.on('open', () => { this.conns.set(cid, conn); this.onPeerJoin(cid); });
    conn.on('data', (msg) => {
      // 還沒報到（join）的連線沒有玩家身分：連線代號是對方自己填的，不能拿來當身分
      if (msg && typeof msg === 'object') this.onMessage(msg, this.alias.get(cid) ?? null, cid);
    });
    let gone = false;
    const leave = () => {
      if (gone) return;
      gone = true;
      if (this.conns.get(cid) !== conn) return;
      this.conns.delete(cid);
      const pid = this.alias.get(cid);
      this.alias.delete(cid);
      // 同一位玩家已經用新連線回來了，就不算離開
      if (pid && [...this.alias.values()].includes(pid)) return;
      this.onPeerLeave(pid || null, cid);
    };
    conn.on('close', leave);
    conn.on('error', leave);
  }

  // 房主：把連線綁到玩家 id；同一位玩家的舊連線會被關掉
  bind(cid, pid) {
    for (const [oldCid, oldPid] of this.alias) {
      if (oldPid === pid && oldCid !== cid) {
        this.alias.delete(oldCid);
        const old = this.conns.get(oldCid);
        this.conns.delete(oldCid);
        try { old?.close(); } catch { /* 忽略 */ }
      }
    }
    this.alias.set(cid, pid);
  }

  // 房主：把某位玩家請出去（送出通知後關掉他的連線）
  kick(pid, msg) {
    for (const [cid, p] of this.alias) {
      if (p !== pid) continue;
      const c = this.conns.get(cid);
      this.alias.delete(cid);
      if (!c) continue;
      try { c.send(msg); } catch { /* 忽略 */ }
      setTimeout(() => { this.conns.delete(cid); try { c.close(); } catch { /* 忽略 */ } }, 400);
    }
  }

  // 房主：拒絕某條連線
  reject(cid, msg) {
    const c = this.conns.get(cid);
    if (!c) return;
    try { c.send(msg); } catch { /* 忽略 */ }
    setTimeout(() => { this.conns.delete(cid); try { c.close(); } catch { /* 忽略 */ } }, 400);
  }

  // ---------- 玩家 ----------
  joinRoom(code) {
    this.isHost = false;
    this.closing = false;
    this.code = code.toUpperCase();
    return this.connectToHost(15000);
  }

  ensurePeer() {
    return new Promise((resolve, reject) => {
      const p = this.peer;
      if (p && !p.destroyed && p.open && !p.disconnected) { resolve(p); return; }
      if (p && !p.destroyed && p.disconnected) {
        const onOpen = () => { p.off?.('open', onOpen); resolve(p); };
        p.on('open', onOpen);
        try { p.reconnect(); } catch (e) { reject(e); }
        setTimeout(() => reject(new Error('reconnect-timeout')), 6000);
        return;
      }
      if (p) { try { p.destroy(); } catch { /* 忽略 */ } }
      const peer = new Peer();
      let done = false;
      peer.on('open', () => { if (!done) { done = true; this.peer = peer; resolve(peer); } });
      peer.on('error', (err) => {
        if (!done) { done = true; try { peer.destroy(); } catch { /* 忽略 */ } reject(err); }
        else if (err.type === 'peer-unavailable') this.onConnectError?.(err);
        else console.warn(err);
      });
      peer.on('disconnected', () => { /* 重連時會處理 */ });
      setTimeout(() => { if (!done) { done = true; reject(new Error('peer-timeout')); } }, 8000);
    });
  }

  connectToHost(timeout) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg) => { if (!settled) { settled = true; reject(new Error(msg)); } };
      const timer = setTimeout(() => fail('連線逾時，請確認房間代碼是否正確'), timeout);
      this.onConnectError = (err) => { if (err.type === 'peer-unavailable') { clearTimeout(timer); fail('找不到這個房間，請確認代碼'); } };
      this.ensurePeer().then((peer) => {
        const conn = peer.connect(PREFIX + this.code, { reliable: true });
        conn.on('open', () => {
          if (settled) { try { conn.close(); } catch { /* 忽略 */ } return; }
          settled = true;
          clearTimeout(timer);
          this.attachHost(conn);
          resolve();
        });
        conn.on('error', () => {});
      }, (err) => {
        clearTimeout(timer);
        fail(err.type === 'peer-unavailable' ? '找不到這個房間，請確認代碼' : `連線失敗（${err.type || err.message}）`);
      });
    });
  }

  attachHost(conn) {
    this.hostConn = conn;
    conn.on('data', (msg) => {
      if (msg && typeof msg === 'object') this.onMessage(msg, 'host');
    });
    let gone = false;
    const leave = () => {
      if (gone) return;
      gone = true;
      if (this.hostConn !== conn) return;
      this.hostConn = null;
      if (this.closing) return;
      this.onHostLost();
      this.startRetry();
    };
    conn.on('close', leave);
    conn.on('error', leave);
  }

  // 玩家：跟房主斷線後持續重試，直到連上或被呼叫 stopRetry()
  startRetry(attempt = 0) {
    if (this.retrying && attempt === 0) return;
    this.retrying = true;
    clearTimeout(this.retryTimer);
    const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
    this.retryTimer = setTimeout(() => {
      if (!this.retrying || this.closing) return;
      this.connectToHost(7000).then(() => {
        this.retrying = false;
        this.onHostBack();
      }, () => this.startRetry(attempt + 1));
    }, delay);
  }

  stopRetry() {
    this.retrying = false;
    clearTimeout(this.retryTimer);
  }

  // 回到畫面時立刻重試，不用等下一輪
  nudge() {
    if (this.isHost) { this.keepHostAlive(); return; }
    if (this.retrying) { this.stopRetry(); this.startRetry(0); }
  }

  // ---------- 共用 ----------
  // 房主：不指定 to 就廣播給所有人（可排除某人）；玩家：一律送給房主
  send(msg, to = null, except = null) {
    if (!this.isHost) {
      if (this.hostConn && this.hostConn.open) { try { this.hostConn.send(msg); } catch { /* 忽略 */ } }
      return;
    }
    for (const [cid, c] of this.conns) {
      const pid = this.alias.get(cid);
      if (!pid || !c.open) continue;
      if (to && pid !== to) continue;
      if (except && pid === except) continue;
      try { c.send(msg); } catch { /* 忽略 */ }
    }
  }

  get connected() {
    return this.isHost ? [...this.alias.keys()].some((cid) => this.conns.get(cid)?.open) : !!(this.hostConn && this.hostConn.open);
  }

  destroy() {
    this.closing = true;
    this.stopRetry();
    clearTimeout(this.retryTimer);
    for (const c of this.conns.values()) { try { c.close(); } catch { /* 忽略 */ } }
    if (this.hostConn) { try { this.hostConn.close(); } catch { /* 忽略 */ } }
    if (this.peer) { try { this.peer.destroy(); } catch { /* 忽略 */ } }
    this.peer = this.hostConn = null;
    this.conns.clear();
    this.alias.clear();
  }
}
