"use strict";

/* ====================== バージョン ====================== */
/* 表示用バージョンはここ一箇所。HTML側の ?v= クエリのみ別途更新する。 */
const APP_VERSION = "2.20";

/* ====================== 定数 ====================== */
const PREFIX = "ytsync-room-";
const POLL_MS = 500;                 // シーク検知ポーリング間隔
const POLL_SKIP_FACTOR = 3;          // この倍率を超える間隔はタイマー間引きとみなす
const HOST_SYNC_MS = 5000;           // ホストの時刻同期配信間隔
const SYNC_TOLERANCE = 1.5;          // 位置ズレの許容秒数(即時補正)
const TIMESYNC_TOLERANCE = 2.5;      // 定期同期での許容秒数
const MAX_LAG = 3;                   // 伝送遅延見積りの上限(秒)
const PING_MS = 8000;                // 生存確認pingの間隔
const PONG_TIMEOUT = 25000;          // この時間pongが無ければ死んだ接続とみなす
const PAUSE_DEBOUNCE_MS = 500;       // PAUSEDを「本物の一時停止」と判断するまでの待ち
const EXPECT_TTL_MS = 3000;          // 「自分で起こした状態変化」の有効期間
const JOIN_RETRIES = 3;              // 初回参加の再試行回数
const JOIN_TIMEOUT_MS = 10000;       // 初回参加1回あたりの接続待ち
const JOIN_RETRY_WAIT = 2000;        // 初回参加の再試行間隔
const RECONNECT_RETRIES = 10;        // ホスト再接続の試行回数
const RECONNECT_TIMEOUT_MS = 8000;   // ホスト再接続1回あたりの待ち
const BECOME_HOST_RETRIES = 5;       // 旧ホストID解放待ちの再試行回数
const BECOME_HOST_WAIT = 1500;       // ホスト引き継ぎ開始までの待ち
const BECOME_HOST_RETRY_WAIT = 2000; // ホストID再取得の間隔
const RECONNECT_WAIT = 3000;         // 新ホスト起動を待つ時間
const AUTOPLAY_CHECK_MS = 1500;      // 自動再生ブロック判定までの待ち
const REMOTE_AUTOPLAY_DELAY = 300;   // リモート起点再生のフォールバック開始待ち
const ERROR_SKIP_MS = 5000;          // 再生不可動画をスキップするまでの待ち
const TOAST_MS = 3000;               // トースト表示時間
const YT_LOAD_TIMEOUT = 15000;       // YouTube APIの読み込み待ち上限
const FETCH_TITLE_TIMEOUT = 6000;    // タイトル取得のタイムアウト
const MAX_QUEUE = 200;               // キュー最大件数(DoS対策)
const MAX_TITLE = 200;               // タイトル最大文字数
const MAX_ROSTER = 100;              // rosterの最大件数
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;

/* 保存キーはルーム単位にする(別ルームのキューが混ざるのを防ぐ) */
const QUEUE_PREFIX = "ytsync-queue:";
const PLAY_PREFIX = "ytsync-play:";
const HOST_KEY = "ytsync-host";      // このタブがどのルームのホストか(sessionStorage)

const RELAY_TYPES = new Set(["play", "pause", "seek", "load", "queue", "rate"]);
const KNOWN_TYPES = new Set([
  "ping", "pong", "state", "roster", "rate",
  "play", "pause", "seek", "load", "queue", "timesync"
]);

/* ====================== 状態 ====================== */
let peer = null;
let isHost = false;
let joined = false;          // 入室済みフラグ
let migrating = false;       // ホスト引き継ぎ/再接続中
let roomCode = "";
let connections = [];        // ホスト: 全ゲスト接続 / ゲスト: [ホスト接続]
let roster = [];             // ゲストpeer IDの参加順リスト(ホスト引き継ぎ順)
let queue = [];              // [{id, title}]
let currentIndex = -1;
let currentVideoId = null;   // プレーヤーに読み込み済みの動画ID
let player = null;
let playerReady = false;
let suppressRateUntil = 0;   // 速度変更イベントの送信抑制
let pendingRate = 1;         // プレーヤー準備前に受信した再生速度
let expectedState = null;    // リモート適用で起こる見込みの状態遷移(1回だけ消費)
let syncMismatchCount = 0;   // 再生状態の不一致が続いた回数(ヒステリシス用)
// 字幕機能(無効化・再利用のため保持)
// let captionsOn = false;      // 字幕表示状態(全員同期)
// let captionsApplied = false; // 現在の動画に字幕を適用済みか(動画ごとに1回だけ適用)
// let noCaptionNotified = false; // 字幕無し通知を出したか(動画ごとに1回)
let pendingRemoteLoad = null; // queue未着で空振りした遠隔loadの保留 {index, time}
let joinMuted = false;       // 途中参加時のミュート自動再生フラグ
let lastPolledTime = null;   // 前回ポーリング時の再生位置(秒)
let lastPollAt = null;       // 前回ポーリングの実時刻(performance.now)
let lastPlayerState = -1;
let pauseBroadcastTimer = null;
let joinAttempt = 0;
let joinTimer = null;
let joinConn = null;

const $ = (id) => document.getElementById(id);

/* ====================== ユーティリティ ====================== */
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), TOAST_MS);
}

/* ルームIDは暗号学的乱数で生成する(推測耐性) */
function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(6);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 6; i++) buf[i] = Math.floor(Math.random() * 0xffffffff);
  }
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[buf[i] % chars.length];
  return s;
}

function parseVideoId(url) {
  url = url.trim();
  const m = url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (VIDEO_ID_RE.test(url)) return url;
  return null;
}

/* 動画タイトルの取得。外部サービス依存なのでタイムアウトと型チェックを必ず行う。
   失敗時は動画IDをそのまま返す(表示が崩れないため)。 */
async function fetchTitle(videoId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TITLE_TIMEOUT);
  try {
    const r = await fetch(
      "https://noembed.com/embed?url=" +
        encodeURIComponent("https://www.youtube.com/watch?v=" + videoId),
      { signal: ctrl.signal }
    );
    if (!r.ok) return videoId;
    const j = await r.json();
    return (j && typeof j.title === "string" && j.title) ? j.title : videoId;
  } catch (e) {
    return videoId;
  } finally {
    clearTimeout(timer);
  }
}

/* クリップボードは非対応環境・権限拒否があるため必ずフォールバックする */
function copyText(text, okMsg) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    toast("このブラウザでは自動コピーできません: " + text);
    return;
  }
  navigator.clipboard.writeText(text)
    .then(() => toast(okMsg))
    .catch(() => toast("コピーできませんでした: " + text));
}

function suppressRate(ms = 1200) { suppressRateUntil = Date.now() + ms; }
function isRateSuppressed() { return Date.now() < suppressRateUntil; }

/* 「これから自分が起こす状態変化」を登録しておき、対応するイベントが来たら
   1回だけ消費する。時間ベースの一律抑制だと本物のユーザー操作まで握り潰すため、
   エコーだけを正確に捨てる方式にする。 */
