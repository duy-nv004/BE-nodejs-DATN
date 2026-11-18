/**
 * Redis Client & Distributed Lock Module
 * Tự động kết nối Redis nếu cấu hình REDIS_URL / REDIS_HOST.
 * Tự động chuyển đổi mượt mà sang In-Memory Fallback nếu không có Redis hoặc trong môi trường test độc lập.
 */
const EventEmitter = require('events');

class MemoryRedisStore {
    constructor() {
        this.store = new Map();
        this.timers = new Map();
        this.emitter = new EventEmitter();
        this.emitter.setMaxListeners(100);
    }

    _getSync(key) {
        const item = this.store.get(key);
        if (!item) return null;
        if (item.expireAt && item.expireAt <= Date.now()) {
            this._delSync(key);
            return null;
        }
        return item.value;
    }

    _delSync(key) {
        if (this.timers.has(key)) {
            clearTimeout(this.timers.get(key));
            this.timers.delete(key);
        }
        const existed = this.store.has(key);
        this.store.delete(key);
        return existed ? 1 : 0;
    }

    async get(key) {
        return this._getSync(key);
    }

    async set(key, value, ...args) {
        let expireAt = null;
        let nx = false;

        for (let i = 0; i < args.length; i++) {
            const arg = String(args[i]).toUpperCase();
            if (arg === 'EX' && args[i + 1]) {
                expireAt = Date.now() + Number(args[i + 1]) * 1000;
                i++;
            } else if (arg === 'PX' && args[i + 1]) {
                expireAt = Date.now() + Number(args[i + 1]);
                i++;
            } else if (arg === 'NX') {
                nx = true;
            }
        }

        // Kiểm tra nguyên tử (synchronous check) để đảm bảo không bị race condition
        if (nx) {
            const existing = this._getSync(key);
            if (existing !== null) {
                return null;
            }
        }

        if (this.timers.has(key)) {
            clearTimeout(this.timers.get(key));
            this.timers.delete(key);
        }

        this.store.set(key, { value: String(value), expireAt });

        if (expireAt) {
            const ttl = Math.max(1, expireAt - Date.now());
            const timer = setTimeout(() => {
                this._delSync(key);
            }, ttl);
            if (timer.unref) timer.unref();
            this.timers.set(key, timer);
        }

        return 'OK';
    }

    async del(...keys) {
        let count = 0;
        for (const k of keys.flat()) {
            count += this._delSync(k);
        }
        return count;
    }

    async ping() {
        return 'PONG';
    }

    async dbsize() {
        // Dọn key hết hạn trước khi đếm
        for (const k of Array.from(this.store.keys())) {
            this._getSync(k);
        }
        return this.store.size;
    }

    keysByPrefix(prefix) {
        const matched = [];
        for (const k of Array.from(this.store.keys())) {
            if (k.startsWith(prefix) && this._getSync(k) !== null) {
                matched.push(k);
            }
        }
        return matched;
    }

    on(event, listener) {
        this.emitter.on(event, listener);
        return this;
    }

    async publish(channel, message) {
        const payload = typeof message === 'string' ? message : JSON.stringify(message);
        this.emitter.emit(channel, payload);
        this.emitter.emit('message', channel, payload);
        return 1;
    }

    async subscribe(channel, callback) {
        if (typeof callback === 'function') {
            this.emitter.on(channel, callback);
        }
        return {
            unsubscribe: () => {
                if (typeof callback === 'function') this.emitter.off(channel, callback);
            }
        };
    }

    async quit() {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.store.clear();
    }
}

let redisClient = null;
let subscriberClient = null;
let isRealRedis = false;

const initClient = () => {
    const isTest = (process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT)) && process.env.USE_REDIS !== 'true';
    const redisUrl = process.env.REDIS_URL || process.env.REDIS_HOST;

    if (!isTest && redisUrl) {
        try {
            const Redis = require('ioredis');
            const client = new Redis(process.env.REDIS_URL || {
                host: process.env.REDIS_HOST || '127.0.0.1',
                port: Number(process.env.REDIS_PORT) || 6379,
                password: process.env.REDIS_PASSWORD || undefined,
                lazyConnect: true,
                maxRetriesPerRequest: 1,
                connectTimeout: 2000
            });

            client.on('error', (err) => {
                console.warn('[Redis] Kết nối Redis gặp lỗi, chuyển sang fallback:', err.message);
            });

            isRealRedis = true;
            return client;
        } catch (e) {
            console.warn('[Redis] ioredis không thể khởi tạo, dùng in-memory fallback:', e.message);
        }
    }

    return new MemoryRedisStore();
};

const getRedisClient = () => {
    if (!redisClient) {
        redisClient = initClient();
    }
    return redisClient;
};

/**
 * Trả về kết nối Redis riêng cho Pub/Sub Subscribe.
 * Với ioredis thật, kết nối đã subscribe không được phép chạy lệnh get/set/eval,
 * nên bắt buộc dùng client.duplicate() tách biệt khỏi getRedisClient().
 */
