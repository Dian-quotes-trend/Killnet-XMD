'use strict';

class AutomationRegistry {
  constructor() {
    this.automations = new Map();
  }

  normalizeName(name) {
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('automation name must be a non-empty string');
    return name.trim().toLowerCase();
  }

  register({ name, events, handler, enabled = true, description = '', category = 'AUTOMATION' }) {
    const normalizedName = this.normalizeName(name);
    if (this.automations.has(normalizedName)) throw new Error(`Automation already registered: ${normalizedName}`);
    if (!Array.isArray(events) || events.length === 0) throw new TypeError('automation events must be a non-empty array');
    if (typeof handler !== 'function') throw new TypeError('automation handler must be a function');

    const record = {
      name: normalizedName,
      events: [...new Set(events.map((event) => String(event).trim().toLowerCase()).filter(Boolean))],
      handler,
      enabled: Boolean(enabled),
      description: String(description || ''),
      category: String(category || 'AUTOMATION').toUpperCase(),
      subscriptions: [],
    };
    if (!record.events.length) throw new TypeError('automation events must contain valid names');
    this.automations.set(normalizedName, record);
    return this.get(normalizedName);
  }

  get(name) {
    const record = this.automations.get(this.normalizeName(name));
    if (!record) return null;
    return { ...record, events: [...record.events], subscriptions: undefined };
  }

  list() {
    return [...this.automations.values()].map((record) => ({
      name: record.name,
      events: [...record.events],
      enabled: record.enabled,
      description: record.description,
      category: record.category,
    }));
  }

  names() { return [...this.automations.keys()]; }

  has(name) { return this.automations.has(this.normalizeName(name)); }

  setEnabled(name, enabled) {
    const normalizedName = this.normalizeName(name);
    const record = this.automations.get(normalizedName);
    if (!record) throw new Error(`Unknown automation: ${normalizedName}`);
    record.enabled = Boolean(enabled);
    return record.enabled;
  }

  enable(name) { return this.setEnabled(name, true); }
  disable(name) { return this.setEnabled(name, false); }
  isEnabled(name) { return Boolean(this.automations.get(this.normalizeName(name))?.enabled); }

  attach(dispatcher) {
    if (!dispatcher || typeof dispatcher.on !== 'function') throw new TypeError('dispatcher with on() is required');
    for (const record of this.automations.values()) {
      for (const event of record.events) {
        const unsubscribe = dispatcher.on(event, async (payload, meta) => {
          if (!record.enabled) return;
          return record.handler(payload, meta);
        });
        record.subscriptions.push(unsubscribe);
      }
    }
    return () => this.detach();
  }

  detach() {
    for (const record of this.automations.values()) {
      for (const unsubscribe of record.subscriptions) unsubscribe();
      record.subscriptions = [];
    }
  }
}

module.exports = { AutomationRegistry };
