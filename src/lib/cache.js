class SimpleCache {
  constructor(maxSize = 1000, defaultTTL = 300000) { // TTL: 5 minutes
    this.cache = new Map();
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
  }
  
  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }
  
  set(key, value, ttlMs) {
    if (this.cache.size >= this.maxSize) {
      // Remove oldest (first in Map)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, {
      value,
      expiry: Date.now() + (ttlMs || this.defaultTTL)
    });
  }
  
  invalidate(key) {
    this.cache.delete(key);
  }
  
  invalidateAll() {
    this.cache.clear();
  }
}

const memoryCache = new SimpleCache(1000, 300000); // 5 min TTL
module.exports = { SimpleCache, memoryCache };