const getSubscriberClient = () => {
    const base = getRedisClient();
    if (isRealRedis && typeof base.duplicate === 'function') {
        if (!subscriberClient) {
            subscriberClient = base.duplicate();
            subscriberClient.on('error', (err) => {
                console.warn('[Redis Subscriber] Lỗi kết nối:', err.message);
            });
        }
        return subscriberClient;
    }
    return base;
};

/**
 * Xóa toàn bộ các key bắt đầu bằng prefix (dùng SCAN trên Redis thật để không block).
 * @param {string} prefix
 * @returns {Promise<number>} Số key đã xóa
 */
const delByPrefix = async (prefix) => {
    if (!prefix) return 0;
    const client = getRedisClient();

    if (isRealRedis && typeof client.scanStream === 'function') {
        return new Promise((resolve, reject) => {
            let deleted = 0;
            const stream = client.scanStream({ match: `${prefix}*`, count: 100 });
            const pending = [];
            stream.on('data', (keys) => {
                if (Array.isArray(keys) && keys.length > 0) {
                    pending.push(
                        client.del(...keys).then((n) => {
                            deleted += Number(n) || 0;
                        })
                    );
                }
            });
            stream.on('end', async () => {
                try {
                    await Promise.all(pending);
                    resolve(deleted);
                } catch (err) {
                    reject(err);
                }
            });
            stream.on('error', reject);
        });
    }

    if (typeof client.keysByPrefix === 'function') {
        const keys = client.keysByPrefix(prefix);
        if (keys.length === 0) return 0;
        return client.del(...keys);
    }

    return 0;
};

/**
 * Lấy thông tin tình trạng Redis phục vụ health check & Admin Dashboard.
 */
const getRedisStats = async () => {
    const client = getRedisClient();
    const start = Date.now();
    try {
        if (typeof client.ping === 'function') {
            await client.ping();
        }
        const latencyMs = Date.now() - start;
        const keyCount = typeof client.dbsize === 'function' ? await client.dbsize() : null;
        let memoryUsed = null;
        if (isRealRedis && typeof client.info === 'function') {
            const info = await client.info('memory');
            const match = String(info).match(/used_memory_human:([^\r\n]+)/);
            if (match) memoryUsed = match[1].trim();
        }
        return {
            mode: isRealRedis ? 'redis' : 'memory-fallback',
            connected: true,
            latencyMs,
            keyCount: typeof keyCount === 'number' ? keyCount : null,
            memoryUsed
        };
    } catch (err) {
        return {
            mode: isRealRedis ? 'redis' : 'memory-fallback',
            connected: false,
            latencyMs: null,
            keyCount: null,
            memoryUsed: null,
            error: err.message
        };
    }
};

/**
 * Lấy distributed lock cho một tài nguyên
 * @param {string} key Khóa tài nguyên
 * @param {number} ttlMs Thời gian giữ khóa tối đa (ms)
 * @param {number} maxRetries Số lần thử lại nếu đang bị khóa
 * @param {number} retryDelayMs Khoảng cách giữa các lần thử (ms)
 * @returns {Promise<string|null>} lockId nếu lấy được lock, null nếu thất bại
 */
const acquireLock = async (key, ttlMs = 5000, maxRetries = 10, retryDelayMs = 50) => {
    const client = getRedisClient();
    const lockKey = `lock:${key}`;
    const lockId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let result;
        if (typeof client.set === 'function') {
            result = await client.set(lockKey, lockId, 'PX', ttlMs, 'NX');
        }

        if (result === 'OK' || result === 1) {
            return lockId;
        }

        if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
        }
    }

    return null;
};

/**
 * Giải phóng distributed lock một cách an toàn
 * @param {string} key
 * @param {string} lockId
 * @returns {Promise<boolean>}
 */
const releaseLock = async (key, lockId) => {
    if (!lockId) return false;
    const client = getRedisClient();
    const lockKey = `lock:${key}`;

    if (isRealRedis && typeof client.eval === 'function') {
        const luaScript = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        `;
        const res = await client.eval(luaScript, 1, lockKey, lockId);
        return res === 1;
    } else {
        const current = await client.get(lockKey);
        if (current === lockId) {
            await client.del(lockKey);
            return true;
        }
        return false;
    }
};

/**
 * Chạy hàm fn dưới sự bảo vệ của distributed lock
 */
const withDistributedLock = async (key, fn, ttlMs = 5000) => {
    const lockId = await acquireLock(key, ttlMs, 40, 20);
    if (!lockId) {
        throw new Error(`Không thể lấy khóa phân tán cho tài nguyên: ${key}`);
    }
    try {
        return await fn();
    } finally {
        await releaseLock(key, lockId);
    }
};

module.exports = {
    getRedisClient,
    getSubscriberClient,
    delByPrefix,
    getRedisStats,
    acquireLock,
    releaseLock,
    withDistributedLock,
    isRealRedis: () => isRealRedis
};
