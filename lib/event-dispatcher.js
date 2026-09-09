'use strict';

class EventDispatcher {
  constructor({ onError } = {}) {
    this.listenersMap = new Map();
    this.onError = typeof onError === 'function' ? onError : () => {};
  }

  normalizeEvent(eventName) {
    if (typeof eventName !== 'string' || !eventName.trim()) {
      throw new TypeError('eventName must be a non-empty string');
    }
    return eventName.trim().toLowerCase();
  }

  on(eventName, handler) {
    const event = this.normalizeEvent(eventName);
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    if (!this.listenersMap.has(event)) this.listenersMap.set(event, new Set());
    const listeners = this.listenersMap.get(event);
    listeners.add(handler);
    return () => this.off(event, handler);
  }

  once(eventName, handler) {
    const wrapped = async (payload, meta) => {
      this.off(eventName, wrapped);
      return handler(payload, meta);
    };
    return this.on(eventName, wrapped);
  }

  off(eventName, handler) {
    const event = this.normalizeEvent(eventName);
    const listeners = this.listenersMap.get(event);
    if (!listeners) return false;
    const removed = listeners.delete(handler);
    if (listeners.size === 0) this.listenersMap.delete(event);
    return removed;
  }

  listenerCount(eventName) {
    const event = this.normalizeEvent(eventName);
    return this.listenersMap.get(event)?.size || 0;
  }

  async emit(eventName, payload, meta = {}) {
    const event = this.normalizeEvent(eventName);
    const listeners = [
      ...(this.listenersMap.get(event) || []),
      ...(this.listenersMap.get('*') || []),
    ];
    const failures = [];

    for (const handler of listeners) {
      try {
        await handler(payload, { ...meta, event });
      } catch (error) {
        failures.push({ handler, error });
        try {
          await this.onError(error, { event, payload, meta });
        } catch (_) {
          // Error reporting must never break event dispatch.
        }
      }
    }

    return { event, delivered: listeners.length, failures };
  }
}

module.exports = { EventDispatcher };
