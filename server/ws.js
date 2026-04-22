const WebSocket = require('ws');

const BINANCE_WS_URL = 'wss://fstream.binance.com/ws';
const PING_INTERVAL = 3 * 60 * 1000; // 3 min (Binance closes idle after 5 min)

class BinanceWS {
  constructor() {
    this.ws = null;
    this.subscriptions = new Set();
    this.callbacks = new Map(); // symbol -> callback(depthUpdate)
    this.reconnectTimeout = 5000;
    this._pingTimer = null;
    this._reconnectTimer = null;
  }

  connect() {
    // Don't connect if nothing to subscribe to — Binance closes idle connections
    if (this.subscriptions.size === 0) {
      return;
    }

    // Clean up old WS instance to prevent listener leaks on reconnect
    this._cleanup();

    console.log(`[WS] Connecting to Binance Futures... (${this.subscriptions.size} streams)`);
    this.ws = new WebSocket(BINANCE_WS_URL);

    this.ws.on('open', () => {
      console.log('[WS] Connected.');
      this._resubscribe();
      this._startPing();
    });

    this.ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data);
        if (payload.e === 'depthUpdate') {
          const symbol = payload.s;
          if (this.callbacks.has(symbol)) {
            this.callbacks.get(symbol)(payload);
          }
        }
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    });

    this.ws.on('close', () => {
      this._stopPing();
      // Only reconnect if we still have subscriptions
      if (this.subscriptions.size > 0) {
        console.log(`[WS] Disconnected. Reconnecting in ${this.reconnectTimeout}ms...`);
        this._reconnectTimer = setTimeout(() => this.connect(), this.reconnectTimeout);
      } else {
        console.log('[WS] Disconnected. No subscriptions, staying offline.');
      }
    });

    this.ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });

    this.ws.on('pong', () => {
      // Binance responded to ping — connection alive
    });
  }

  subscribe(symbol, callback) {
    const streamName = `${symbol.toLowerCase()}@depth@100ms`;
    this.subscriptions.add(streamName);
    this.callbacks.set(symbol.toUpperCase(), callback);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendSubscribe([streamName]);
    } else if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      // No active connection — initiate one (will resubscribe all on open)
      this.connect();
    }
    // If CONNECTING — do nothing, _resubscribe() on open will pick it up
  }

  unsubscribe(symbol) {
    const streamName = `${symbol.toLowerCase()}@depth@100ms`;
    this.subscriptions.delete(streamName);
    this.callbacks.delete(symbol.toUpperCase());

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendUnsubscribe([streamName]);
      // Close if no more subscriptions
      if (this.subscriptions.size === 0) {
        console.log('[WS] No subscriptions left, closing connection.');
        this.ws.close();
      }
    }
  }

  _resubscribe() {
    if (this.subscriptions.size > 0) {
      this._sendSubscribe(Array.from(this.subscriptions));
    }
  }

  _sendSubscribe(streams) {
    this.ws.send(JSON.stringify({
      method: 'SUBSCRIBE',
      params: streams,
      id: Date.now()
    }));
  }

  _sendUnsubscribe(streams) {
    this.ws.send(JSON.stringify({
      method: 'UNSUBSCRIBE',
      params: streams,
      id: Date.now()
    }));
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
      this.ws.removeAllListeners();
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CLOSING) {
          this.ws.terminate();
        }
      } catch (_) {}
      this.ws = null;
    }
  }
}

module.exports = new BinanceWS();