function expectState(s) { expectedState = { s, until: Date.now() + EXPECT_TTL_MS }; }
function consumeExpected(s) {
  if (expectedState && expectedState.s === s && Date.now() < expectedState.until) {
    expectedState = null;
    return true;
  }
  return false;
}

/* 保留中のpause配信を取り消す(シーク中の一瞬の停止を誤配信しないため) */
function cancelPendingPause() {
  if (pauseBroadcastTimer) { clearTimeout(pauseBroadcastTimer); pauseBroadcastTimer = null; }
}

/* リモート指示による位置変更。ポーリングの基準も更新することで、
   「自分が動かされた位置ズレ」をユーザー操作のシークと誤検知して
   送り返してしまう(エコー)のを防ぐ。値は必ずクランプする。 */
function seekLocal(t) {
  const v = safeTime(t);
  player.seekTo(v, true);
  lastPolledTime = v;
  lastPollAt = performance.now();
}

function currentRate() {
  return (playerReady && player.getPlaybackRate) ? player.getPlaybackRate() : pendingRate;
}

/* 伝送遅延の見積り(秒): 中継分(msg.lag) + 最終ホップ(RTT/2)。負値と異常値を排除 */
function lagOf(msg, fromConn) {
  const hop = (fromConn && fromConn._rtt) ? fromConn._rtt / 2000 : 0;
  return Math.max(0, Math.min((msg.lag || 0) + hop, MAX_LAG));
}

/* ====================== 永続化 ====================== */
function queueKey() { return QUEUE_PREFIX + (roomCode || "default"); }
function playKey() { return PLAY_PREFIX + (roomCode || "default"); }

/* キューの保存はホストのみ。ゲストが他人のキューを自端末に残さないようにする */
function saveQueue() {
  if (!isHost) return;
  try { localStorage.setItem(queueKey(), JSON.stringify(queue)); } catch (e) {}
}

function savePlayback() {
  if (!isHost) return;
  try {
    const playing = playerReady && player.getPlayerState &&
                    player.getPlayerState() === YT.PlayerState.PLAYING;
    localStorage.setItem(playKey(), JSON.stringify({
      code: roomCode,
      index: currentIndex,
      videoId: currentVideoId,
      time: (playerReady && player.getCurrentTime) ? player.getCurrentTime() : 0,
      playing
    }));
  } catch (e) {}
}

/* ホスト復帰時に再生中だった動画と位置を復元する。復元できたら true */
function restorePlayback() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(playKey()) || "null"); } catch (e) { return false; }
  if (!s || s.code !== roomCode) return false;
  if (!Number.isInteger(s.index) || s.index < 0 || s.index >= queue.length) return false;
  const item = queue[s.index];
  if (!item || (s.videoId && item.id !== s.videoId)) return false;
  loadVideo(s.index, safeTime(s.time), s.playing !== false, false);
  return true;
}

// ===== 字幕機能(無効化・再利用のため保持) =====
// function applyCaptions(on) {
//   if (!playerReady) return false;
//   try {
//     if (on) {
//       player.loadModule("captions"); // HTML5プレーヤー
//       player.loadModule("cc");       // 旧プレーヤー互換
//       selectCaptionTrack(0);         // トラックを明示選択して確実に表示(ja優先)
//     } else {
//       try { player.setOption("captions", "track", {}); } catch (e) {}
//       try { player.setOption("cc", "track", {}); } catch (e) {}
//       player.unloadModule("captions");
//       player.unloadModule("cc");
//     }
//   } catch (e) { /* 非対応動画では無視 */ }
//   return true;
// }
//
// 字幕トラックを選択。loadModule直後は一覧が未取得のことがあるため数回リトライ。
// 一覧が空のまま(=字幕の無い動画)なら1回だけ通知する。
// function selectCaptionTrack(tries) {
//   if (!playerReady || !captionsOn) return;
//   let list = [];
//   try { list = player.getOption("captions", "tracklist") || []; } catch (e) {}
//   if (list.length) {
//     const track = list.find(t => t.languageCode === "ja") || list[0];
//     try { player.setOption("captions", "track", track); } catch (e) {}
//     try { player.setOption("cc", "track", track); } catch (e) {}
//   } else if (tries < 6) {
//     setTimeout(() => selectCaptionTrack(tries + 1), 400); // 一覧取得を待って再試行
//   } else if (!noCaptionNotified) {
//     noCaptionNotified = true;
//     toast("この動画には字幕がありません");
//   }
// }
//
// function setCaptions(on, fromRemote) {
//   captionsOn = on;
//   const btn = $("btnCC");
//   btn.textContent = "字幕: " + (on ? "ON" : "OFF");
//   btn.classList.toggle("ccon", on);
//   noCaptionNotified = false;          // 状態を変えたら通知判定をやり直す
//   const done = applyCaptions(on);     // playerReadyなら即適用
//   captionsApplied = on && done;       // 未readyなら後の最初のPLAYINGで適用される
//   if (!fromRemote) broadcast({ type: "captions", on });
// }

/* ====================== 受信データの検証 ====================== */
/* ルームに入れた相手は何でも送信できる。受信値は必ずここで正規化し、
   ホストが他ゲストへ中継するのも「正規化済みのコピー」にする
   (生メッセージを転送するとホストが攻撃の増幅器になるため)。 */
function isFiniteNum(v) { return typeof v === "number" && Number.isFinite(v); }

function safeTime(v) {
  return (isFiniteNum(v) && v >= 0) ? Math.min(v, 24 * 3600) : 0;
}

function safeRate(v) {
  return (isFiniteNum(v) && v >= 0.25 && v <= 2) ? v : 1;
}

/* 遅延は負値を弾く。負値を許すと seekTo(マイナス) を踏まされる */
function safeLag(v) {
  return (isFiniteNum(v) && v > 0) ? Math.min(v, MAX_LAG) : 0;
}

function sanitizeQueue(q) {
  if (!Array.isArray(q)) return null;
  const out = [];
  for (const it of q.slice(0, MAX_QUEUE)) {
    if (!it || typeof it !== "object") continue;
    if (typeof it.id !== "string" || !VIDEO_ID_RE.test(it.id)) continue;
    const title = (typeof it.title === "string" ? it.title : it.id).slice(0, MAX_TITLE);
    out.push({ id: it.id, title });
  }
  return out;
}

function safeIndex(v, len) {
  return (Number.isInteger(v) && v >= 0 && v < len) ? v : -1;
}

