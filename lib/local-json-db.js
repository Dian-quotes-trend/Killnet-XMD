'use strict';

const fs = require('fs/promises');
const path = require('path');

const DEFAULT_FILE = path.resolve('./data/database.json');
const DATABASES = new Map();

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function assertKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw new TypeError('Database key must be a non-empty string');
}

class LocalJsonDatabase {
  constructor(filePath = DEFAULT_FILE) {
    this.filePath = path.resolve(filePath);
    this._state = null;
    this._writeQueue = Promise.resolve();
  }

  async _ensureLoaded() {
    if (this._state) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Database root must be an object');
      this._state = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Failed to load database: ${error.message}`);
      this._state = {};
      await this._persist();
    }
  }

  async _persist() {
    const snapshot = JSON.stringify(this._state, null, 2);
    this._writeQueue = this._writeQueue.then(async () => {
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, `${snapshot}\n`, 'utf8');
      await fs.rename(tempPath, this.filePath);
    });
    return this._writeQueue;
  }

  async get(key, fallback = undefined) {
    assertKey(key);
    await this._ensureLoaded();
    return this._state[key] === undefined ? clone(fallback) : clone(this._state[key]);
  }

  async has(key) {
    assertKey(key);
    await this._ensureLoaded();
    return Object.prototype.hasOwnProperty.call(this._state, key);
  }

  async set(key, value) {
    assertKey(key);
    await this._ensureLoaded();
    this._state[key] = clone(value);
    await this._persist();
    return clone(value);
  }

  async delete(key) {
    assertKey(key);
    await this._ensureLoaded();
    const existed = Object.prototype.hasOwnProperty.call(this._state, key);
    if (existed) {
      delete this._state[key];
      await this._persist();
    }
    return existed;
  }

  async update(key, updater, fallback = undefined) {
    assertKey(key);
    if (typeof updater !== 'function') throw new TypeError('Database updater must be a function');
    const current = await this.get(key, fallback);
    const next = await updater(clone(current));
    await this.set(key, next);
    return clone(next);
  }

  async all() {
    await this._ensureLoaded();
    return clone(this._state);
  }

  async clear() {
    await this._ensureLoaded();
    this._state = {};
    await this._persist();
  }
}

function createLocalJsonDatabase(filePath = DEFAULT_FILE) {
  const resolved = path.resolve(filePath);
  if (!DATABASES.has(resolved)) DATABASES.set(resolved, new LocalJsonDatabase(resolved));
  return DATABASES.get(resolved);
}

module.exports = { LocalJsonDatabase, createLocalJsonDatabase, DEFAULT_FILE };
