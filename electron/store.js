/* ============================================================================
 * electron/store.js —— 本地数据存储（JSON 文件 + 原子写）
 *
 * 为什么不直接用 localStorage：
 *   localStorage 配额约 10MB、无法备份、无法被 CLI 读到、卸载即丢。
 *   桌面版必须让数据是**文件**：能备份、能同步、能用别的工具打开。
 *
 * 存放位置：%APPDATA%\CyanCodex\data\<name>.json
 *
 * ★ 原子写：先写 .tmp 再 rename。直接覆盖原文件时断电会留下半个 JSON，
 *   下次启动整个数据就废了。
 * ★ 写入节流：前端可能一秒内改十几次，合并成 400ms 写一次。
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const C = require("../core/config");

const DATA_DIR = path.join(C.HOME, "data");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

function fileOf(name) {
  // 只允许简单名字，防止 name 里塞 ../ 穿越出去
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(ensure(), (safe || "default") + ".json");
}

class Store {
  constructor(name) {
    this.file = fileOf(name);
    this.data = {};
    this._timer = null;
    this._dirty = false;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const obj = JSON.parse(raw);
      this.data = obj && typeof obj === "object" ? obj : {};
    } catch (_) {
      this.data = {};
    }
  }

  get(key, dflt) {
    if (key === undefined) return this.data;
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : dflt;
  }

  set(key, value) {
    this.data[key] = value;
    this._schedule();
    return true;
  }

  setAll(obj) {
    this.data = obj && typeof obj === "object" ? obj : {};
    this._schedule();
    return true;
  }

  del(key) {
    delete this.data[key];
    this._schedule();
    return true;
  }

  clear() {
    this.data = {};
    this._schedule();
    return true;
  }

  _schedule() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 400);
  }

  /** 立刻落盘（退出前必须调一次） */
  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      ensure();
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // 写失败不要把 _dirty 清掉，下次还能再试
      this._dirty = true;
      console.error("[store] 写入失败", this.file, e.message);
    }
  }

  /** 整份导出（备份用） */
  dump() {
    return { name: path.basename(this.file, ".json"), data: this.data, file: this.file };
  }
}

const cache = new Map();

function open(name) {
  const key = String(name);
  if (!cache.has(key)) cache.set(key, new Store(key));
  return cache.get(key);
}

function flushAll() {
  for (const s of cache.values()) s.flush();
}

module.exports = { open, flushAll, DATA_DIR, ensure };