/* メッセージ全体を型ごとに作り直す。未知の型・壊れた構造は null で破棄。 */
function normalizeMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  if (typeof msg.type !== "string" || !KNOWN_TYPES.has(msg.type)) return null;
  const t = msg.type;
  switch (t) {
    case "ping":
    case "pong":
      return { type: t, t: isFiniteNum(msg.t) ? msg.t : Date.now() };
    case "play":
    case "pause":
    case "seek":
      return { type: t, time: safeTime(msg.time), lag: safeLag(msg.lag) };
    case "load":
      if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index >= MAX_QUEUE) return null;
      return { type: t, index: msg.index, time: safeTime(msg.time) };
    case "queue": {
      const q = sanitizeQueue(msg.queue);
      if (!q) return null;
      return { type: t, queue: q, index: Number.isInteger(msg.index) ? msg.index : -1 };
    }
    case "state": {
      const q = sanitizeQueue(msg.queue) || [];
      return {
        type: t, queue: q,
        index: Number.isInteger(msg.index) ? msg.index : -1,
        time: safeTime(msg.time), playing: !!msg.playing,
        rate: safeRate(msg.rate), lag: safeLag(msg.lag)
      };
    }
    case "timesync":
      return {
        type: t, time: safeTime(msg.time), playing: !!msg.playing,
        rate: safeRate(msg.rate), lag: safeLag(msg.lag)
      };
    case "rate":
      return { type: t, rate: safeRate(msg.rate) };
    case "roster":
      return {
        type: t,
        list: Array.isArray(msg.list)
          ? msg.list.filter(x => typeof x === "string").slice(0, MAX_ROSTER)
          : []
      };
  }
  return null;
}

/* ====================== 通信 ====================== */
function sendAll(msg, exclude) {
  for (const c of connections) {
    if (c !== exclude && c.open) c.send(msg);
  }
}

function broadcast(msg) { sendAll(msg); }

function fullState() {
  return {
    type: "state",
    queue, index: currentIndex,
    time: playerReady && player.getCurrentTime ? player.getCurrentTime() : 0,
    playing: playerReady && player.getPlayerState && player.getPlayerState() === YT.PlayerState.PLAYING,
    rate: currentRate()
    // captions: captionsOn  // 字幕機能(無効化・再利用のため保持)
  };
}

function broadcastRoster() {
  roster = [...new Set(connections.filter(c => c.open).map(c => c.peer))];
  sendAll({ type: "roster", list: roster });
}

function setupConnection(conn) {
  conn.on("open", () => {
    if (conn._dropped) { try { conn.close(); } catch (e) {} return; }

    /* 同じ相手の古い接続が残っていれば破棄する。
       PeerJSはclose/errorが発火しないことがあり、放置すると同一人物が
       複数人としてカウントされ続ける(ゾンビ接続)。 */
    for (const old of connections.filter(c => c !== conn && c.peer === conn.peer)) {
      try { old.close(); } catch (e) {}
      dropConnection(old, true);
    }

    connections.push(conn);
    updatePeerCount();
    conn._rtt = 0;
    conn._lastPong = Date.now();
    conn.send({ type: "ping", t: Date.now() });
    conn._pingTimer = setInterval(() => {
      if (conn._dropped) { clearInterval(conn._pingTimer); return; }
      if (Date.now() - conn._lastPong > PONG_TIMEOUT) {
        try { conn.close(); } catch (e) {}
        dropConnection(conn);      // closeが来ない死んだ接続をここで回収
        return;
      }
      if (conn.open) conn.send({ type: "ping", t: Date.now() });
    }, PING_MS);
    if (isHost) {
      conn.send(fullState());
      broadcastRoster();
      toast("参加者が接続しました");
    }
  });
  conn.on("data", (msg) => handleMessage(msg, conn));
  conn.on("close", () => dropConnection(conn));
  conn.on("error", () => dropConnection(conn));
}

function dropConnection(conn, replaced) {
  if (conn._dropped) return;
  conn._dropped = true;
  clearInterval(conn._pingTimer);
  connections = connections.filter(c => c !== conn);
  updatePeerCount();
  if (replaced) {
    if (isHost) broadcastRoster();
    return;
  }
  if (isHost) {
    toast("参加者が退出しました");
    broadcastRoster();
  } else {
    handleHostLost();
  }
}

/* Peer生成を一箇所に集約する。
   ・ハンドラの付け忘れを防ぐ
   ・差し替え後に古いPeerのイベントが新しいpeerを操作する事故を防ぐ(guard) */
function makePeer(id, handlers) {
  const p = new Peer(id, { debug: 1 });
  peer = p;
  const guard = (fn) => (...args) => { if (p !== peer) return; fn(...args); };
  p.on("open", guard(handlers.onOpen || (() => {})));
  p.on("connection", guard(handlers.onConnection || (() => {})));
  p.on("disconnected", guard(() => { try { p.reconnect(); } catch (e) {} }));
  p.on("error", guard(handlers.onError || (() => {})));
  return p;
}

function destroyPeer() {
  try { if (peer) peer.destroy(); } catch (e) {}
}

/* ====================== ホスト切断対策 ====================== */
function handleHostLost() {
  if (!joined || migrating || isHost) return;
  migrating = true;
  updatePeerCount();
  const successor = roster[0];
  if (successor && peer && successor === peer.id) {
    toast("ホストが切断しました。ホスト権限を引き継いでいます...");
    setTimeout(() => becomeHost(0), BECOME_HOST_WAIT);
  } else {
    toast("ホストが切断しました。再接続しています...");
    setTimeout(() => reconnectToHost(0), RECONNECT_WAIT);
  }
}

/* 既存の接続をすべて閉じ、pingタイマーも止める(引き継ぎ時の後始末) */
function teardownConnections() {
  for (const c of [...connections]) {
    try { c.close(); } catch (e) {}
    dropConnection(c, true);
  }
  connections = [];
}

function becomeHost(attempt = 0) {
  teardownConnections();
  destroyPeer();
  makePeer(PREFIX + roomCode, {
    onOpen: () => {
      isHost = true;
      sessionStorage.setItem(HOST_KEY, roomCode);
      migrating = false;
      connections = [];
      roster = [];
      updatePeerCount();
      startHostSync();
      toast("あなたが新しいホストになりました");
    },
    onConnection: (conn) => setupConnection(conn),
    onError: (err) => {
      if (err.type === "unavailable-id" && attempt < BECOME_HOST_RETRIES) {
        setTimeout(() => becomeHost(attempt + 1), BECOME_HOST_RETRY_WAIT);
        return;
      }
      /* ID取得の上限到達、またはネットワーク等その他のエラー。
         昇格をあきらめ、ゲストとして接続し直す(「再接続中」で固まらせない)。 */
      fallbackToGuest();
    }
  });
}

/* ホスト昇格を断念してゲストに戻る */
function fallbackToGuest() {
  sessionStorage.removeItem(HOST_KEY);
  isHost = false;
  migrating = true;
  stopHostSync();                 // 降格したので時刻同期配信は止める
  updatePeerCount();
  toast("ホストになれませんでした。参加者として接続し直しています...");
  destroyPeer();
  makePeer(undefined, {
    onOpen: () => reconnectToHost(0),
    onError: () => {
      migrating = false;
      updatePeerCount();
      toast("接続できませんでした。ページを再読み込みしてください。");
    }
  });
}

