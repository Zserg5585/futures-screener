const WebSocket = require('ws');

const BINANCE_WS_URL = 'wss://fstream.binance.com/ws';
const PING_INTERVAL = 3 * 60 * 1000; // 3 min (Binance closes idle after 5 min)
const MAX_STREAMS_PER_CONN = 190; // Binance limit 200, leave margin

class BinanceWSConnection {
  constructor(id, onMessage) {
    this.id = id;
    this.ws = null;
    this.streams = new Set();
    this.onMessage = onMessage;
    this._pingTimer = null;
    this._reconnectTimer = null;
  }

  connect() {
    if (this.streams.size === 0) return;
    // Already connecting — just wait for 'open' to resubscribe
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    this._cleanup();

    console.log(`[WS-${this.id}] Connecting... (${this.streams.size} streams)`);
    this.ws = new WebSocket(BINANCE_WS_URL);

    this.ws.on('open', () => {
      console.log(`[WS-${this.id}] Connected.`);
      this._resubscribe();
      this._startPing();
    });

    this.ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data);
        if (payload.e === 'depthUpdate') {
          this.onMessage(payload);
        }
      } catch (err) {
        console.error(`[WS-${this.id}] Parse error:`, err.message);
      }
    });

    this.ws.on('close', () => {
      this._stopPing();
      if (this.streams.size > 0) {
        console.log(`[WS-${this.id}] Disconnected. Reconnecting in 5s...`);
        this._reconnectTimer = setTimeout(() => this.connect(), 5000);
      } else {
        console.log(`[WS-${this.id}] Disconnected. No streams, staying offline.`);
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[WS-${this.id}] Error:`, err.message);
    });

    this.ws.on('pong', () => {});
  }

  addStream(streamName) {
    this.streams.add(streamName);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._send('SUBSCRIBE', [streamName]);
    } else if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connect();
    }
  }

  removeStream(streamName) {
    this.streams.delete(streamName);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._send('UNSUBSCRIBE', [streamName]);
      if (this.streams.size === 0) {
        this.ws.close();
      }
    }
  }

  _resubscribe() {
    if (this.streams.size === 0) return;
    // Binance: max 200 params per message, send in batches
    const all = [...this.streams];
    for (let i = 0; i < all.length; i += 200) {
      const batch = all.slice(i, i + 200);
      this._send('SUBSCRIBE', batch);
    }
  }

  _send(method, params) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method, params, id: Date.now() }));
    }
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _cleanup() {
    this._stopPing();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      oldWs.removeAllListeners();
      oldWs.on('error', () => {}); // swallow async errors
      try {
        if (oldWs.readyState === WebSocket.OPEN) {
          oldWs.terminate();
        } else if (oldWs.readyState === WebSocket.CONNECTING || oldWs.readyState === WebSocket.CLOSING) {
          oldWs.close();
        }
        // CLOSED state — nothing to do
      } catch (_) { /* safe — socket may already be dead */ }
    }
  }

  destroy() {
    this.streams.clear();
    this._cleanup();
  }
}

class BinanceWS {
  constructor() {
    this.connections = []; // BinanceWSConnection[]
    this.callbacks = new Map(); // symbol -> callback
    this.streamToConn = new Map(); // streamName -> connection
  }

  subscribe(symbol, callback) {
    const streamName = `${symbol.toLowerCase()}@depth@100ms`;
    this.callbacks.set(symbol.toUpperCase(), callback);

    // Already subscribed?
    if (this.streamToConn.has(streamName)) return;

    // Find connection with capacity or create new one
    let conn = this.connections.find(c => c.streams.size < MAX_STREAMS_PER_CONN);
    if (!conn) {
      const id = this.connections.length;
      conn = new BinanceWSConnection(id, (payload) => {
        const sym = payload.s;
        if (this.callbacks.has(sym)) {
          this.callbacks.get(sym)(payload);
        }
      });
      this.connections.push(conn);
      console.log(`[WS] Created connection #${id} (total: ${this.connections.length})`);
    }

    this.streamToConn.set(streamName, conn);
    conn.addStream(streamName);
  }

  unsubscribe(symbol) {
    const streamName = `${symbol.toLowerCase()}@depth@100ms`;
    this.callbacks.delete(symbol.toUpperCase());

    const conn = this.streamToConn.get(streamName);
    if (conn) {
      conn.removeStream(streamName);
      this.streamToConn.delete(streamName);
      // Clean up empty connections
      if (conn.streams.size === 0) {
        conn.destroy();
        this.connections = this.connections.filter(c => c !== conn);
        console.log(`[WS] Removed empty connection. Total: ${this.connections.length}`);
      }
    }
  }
}

module.exports = new BinanceWS();
