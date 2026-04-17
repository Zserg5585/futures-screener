const WebSocket = require('ws');

const BINANCE_WS_URL = 'wss://fstream.binance.com/ws';

class BinanceWS {
  constructor() {
    this.ws = null;
    this.subscriptions = new Set();
    this.callbacks = new Map(); // symbol -> callback(depthUpdate)
    this.reconnectTimeout = 5000;
  }

  connect() {
    // Clean up old WS instance to prevent listener leaks on reconnect
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.terminate(); } catch (_) {}
    }
    console.log('[WS] Connecting to Binance Futures...');
    this.ws = new WebSocket(BINANCE_WS_URL);

    this.ws.on('open', () => {
      console.log('[WS] Connected.');
      this._resubscribe();
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
      console.log(`[WS] Disconnected. Reconnecting in ${this.reconnectTimeout}ms...`);
      setTimeout(() => this.connect(), this.reconnectTimeout);
    });

    this.ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  }

  subscribe(symbol, callback) {
    const streamName = `${symbol.toLowerCase()}@depth@100ms`;
    this.subscriptions.add(streamName);
    this.callbacks.set(symbol.toUpperCase(), callback);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendSubscribe([streamName]);
    }
  }

  unsubscribe(symbol) {
    const streamName = `${symbol.toLowerCase()}@depth@100ms`;
    this.subscriptions.delete(streamName);
    this.callbacks.delete(symbol.toUpperCase());

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendUnsubscribe([streamName]);
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
}

module.exports = new BinanceWS();