function reconnectToHost(attempt) {
  if (isHost || !migrating || !peer) return;
  if (attempt >= RECONNECT_RETRIES) {
    migrating = false;
    updatePeerCount();
    toast("再接続に失敗しました。ページを再読み込みしてください。");
    return;
  }
  const conn = peer.connect(PREFIX + roomCode, { reliable: true });
  const timer = setTimeout(() => {
    try { conn.close(); } catch (e) {}
    dropConnection(conn, true);
    reconnectToHost(attempt + 1);
  }, RECONNECT_TIMEOUT_MS);
  conn.on("open", () => {
    clearTimeout(timer);
    migrating = false;
    toast("再接続しました");
  });
  setupConnection(conn);
}

/* ====================== メッセージ処理 ====================== */
function handleMessage(raw, fromConn) {
  const msg = normalizeMessage(raw);
  if (!msg) return;                       // 不正・未知のメッセージは破棄

  if (msg.type === "ping") {
    if (fromConn && fromConn.open) fromConn.send({ type: "pong", t: msg.t });
    return;
  }
  if (msg.type === "pong") {
    if (fromConn) {
      fromConn._rtt = Date.now() - msg.t;
      fromConn._lastPong = Date.now();    // 生存確認(ハートビート)
    }
    return;
  }

  /* ホストは正規化済みのコピーを他ゲストへ中継する。
     中継用に遅延を足したコピーを作り、自分の処理には元の値を使う
     (同じオブジェクトを書き換えるとホストだけ遅延を二重加算してしまう)。 */
  if (isHost && RELAY_TYPES.has(msg.type)) {
    const relayed = (msg.type === "play" || msg.type === "seek") && fromConn && fromConn._rtt
      ? Object.assign({}, msg, { lag: safeLag((msg.lag || 0) + fromConn._rtt / 2000) })
      : msg;
    sendAll(relayed, fromConn);
  }

  switch (msg.type) {
    case "state": {
      queue = msg.queue;
      currentIndex = safeIndex(msg.index, queue.length);
      pendingRate = msg.rate;
      // if (typeof msg.captions === "boolean") setCaptions(msg.captions, true); // 字幕機能(無効化・再利用のため保持)
      renderQueue();
      saveQueue();
      const item = currentIndex >= 0 ? queue[currentIndex] : null;
      if (!item) break;
      const t = msg.time + (msg.playing ? lagOf(msg, fromConn) * pendingRate : 0);
      if (player && playerReady && currentVideoId === item.id) {
        /* 同じ動画なら再読み込みせず位置・状態だけ合わせる(ホスト交代時の途切れ防止) */
        cancelPendingPause();
        if (Math.abs(player.getCurrentTime() - t) > SYNC_TOLERANCE) seekLocal(t);
        if (msg.playing) {
          expectState(YT.PlayerState.PLAYING);
          player.playVideo();
        } else {
          expectState(YT.PlayerState.PAUSED);
          player.pauseVideo();
        }
        suppressRate();
        player.setPlaybackRate(pendingRate);
      } else {
        if (msg.playing && !player) joinMuted = true; // 途中参加: ミュートで自動再生
        loadVideo(currentIndex, t, msg.playing, true);
      }
      break;
    }
    case "roster":
      roster = msg.list;
      break;
    case "rate":
      pendingRate = msg.rate;
      if (playerReady) { suppressRate(); player.setPlaybackRate(msg.rate); }
      break;
    // 字幕機能(無効化・再利用のため保持)
    // case "captions":
    //   setCaptions(msg.on, true);
    //   break;
    case "play": {
      if (!playerReady) break;
      cancelPendingPause();
      const t = msg.time + lagOf(msg, fromConn) * currentRate();
      if (Math.abs(player.getCurrentTime() - t) > SYNC_TOLERANCE) seekLocal(t);
      expectState(YT.PlayerState.PLAYING);
      player.playVideo();
      break;
    }
    case "pause": {
      if (!playerReady) break;
      cancelPendingPause();
      expectState(YT.PlayerState.PAUSED);
      player.pauseVideo();
      if (Math.abs(player.getCurrentTime() - msg.time) > SYNC_TOLERANCE) seekLocal(msg.time);
      break;
    }
    case "seek": {
      if (!playerReady) break;
      const playing = player.getPlayerState() === YT.PlayerState.PLAYING;
      seekLocal(msg.time + (playing ? lagOf(msg, fromConn) * currentRate() : 0));
      break;
    }
    case "load":
      /* currentIndex は loadVideo 側で「実在する index のときだけ」更新する。
         キュー未着なら pendingRemoteLoad に退避される。 */
      loadVideo(msg.index, msg.time, true, true);
      break;
    case "queue": {
      queue = msg.queue;
      currentIndex = safeIndex(msg.index, queue.length);
      renderQueue();
      saveQueue();
      applyPendingRemoteLoad();   // 先行していた load の保留があればここで適用
      break;
    }
    case "timesync": {            // ホストからの定期同期
      if (!playerReady || isHost) break;
      if (Math.abs(currentRate() - msg.rate) > 0.01) {
        pendingRate = msg.rate;
        suppressRate();
        player.setPlaybackRate(msg.rate);
      }
      const st = player.getPlayerState();
      const localPlaying = st === YT.PlayerState.PLAYING;
      const t = msg.time + lagOf(msg, fromConn) * currentRate();

      if (st === YT.PlayerState.BUFFERING) break;   // 読込中は判定しない

      if (msg.playing !== localPlaying) {
        /* 再生/停止そのものがズレている。取りこぼしや自動再生ブロックで
           永久にデシンクしないよう、ここで状態も収束させる。
           一時的な行き違いで往復しないよう2回連続でのみ適用(ヒステリシス)。 */
        syncMismatchCount++;
        if (syncMismatchCount >= 2) {
          syncMismatchCount = 0;
          if (msg.playing) {
            seekLocal(t);
            expectState(YT.PlayerState.PLAYING);
            player.playVideo();
          } else {
            expectState(YT.PlayerState.PAUSED);
            player.pauseVideo();
            seekLocal(t);
          }
        }
      } else {
        syncMismatchCount = 0;
        if (msg.playing && Math.abs(player.getCurrentTime() - t) > TIMESYNC_TOLERANCE) {
          seekLocal(t);
        }
      }
      break;
    }
  }
}

function updatePeerCount() {
  const n = new Set(connections.filter(c => c.open).map(c => c.peer)).size;
  $("peerCount").textContent = isHost
    ? `参加者: ${n}人`
    : (n > 0 ? "接続中" : (migrating ? "再接続中..." : "切断"));
}

/* ====================== 初回参加(リトライ付き) ====================== */
/* 公開シグナリングサーバーの一時的な不調や、ホストのID登録が終わる前に
   接続しにいくレースで失敗することがあるため、初回参加も自動で再試行する。 */
function cancelJoinAttempt() {
  if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
  if (joinConn) {
    try { joinConn.close(); } catch (e) {}
    dropConnection(joinConn, true);
    joinConn = null;
  }
}

function tryJoin(code) {
  if (joined || !peer) return;
  cancelJoinAttempt();
  const conn = peer.connect(PREFIX + code, { reliable: true });
  joinConn = conn;
  joinTimer = setTimeout(() => {
    joinTimer = null;
    if (joined || conn.open) return;
    cancelJoinAttempt();
    retryJoinOrFail(code);
  }, JOIN_TIMEOUT_MS);
  conn.on("open", () => {
    if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
    joinConn = null;
    joinAttempt = 0;
    enterRoom();
  });
  setupConnection(conn);
}

function retryJoinOrFail(code) {
  if (joined) return;
  if (joinAttempt < JOIN_RETRIES) {
    joinAttempt++;
    $("lobbyStatus").textContent =
      "接続できませんでした。再試行しています... (" + joinAttempt + "/" + JOIN_RETRIES + ")";
    setTimeout(() => { if (!joined && peer) tryJoin(code); }, JOIN_RETRY_WAIT);
    return;
  }
  $("lobbyStatus").textContent =
    "ルームに接続できませんでした。IDを確認するか、時間をおいて再度お試しください。";
  $("btnCreate").disabled = false;
  $("btnJoin").disabled = false;
  destroyPeer();
  peer = null;
  joinAttempt = 0;
}

function initPeer(code, asHost, recovering = false, attempt = 0) {
  $("lobbyStatus").textContent = recovering ? "ルームに復帰しています..." : "接続中...";
  $("btnCreate").disabled = true;
  $("btnJoin").disabled = true;

  makePeer(asHost ? PREFIX + code : undefined, {
    onOpen: () => {
      roomCode = code;
      isHost = asHost;
      if (asHost) {
        enterRoom();
      } else {
        joinAttempt = 0;
        tryJoin(code);
      }
    },
    onConnection: (conn) => { if (isHost) setupConnection(conn); },
    onError: (err) => {
      if (joined) return;  // 入室後のエラーは再接続処理に任せる
      if (err.type === "unavailable-id") {
        if (recovering) {
          /* ホスト復帰中にIDが未解放/既に引き継ぎ済み。数回は解放待ちで再試行し、
             それでもダメなら他者が引き継いだとみなしてゲスト参加へ切り替える。 */
          destroyPeer();
          peer = null;
          if (attempt < 3) {
            setTimeout(() => initPeer(code, true, true, attempt + 1), BECOME_HOST_WAIT);
          } else {
            sessionStorage.removeItem(HOST_KEY);
            initPeer(code, false);
          }
          return;
        }
        $("lobbyStatus").textContent = "このルームIDは使用中です。再度作成してください。";
      } else if (err.type === "peer-unavailable") {
        /* ホストがまだ登録され切っていない等、一時的に見つからないだけのことが
           あるため、即エラーにせず再試行する。 */
        cancelJoinAttempt();
        retryJoinOrFail(code);
        return;
      } else {
        $("lobbyStatus").textContent = "接続エラー: " + err.type;
      }
      $("btnCreate").disabled = false;
      $("btnJoin").disabled = false;
    }
  });
}

function enterRoom() {
  joined = true;
  $("lobby").style.display = "none";
  $("main").style.display = "block";
  $("roomBadge").textContent = roomCode;
  updatePeerCount();
  history.replaceState(null, "", "#" + roomCode);
  if (isHost) sessionStorage.setItem(HOST_KEY, roomCode);

  /* 画面が切り替わったので、支援技術の読み上げ位置を見出しへ移す */
  const heading = $("mainTitle");
  if (heading) heading.focus();

  /* ホストのみ: 前回の再生リストを復元(+リロード復帰時は再生位置も再開) */
  if (isHost) {
    if (queue.length === 0) {
      try {
        const saved = sanitizeQueue(JSON.parse(localStorage.getItem(queueKey()) || "[]"));
        if (saved && saved.length) { queue = saved; renderQueue(); }
      } catch (e) {}
    }
    const resumed = restorePlayback();
    if (queue.length) {
      toast(resumed
        ? "前回の状態から復帰しました"
        : "前回の再生リストを復元しました(タイトルをクリックで再生)");
    }
  }
}

$("btnCreate").onclick = () => initPeer(genCode(), true);
$("btnJoin").onclick = () => {
  const code = $("joinInput").value.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(code)) {
    $("lobbyStatus").textContent = "6桁のルームIDを入力してください";
    return;
  }
  initPeer(code, false);
};
$("joinInput").addEventListener("keydown", e => { if (e.key === "Enter") $("btnJoin").click(); });

$("roomBadge").onclick = () => copyText(roomCode, "ルームIDをコピーしました");
$("btnInvite").onclick = () => {
  const url = location.origin + location.pathname + "#" + roomCode;
  copyText(url, "招待リンクをコピーしました: " + url);
};

// URLハッシュにルームIDがあれば自動で参加し、直接メイン画面へ遷移する
// (接続に失敗した場合はロビーにエラーが表示され、入力欄のIDで手動再試行できる)
(function autoJoinFromHash() {
  const code = location.hash.slice(1).toUpperCase();
  if (ROOM_CODE_RE.test(code)) {
    $("joinInput").value = code;
    const wasHost = sessionStorage.getItem(HOST_KEY) === code;
    initPeer(code, wasHost, wasHost);
  }
})();

/* ====================== YouTube プレーヤー ====================== */
let ytApiReady = false;
let pendingLoad = null; // [index, time, autoplay]

function onYouTubeIframeAPIReady() {
  ytApiReady = true;
  if (pendingLoad) { createPlayer(...pendingLoad); pendingLoad = null; }
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

/* YouTube APIの読み込み失敗を黙って放置すると「追加しても何も起きない」
   無言の故障になるため、エラーとタイムアウトの両方で通知する。 */
(function loadYT() {
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  tag.onerror = () => {
    toast("YouTubeプレーヤーを読み込めませんでした。通信環境や拡張機能をご確認ください。");
  };
  document.head.appendChild(tag);
  setTimeout(() => {
    if (!ytApiReady) {
      toast("YouTubeプレーヤーの読み込みに時間がかかっています。通信環境をご確認ください。");
    }
  }, YT_LOAD_TIMEOUT);
})();

/* 自動再生フォールバック:
   リモート(load/state)起点の再生は呼び出しにユーザー操作が含まれず、
   ブラウザの自動再生制限で音声付き再生がブロックされることがある。
   まず音声付きで再生を試み、一定時間たっても再生もバッファリングも
   していなければ「ブロックされた」と判断してミュート再生に切り替える。 */
function tryAutoplay(attempt = 0) {
  if (!playerReady || joinMuted) return;
  player.playVideo();
  clearTimeout(tryAutoplay._timer);
  tryAutoplay._timer = setTimeout(() => {
    if (!playerReady || joinMuted) return;
    const st = player.getPlayerState();
    if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING) return;
    if (st === YT.PlayerState.UNSTARTED && attempt < 2) {
      tryAutoplay(attempt + 1);
      return;
    }
    player.mute();
    $("btnUnmute").hidden = false;
    player.playVideo();
  }, AUTOPLAY_CHECK_MS);
}

function createPlayer(index, startTime, autoplay) {
  const item = queue[index];
  if (!item) return;
  $("playerEmpty").style.display = "none";
  currentVideoId = item.id;
  // captionsApplied = false; noCaptionNotified = false; // 字幕機能(無効化・再利用のため保持)
  player = new YT.Player("player", {
    videoId: item.id,
    playerVars: { autoplay: autoplay ? 1 : 0, start: Math.floor(startTime), playsinline: 1 },
    events: {
      onReady: () => {
        playerReady = true;
        lastPolledTime = null;
        lastPollAt = null;
        if (Math.abs(pendingRate - 1) > 0.01) { suppressRate(); player.setPlaybackRate(pendingRate); }
        // if (captionsOn) { applyCaptions(true); captionsApplied = true; } // 字幕機能(無効化・再利用のため保持)
        if (joinMuted) {
          player.mute();
          $("btnUnmute").hidden = false;
        }
        startPolling();
        if (autoplay) {
          if (joinMuted) player.playVideo();
          else tryAutoplay();
        }
      },
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
      onPlaybackRateChange: (e) => {
        pendingRate = e.data;
        if (!isRateSuppressed()) broadcast({ type: "rate", rate: e.data });
      }
    }
  });
  $("nowTitle").textContent = "▶ " + (item.title || item.id);
}

$("btnUnmute").onclick = () => {
  if (playerReady) player.unMute();
  $("btnUnmute").hidden = true;
  joinMuted = false;
};

function loadVideo(index, startTime = 0, autoplay = true, fromRemote = false) {
  const item = queue[index];
  if (!item) {
    /* 実在しない index では currentIndex を汚さない。
       遠隔からの指示ならキュー未着の可能性があるので保留しておく。 */
    if (fromRemote) pendingRemoteLoad = { index, time: startTime };
    renderQueue();
    return;
  }
  currentIndex = index;
  renderQueue();
  if (!player) {
    if (!ytApiReady) { pendingLoad = [index, startTime, autoplay]; return; }
    createPlayer(index, startTime, autoplay);
  } else {
    lastPolledTime = null;
    lastPollAt = null;
    currentVideoId = item.id;
    // captionsApplied = false; noCaptionNotified = false; // 字幕機能(無効化・再利用のため保持)
    if (autoplay) {
      expectState(YT.PlayerState.PLAYING);
      player.loadVideoById(item.id, startTime);
      if (fromRemote) setTimeout(() => tryAutoplay(), REMOTE_AUTOPLAY_DELAY);
    } else {
      player.cueVideoById(item.id, startTime);
    }
    $("playerEmpty").style.display = "none";
    $("nowTitle").textContent = "▶ " + (item.title || item.id);
  }
  savePlayback();
}

/* 再生対象が無くなったときの後片付け(キューが空/最後まで再生し終えた等) */
function stopPlayback() {
  currentIndex = -1;
  currentVideoId = null;
  pendingRemoteLoad = null;
  if (playerReady) { try { player.stopVideo(); } catch (e) {} }
  $("nowTitle").textContent = "";
  $("playerEmpty").style.display = "";
  renderQueue();
  savePlayback();
}

/* 遠隔の load がキュー未着で空振りした場合、queue到着後に適用する */
function applyPendingRemoteLoad() {
  if (!pendingRemoteLoad) return;
  const item = queue[pendingRemoteLoad.index];
  if (!item) return;
  const p = pendingRemoteLoad;
  pendingRemoteLoad = null;
  if (player && currentVideoId === item.id) return;
  loadVideo(p.index, p.time || 0, true, true);
}

/* 再生不可動画のエラー処理 */
const YT_ERRORS = {
  2:   "無効な動画IDです",
  5:   "このプレーヤーでは再生できない動画です",
  100: "動画が見つかりません(削除済みまたは非公開)",
  101: "埋め込み再生が許可されていない動画です",
  150: "埋め込み再生が許可されていない動画です"
};

function onPlayerError(e) {
  const reason = YT_ERRORS[e.data] || "この動画は再生できません";
  if (!isHost) {
    // ゲスト側のみのエラー(地域制限など)では全体をスキップしない
    toast(reason + "(地域制限の可能性があります)");
    return;
  }
  if (currentIndex < 0 || currentIndex >= queue.length) { toast(reason); return; }

  const hasNext = currentIndex < queue.length - 1;
  toast(reason + (hasNext ? " — 5秒後に次の動画へスキップします" : " — 5秒後にキューから削除します"));
  const erroredIndex = currentIndex;
  clearTimeout(onPlayerError._timer);
  onPlayerError._timer = setTimeout(() => {
    if (currentIndex !== erroredIndex) return;  // 既に手動で切替済みなら何もしない
    /* 再生できない動画はキューから除去する。残すと戻った時に同じエラーを踏む。 */
    queue.splice(erroredIndex, 1);
    saveQueue();
    if (erroredIndex < queue.length) {
      broadcast({ type: "queue", queue, index: erroredIndex });
      loadVideo(erroredIndex, 0, true);
      broadcast({ type: "load", index: erroredIndex, time: 0 });
    } else {
      stopPlayback();
      broadcast({ type: "queue", queue, index: -1 });
    }
  }, ERROR_SKIP_MS);
}

function onPlayerStateChange(e) {
  const s = e.data;
  if (s === YT.PlayerState.ENDED) {
    // 再生が終わった動画はキューから削除し、次の動画へ(ホストのみが進行役)
    if (isHost && currentIndex >= 0 && currentIndex < queue.length) {
      const finished = currentIndex;
      queue.splice(finished, 1);
      saveQueue();
      if (finished < queue.length) {
        broadcast({ type: "queue", queue, index: finished });
        loadVideo(finished, 0, true);
        broadcast({ type: "load", index: finished, time: 0 });
      } else {
        stopPlayback();                 // 最後の動画 → 空表示に戻す
        broadcast({ type: "queue", queue, index: -1 });
      }
    }
    lastPlayerState = s;
    return;
  }
  // 字幕機能(無効化・再利用のため保持)
  // if (s === YT.PlayerState.PLAYING && captionsOn && !captionsApplied) {
  //   applyCaptions(true);
  //   captionsApplied = true;
  // }
  if (s === YT.PlayerState.PLAYING || s === YT.PlayerState.BUFFERING) cancelPendingPause();

  if (s === YT.PlayerState.PLAYING && lastPlayerState !== YT.PlayerState.PLAYING) {
    /* 自分がリモート指示で起こした再生(エコー)なら送り返さない。
       それ以外=ユーザー操作なので、抑制窓に関係なく必ず配信する。 */
    if (!consumeExpected(YT.PlayerState.PLAYING)) {
      broadcast({ type: "play", time: player.getCurrentTime() });
    }
  } else if (s === YT.PlayerState.PAUSED) {
    if (consumeExpected(YT.PlayerState.PAUSED)) {
      cancelPendingPause();
    } else {
      /* シークバー操作中、YouTubeは PLAYING→PAUSED→BUFFERING→PLAYING と遷移する。
         この一瞬のPAUSEDをそのまま配信すると全員が停止してしまうため、少し待って
         まだ停止していたときだけ「本物の一時停止」として配信する(デバウンス)。 */
      cancelPendingPause();
      pauseBroadcastTimer = setTimeout(() => {
        pauseBroadcastTimer = null;
        if (!playerReady) return;
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) return;
        broadcast({ type: "pause", time: player.getCurrentTime() });
      }, PAUSE_DEBOUNCE_MS);
    }
  }
  if (s === YT.PlayerState.PLAYING || s === YT.PlayerState.PAUSED) lastPlayerState = s;
}

/* ====================== タイマー ====================== */
let pollTimer = null;
let hostSyncTimer = null;

function startPolling() {
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (!playerReady || !player.getCurrentTime) return;
      const now = performance.now();
      const t = player.getCurrentTime();
      const state = player.getPlayerState();
      const elapsed = (lastPollAt === null) ? 0 : (now - lastPollAt) / 1000;
      lastPollAt = now;

      if (lastPolledTime !== null) {
        /* バックグラウンドタブやスリープでタイマーが間引かれると、固定間隔を
           前提にした期待値から大きく外れ、誰も操作していないのに「シークされた」
           と誤検知して全員を巻き込む。実経過で計算し、間引き時は判定を見送る。 */
        if (elapsed > (POLL_MS / 1000) * POLL_SKIP_FACTOR) {
          lastPolledTime = t;
          return;
        }
        const drift = state === YT.PlayerState.PLAYING ? elapsed * currentRate() : 0;
        const expected = lastPolledTime + drift;
        if (Math.abs(t - expected) > SYNC_TOLERANCE) {
          broadcast({ type: "seek", time: t });
        }
      }
      lastPolledTime = t;
    }, POLL_MS);
  }
  if (isHost) startHostSync();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/* ホスト: 一定間隔で時刻同期を配信(ホスト引き継ぎ時にも呼ばれる) */
function startHostSync() {
  if (hostSyncTimer) return;
  hostSyncTimer = setInterval(() => {
    if (!isHost || !playerReady) return;
    savePlayback();                       // 再生位置を保存(単独利用時も実行)
    if (connections.length === 0) return;
    broadcast({
      type: "timesync",
      time: player.getCurrentTime(),
      playing: player.getPlayerState() === YT.PlayerState.PLAYING,
      rate: currentRate()
    });
  }, HOST_SYNC_MS);
}

function stopHostSync() {
  if (hostSyncTimer) { clearInterval(hostSyncTimer); hostSyncTimer = null; }
}

/* ====================== キュー ====================== */
/* 並び替えはドラッグだけでなくキーボード(Alt+↑/↓)でも行えるようにする */
function moveItem(from, to) {
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
  const playingItem = currentIndex >= 0 ? queue[currentIndex] : null;
  const [moved] = queue.splice(from, 1);
  queue.splice(to, 0, moved);
  currentIndex = playingItem ? queue.indexOf(playingItem) : -1;
  renderQueue();
  saveQueue();
  broadcast({ type: "queue", queue, index: currentIndex });
  const btn = document.querySelector('#queueList li[data-index="' + to + '"] .qtitle');
  if (btn) btn.focus();            // 移動後もフォーカスを追従させる
}

function removeItem(i) {
  const wasCurrent = (i === currentIndex);
  queue.splice(i, 1);
  if (i < currentIndex) currentIndex--;
  saveQueue();
  if (!wasCurrent) {
    renderQueue();
    broadcast({ type: "queue", queue, index: currentIndex });
    return;
  }
  /* 再生中の動画を消した場合は、表示と実際の再生がずれないよう
     次の動画へ進める(無ければ停止して空表示に戻す)。 */
  if (queue.length === 0) {
    stopPlayback();
    broadcast({ type: "queue", queue, index: -1 });
    return;
  }
  const next = Math.min(i, queue.length - 1);
  broadcast({ type: "queue", queue, index: next });
  loadVideo(next, 0, true);
  broadcast({ type: "load", index: next, time: 0 });
}

function clearDragMarks() {
  document.querySelectorAll("#queueList li.dragover")
    .forEach(el => el.classList.remove("dragover"));
}

function renderQueue() {
  const ul = $("queueList");
  ul.innerHTML = "";
  $("queueEmpty").style.display = queue.length ? "none" : "block";
  const bn = $("btnNext");
  if (bn) bn.disabled = (currentIndex < 0 || currentIndex >= queue.length - 1);

  queue.forEach((item, i) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.index = i;
    if (i === currentIndex) li.classList.add("playing");

    const grip = document.createElement("span");
    grip.className = "grip";
    grip.textContent = "⠿";
    grip.setAttribute("aria-hidden", "true");

    const thumb = document.createElement("img");
    thumb.className = "thumb";
    thumb.src = "https://img.youtube.com/vi/" + item.id + "/default.jpg";
    thumb.alt = "";
    thumb.loading = "lazy";
    thumb.draggable = false;

    const label = item.title || item.id;
    const title = document.createElement("button");
    title.className = "qtitle";
    title.type = "button";
    title.textContent = (i === currentIndex ? "▶ " : "") + label;
    title.title = "クリックで再生 / Alt+↑↓ で並び替え";
    title.setAttribute("aria-label", label + " を再生");
    title.onclick = () => {
      loadVideo(i, 0, true);
      broadcast({ type: "load", index: i, time: 0 });
    };
    title.addEventListener("keydown", (e) => {
      if (!e.altKey) return;
      if (e.key === "ArrowUp" && i > 0) { e.preventDefault(); moveItem(i, i - 1); }
      else if (e.key === "ArrowDown" && i < queue.length - 1) { e.preventDefault(); moveItem(i, i + 1); }
    });

    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "✕";
    del.title = "削除";
    del.setAttribute("aria-label", label + " を削除");
    del.onclick = () => removeItem(i);

    li.append(grip, thumb, title, del);

    /* ドラッグ&ドロップ並び替え */
    li.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(i));
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("dragover"); });
    li.addEventListener("dragleave", () => li.classList.remove("dragover"));
    li.addEventListener("dragend", clearDragMarks);   // 中断時に枠線が残らないように
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      clearDragMarks();
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (Number.isNaN(from)) return;
      moveItem(from, i);
    });

    ul.appendChild(li);
  });
}

async function addUrl() {
  const input = $("urlInput");
  const id = parseVideoId(input.value);
  if (!id) { toast("有効なYouTube動画URLを入力してください"); return; }
  if (queue.length >= MAX_QUEUE) { toast("キューの上限(" + MAX_QUEUE + "件)に達しています"); return; }
  input.value = "";

  const btn = $("btnAdd");
  btn.disabled = true;
  try {
    const item = { id, title: id };
    queue.push(item);
    renderQueue();
    saveQueue();
    const wasEmpty = queue.length === 1 && currentIndex === -1;
    /* 先にキュー内容を配信する。これより前に load を送ると、空キューのゲストが
       queue[index] を解決できず空振りするため、必ず queue を先に届ける。 */
    broadcast({ type: "queue", queue, index: wasEmpty ? 0 : currentIndex });
    if (wasEmpty) {
      loadVideo(0, 0, true);
      broadcast({ type: "load", index: 0, time: 0 });
    }

    // タイトルを非同期取得して更新
    const fetched = await fetchTitle(id);
    /* 取得待ちの間に queue が丸ごと差し替わっている可能性があるため確認する */
    if (!queue.includes(item)) return;
    item.title = fetched.slice(0, MAX_TITLE);
    renderQueue();
    saveQueue();
    if (currentIndex === queue.indexOf(item)) $("nowTitle").textContent = "▶ " + item.title;
    broadcast({ type: "queue", queue, index: currentIndex });
  } catch (e) {
    toast("動画の追加中にエラーが発生しました");
  } finally {
    btn.disabled = false;
  }
}

/* 次の動画へ(誰でも操作可・全員に同期)。再生中の動画はキューから削除する */
function playNext() {
  if (currentIndex < 0 || currentIndex >= queue.length - 1) return;
  const cur = currentIndex;
  queue.splice(cur, 1);
  saveQueue();
  broadcast({ type: "queue", queue, index: cur });
  loadVideo(cur, 0, true);
  broadcast({ type: "load", index: cur, time: 0 });
}

// $("btnCC").onclick = () => setCaptions(!captionsOn, false); // 字幕機能(無効化・再利用のため保持)
$("btnNext").onclick = playNext;
$("btnAdd").onclick = addUrl;
$("urlInput").addEventListener("keydown", e => { if (e.key === "Enter") addUrl(); });

/* プレーヤーからマウスが離れたら、iframeのフォーカスを外す。
   動画をクリックするとiframeにキーボードフォーカスが残り、YouTubeは
   アクセシビリティのためコントロール(シークバー等)を表示し続けるため。 */
$("playerBox").addEventListener("mouseleave", (e) => {
  if (e.buttons) return;              // ドラッグ中(シーク操作中)は何もしない
  const el = document.activeElement;
  if (el && el.tagName === "IFRAME" && $("playerBox").contains(el)) {
    try { el.blur(); } catch (err) {}
  }
});

/* 離脱時(リロード・タブを閉じる)に接続とタイマーを明示的に片付ける */
window.addEventListener("pagehide", () => {
  stopPolling();
  stopHostSync();
  for (const c of connections) { try { c.close(); } catch (e) {} }
  destroyPeer();
});
/* bfcacheから復帰した場合はpeerを破棄済みなので、読み込み直して整合を取る */
window.addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });

/* バージョン表示はここで流し込む(HTML側の重複を避ける) */
document.title = "YouTube SyncWatch v" + APP_VERSION;
document.querySelectorAll(".ver").forEach(el => { el.textContent = "v" + APP_VERSION; });

/* v2.0: ホスト引き継ぎ / ミュート自動再生 / 遅延補正 / サムネイル / キュー永続化 / 招待リンク */
/* v2.1: 再生が終わった動画はキューから自動削除(全員同期) */
/* v2.2: load経由の自動再生もブロック検知 → ミュート再生+解除ボタンでフォールバック */
/* v2.3: UIをダークミニマル(夜の書斎)に刷新 — 明朝見出し/セージのアクセント/ヘアライン */
/* v2.4: 再生中タイトル下に「次の動画 »」ボタン追加(全員同期・末尾で無効化) */
/* v2.5: UIをBento Soft(大きな角丸カード×エメラルド)に刷新 — 機能は不変 */
/* v2.6: 字幕の信頼性改善 — トラック明示選択/動画ごと1回適用/cc_load_policy/字幕無し通知 */
/* v2.7: 入室済みゲストで初回再生が始まらない不具合を修正 — queueをloadより先に送信＋load保留ガード */
/* v2.8: 「次の動画」ボタンで進む際、再生中の動画をキューから削除(全員同期) */
/* v2.9: 招待リンク(ハッシュにルームID)で開いたら自動参加してメイン画面へ直行 */
/* v2.10: ホストのリロード復帰 — sessionStorageでホスト判定しルーム再作成(キュー復元) */
/* v2.11: ホスト復帰時に再生中だった動画と再生位置も復元 */
/* v2.12: 字幕オン/オフ機能を無効化(コードは再利用のためコメントで保持) */
/* v2.13: セキュリティ強化 — CDN読み込みにSRI付与 / P2P受信データの型・範囲・件数を検証 */
/* v2.14: 単体HTMLを index.html / css/style.css / js/app.js の3ファイルに分割 */
/* v2.15: 参加者が増え続ける不具合を修正 — 重複排除/ハートビート/離脱時のpeer破棄 */
/* v2.16: シーク操作で相手が一時停止する不具合を修正 — PAUSEDのデバウンス/エコー防止 */
/* v2.17: ホスト引き継ぎを堅牢化 — 後始末/リトライ上限/ゲスト参加へフォールバック */
/* v2.18: 初回参加にリトライを追加 — peer-unavailableも再試行/待ち時間延長 */
/* v2.19: プレーヤーから離れた際にiframeのフォーカスを外す */
/* v2.20: 全体レビュー反映 —
   [同期] ポーリングを実経過時間ベースにし、タブ間引き/スリープ復帰での誤シーク配信を防止
          ホストの遅延二重加算を修正(中継用はコピー)、lagの負値を排除
          抑制を時間窓から「期待状態トークン」方式に変更し、本物のユーザー操作を握り潰さない
          timesyncで再生/停止の状態不一致も収束(ヒステリシス付き)
   [通信] 受信メッセージを型ごとに正規化し、中継も正規化済みコピーに(増幅攻撃の防止)
          Peer生成をmakePeerに集約し、ハンドラ漏れと旧Peerによる誤操作をガード
          ホスト昇格失敗時は全エラー種別でゲスト参加へフォールバック
   [キュー] 再生中動画の削除/エラー動画の除去/最後まで再生後の後片付けを整理
          保存キーをルーム単位にし、ゲストはキューを保存しない
          タイトル取得にタイムアウトと型チェック、await中のキュー差し替えを検知
   [UI/A11y] 一覧をボタン化しキーボード操作に対応(Alt+↑↓で並び替え)、aria-live/ラベル追加
          無効ボタンのコントラスト改善、フォーカスリング、CSP、dvh、reduced-motion 対応 */
