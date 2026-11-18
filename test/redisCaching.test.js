/**
 * TDD Suite: Redis Infrastructure, Caching, Session & Admin Cache Controls
 * Bao phủ:
 * - UJ-1: redis.js getSubscriberClient tách biệt + getRedisStats + delByPrefix
 * - UJ-2: cacheHelper getOrSet / del / delByPrefix / resilience fallback / metrics
 * - UJ-3: userCache qua Redis client + syncExpiredPlan xử lý plain object từ Redis
 * - UJ-4: telegramController lưu session báo hỏng qua Redis client (tg:session:<chatId>)
 * - UJ-5: Cache-Aside + Invalidation cho Plan (checkLimit), getRevenueStats (invoiceService), getSystemStats (adminService)
 * - UJ-6: adminController / adminService cache status & flush endpoints
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
const setEnv = (key, val) => {
    const orig = process.env[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
    restores.push(() => {
        if (orig === undefined) delete process.env[key];
        else process.env[key] = orig;
    });
};

afterEach(() => {
    while (restores.length) restores.pop()();
});

describe('UJ-1: Redis Pub/Sub Client Separation & Stats', () => {
    test('getSubscriberClient trả về subscriber tách biệt hỗ trợ on("message") và không làm kẹt getRedisClient', async () => {
        const redisMod = require('../src/config/redis');
        assert.equal(typeof redisMod.getSubscriberClient, 'function', 'Phải export getSubscriberClient');
        assert.equal(typeof redisMod.getRedisStats, 'function', 'Phải export getRedisStats');
        assert.equal(typeof redisMod.delByPrefix, 'function', 'Phải export delByPrefix');

        const cmdClient = redisMod.getRedisClient();
        const subClient = redisMod.getSubscriberClient();
        assert.ok(subClient);
        assert.equal(typeof subClient.on, 'function');

        let received = null;
        subClient.on('message', (channel, message) => {
            if (channel === 'test:pubsub:channel') received = message;
        });
        await subClient.subscribe('test:pubsub:channel');
        await cmdClient.publish('test:pubsub:channel', JSON.stringify({ ok: true }));
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(received, JSON.stringify({ ok: true }));

        // Lệnh set/get vẫn hoạt động bình thường trên cmdClient
        await cmdClient.set('test:after:sub', 'alive', 'EX', 10);
        assert.equal(await cmdClient.get('test:after:sub'), 'alive');
        await cmdClient.del('test:after:sub');
    });

    test('delByPrefix xóa đúng các key khớp tiền tố và giữ nguyên key khác', async () => {
        const redisMod = require('../src/config/redis');
        const client = redisMod.getRedisClient();
        await client.set('cache:stats:revenue:1:2026:1', 'a', 'EX', 60);
        await client.set('cache:stats:revenue:1:2026:2', 'b', 'EX', 60);
        await client.set('cache:stats:revenue:2:2026:1', 'c', 'EX', 60);

        const deleted = await redisMod.delByPrefix('cache:stats:revenue:1:');
        assert.equal(deleted, 2);
        assert.equal(await client.get('cache:stats:revenue:1:2026:1'), null);
        assert.equal(await client.get('cache:stats:revenue:1:2026:2'), null);
        assert.equal(await client.get('cache:stats:revenue:2:2026:1'), 'c');
        await client.del('cache:stats:revenue:2:2026:1');
    });

    test('getRedisStats trả về trạng thái kết nối và latency', async () => {
        const redisMod = require('../src/config/redis');
        const stats = await redisMod.getRedisStats();
        assert.equal(stats.mode, 'memory-fallback');
        assert.equal(stats.connected, true);
        assert.equal(typeof stats.latencyMs, 'number');
        assert.equal(typeof stats.keyCount, 'number');
    });
});

describe('UJ-2: cacheHelper Cache-Aside, Metrics & Resilience', () => {
    beforeEach(async () => {
        const cacheHelper = require('../src/utils/cacheHelper');
        cacheHelper.resetMetrics();
        await cacheHelper.delByPrefix('cache:');
    });

    test('getOrSet gọi fetcher 1 lần khi miss và trả về từ cache khi hit', async () => {
        setEnv('USE_CACHE_IN_TEST', 'true');
        const cacheHelper = require('../src/utils/cacheHelper');
        let calls = 0;
        const fetcher = async () => {
            calls++;
            return { total: 42, label: 'cached' };
        };

        const first = await cacheHelper.getOrSet('cache:test:item', 60, fetcher);
        const second = await cacheHelper.getOrSet('cache:test:item', 60, fetcher);

        assert.deepEqual(first, { total: 42, label: 'cached' });
        assert.deepEqual(second, { total: 42, label: 'cached' });
        assert.equal(calls, 1);

        const metrics = cacheHelper.getMetrics();
        assert.equal(metrics.misses, 1);
        assert.equal(metrics.hits, 1);
    });

    test('getOrSet fallback sang fetcher khi Redis get/set ném lỗi', async () => {
        setEnv('USE_CACHE_IN_TEST', 'true');
        const cacheHelper = require('../src/utils/cacheHelper');
        const redisMod = require('../src/config/redis');
        const client = redisMod.getRedisClient();
        stub(client, 'get', async () => { throw new Error('Redis timeout'); });
        stub(client, 'set', async () => { throw new Error('Redis timeout'); });

        let calls = 0;
        const res = await cacheHelper.getOrSet('cache:test:fail', 60, async () => {
            calls++;
            return { ok: true };
        });

        assert.deepEqual(res, { ok: true });
        assert.equal(calls, 1);
        assert.ok(cacheHelper.getMetrics().errors >= 1);
    });
});

describe('UJ-3: userCache Redis backing & syncExpiredPlan plain object safety', () => {
    test('userCache lưu và đọc qua Redis client với tiền tố auth:user:', async () => {
        const userCache = require('../src/utils/userCache');
        const redisMod = require('../src/config/redis');
        const client = redisMod.getRedisClient();

        await userCache.clear();
        await userCache.set(77, 2, { id: 77, tokenVersion: 2, status: 'active' }, 5000);

        const raw = await client.get('auth:user:77:2');
        assert.ok(raw, 'Phải lưu vào Redis key auth:user:77:2');
        const cached = await userCache.get(77, 2);
        assert.equal(cached.id, 77);

        await userCache.del(77);
        assert.equal(await userCache.get(77, 2), null);
        assert.equal(await client.get('auth:user:77:2'), null);
    });

    test('syncExpiredPlan xử lý an toàn khi req.user là plain object từ Redis (không có .save)', async () => {
        const planService = require('../src/services/planService');
        const userCache = require('../src/utils/userCache');
        const User = require('../src/models/User');

        await userCache.clear();
        const plainUser = {
            id: 88,
            tokenVersion: 0,
            plan: 'pro',
            planExpiresAt: '2020-01-01',
            status: 'active'
        };
        await userCache.set(88, 0, plainUser, 60000);

        let updateCalledWith = null;
        stub(User, 'update', async (values, opts) => {
            updateCalledWith = { values, opts };
            return [1];
        });

        const res = await planService.syncExpiredPlan(plainUser, new Date('2026-11-11T10:00:00Z'));
        assert.equal(res.expired, true);
        assert.equal(res.oldPlan, 'pro');
        assert.equal(updateCalledWith.values.plan, 'free');
        assert.deepEqual(updateCalledWith.opts.where, { id: 88 });
        assert.equal(await userCache.get(88, 0), null, 'Phải xóa userCache sau khi hạ gói');
    });
});

describe('UJ-4: Telegram Session lưu trên Redis', () => {
    test('telegramController lưu và đọc session từ Redis key tg:session:<chatId>', async () => {
        setEnv('TELEGRAM_WEBHOOK_SECRET', undefined);
        setEnv('NODE_ENV', 'development');
        const axios = require('axios');
        const User = require('../src/models/User');
        const Contract = require('../src/models/Contract');
        const Room = require('../src/models/Room');
        const supportService = require('../src/services/supportService');
        const redisMod = require('../src/config/redis');
        const router = require('../src/routes/telegramRoutes');
        const webhook = router.stack.find(l => l.route?.path === '/webhook').route.stack[0].handle;

        stub(axios, 'post', async () => ({}));
        stub(User, 'findOne', async () => ({ id: 7, roleData: { name: 'tenant' } }));
        stub(Contract, 'findAll', async () => [{ id: 11, roomId: 5, room: { roomNumber: '101' } }]);
        stub(Room, 'findByPk', async () => null);
        stub(supportService, 'createTenantRequest', async () => ({ supportRequest: { id: 42 } }));

        const call = async (body) => {
            const res = { status(c) { this.statusCode = c; return this; }, send(b) { this.body = b; return this; } };
            await webhook({ body, headers: {} }, res);
            return res;
        };

        await call({ callback_query: { message: { chat: { id: 901 } }, data: 'tenant_report_issue' } });
        const client = redisMod.getRedisClient();
        const rawSession = await client.get('tg:session:901');
        assert.ok(rawSession, 'Session Telegram phải được lưu trên Redis key tg:session:901');
        assert.equal(JSON.parse(rawSession).step, 'WAITING_FOR_ISSUE_DESC');

        await call({ message: { chat: { id: 901 }, text: 'Hỏng khóa cửa' } });
        assert.equal(await client.get('tg:session:901'), null, 'Session phải bị xóa sau khi hoàn tất báo hỏng');
    });
});

describe('UJ-5: Domain Caching & Invalidation (Plan, RevenueStats, SystemStats)', () => {
    beforeEach(async () => {
        setEnv('USE_CACHE_IN_TEST', 'true');
        const cacheHelper = require('../src/utils/cacheHelper');
        cacheHelper.resetMetrics();
        await cacheHelper.delByPrefix('cache:');
    });

    test('checkLimit cache Plan lookup và adminService.updatePlan xóa cache Plan', async () => {
        const Plan = require('../src/models/Plan');
        const Building = require('../src/models/Building');
        const AdminLog = require('../src/models/AdminLog');
        const { assertBuildingLimit } = require('../src/middleware/checkLimit');
        const adminService = require('../src/services/adminService');

        let planDbQueries = 0;
        stub(Plan, 'findOne', async () => {
            planDbQueries++;
            return { name: 'basic', maxBuildings: 2, maxRoomsPerBuilding: 10 };
        });
        stub(Building, 'count', async () => 1);

        await assertBuildingLimit({ id: 1, plan: 'basic' });
        await assertBuildingLimit({ id: 1, plan: 'basic' });
        assert.equal(planDbQueries, 1, 'Lần kiểm tra thứ 2 phải đọc Plan từ Redis cache');

        // Admin cập nhật gói basic -> phải xóa cache plan:basic
        const fakePlan = {
            id: 2, name: 'basic', price: 100000, annualPrice: 1000000,
            maxBuildings: 2, maxRoomsPerBuilding: 10, maxAICallsPerMonth: 20, maxChatCallsPerMonth: 100,
            async save() { return this; }
        };
        stub(Plan, 'findByPk', async () => fakePlan);
        stub(AdminLog, 'create', async () => ({}));
        await adminService.updatePlan(2, { maxBuildings: 5 }, 1);

        await assertBuildingLimit({ id: 1, plan: 'basic' });
        assert.equal(planDbQueries, 2, 'Sau khi updatePlan, phải query lại Plan mới từ DB');
    });

    test('invoiceService.getRevenueStats cache theo landlord/year/month và tự invalidate khi updatePaymentStatus', async () => {
        const Invoice = require('../src/models/Invoice');
        const SupportRequest = require('../src/models/SupportRequest');
        const Building = require('../src/models/Building');
        const invoiceService = require('../src/services/invoiceService');

        let invQueries = 0;
        stub(Invoice, 'findAll', async () => {
            invQueries++;
            return [{ id: 1, roomId: 10, month: 3, totalAmount: 2000000, isPaid: false, paidAmount: 0 }];
        });
        stub(SupportRequest, 'findAll', async () => []);

        const r1 = await invoiceService.getRevenueStats(55, { month: 3, year: 2026 });
        const r2 = await invoiceService.getRevenueStats(55, { month: 3, year: 2026 });
        assert.equal(invQueries, 1, 'Lần gọi thứ 2 phải lấy từ cache');
        assert.equal(r1.stats.unpaidAmount, 2000000);
        assert.equal(r2.stats.unpaidAmount, 2000000);

        // Thanh toán hóa đơn thuộc landlord 55 -> phải xóa cache revenue của landlord 55
        const fakeInv = {
            id: 1, roomId: 10, month: 3, year: 2026, totalAmount: 2000000, isPaid: false, paidAmount: 0, status: 'unpaid',
            roomDetails: { id: 10, roomNumber: '101', building: { landlordId: 55 } },
            async save() { return this; }
        };
        stub(Invoice, 'findByPk', async () => fakeInv);
        stub(Building, 'findOne', async () => ({ id: 1, landlordId: 55 }));
        await invoiceService.updatePaymentStatus(1, { isPaid: true, paymentMethod: 'cash' }, 55);

        await invoiceService.getRevenueStats(55, { month: 3, year: 2026 });
        assert.equal(invQueries, 2, 'Sau updatePaymentStatus, phải invalidate và query lại từ DB');
    });

    test('adminService.getSystemStats cache và tự invalidate khi updateLandlordPlan', async () => {
        const Role = require('../src/models/Role');
        const User = require('../src/models/User');
        const Plan = require('../src/models/Plan');
        const AdminLog = require('../src/models/AdminLog');
        const PlanUpgradeRequest = require('../src/models/PlanUpgradeRequest');
        const adminService = require('../src/services/adminService');

        let userCountCalls = 0;
        stub(Role, 'findOne', async () => ({ id: 2, name: 'landlord' }));
        stub(User, 'count', async () => { userCountCalls++; return 5; });
        stub(User, 'findAll', async () => []);
        stub(Plan, 'findAll', async () => [{ name: 'free', price: 0, annualPrice: 0 }]);
        stub(AdminLog, 'findAll', async () => []);

        await adminService.getSystemStats();
        const callsAfterFirst = userCountCalls;
        await adminService.getSystemStats();
        assert.equal(userCountCalls, callsAfterFirst, 'Lần gọi getSystemStats thứ 2 phải trúng cache');

        // updateLandlordPlan phải xóa cache stats:admin:system
        stub(User, 'findByPk', async () => ({
            id: 12, roleId: 2, plan: 'free', planExpiresAt: null,
            roleData: { name: 'landlord' },
            async save() { return this; }
        }));
        stub(Plan, 'findOne', async () => ({ name: 'basic', price: 100000, annualPrice: 1000000 }));
        stub(PlanUpgradeRequest, 'update', async () => [0]);
        stub(AdminLog, 'create', async () => ({}));
        await adminService.updateLandlordPlan(12, 'basic', 1, 'monthly');

        await adminService.getSystemStats();
        assert.ok(userCountCalls > callsAfterFirst, 'Sau updateLandlordPlan phải query lại stats từ DB');
    });
});

describe('UJ-6: Admin Cache Status & Flush Endpoints', () => {
    test('GET /api/admin/cache/status và POST /api/admin/cache/flush hoạt động và trả metadata đầy đủ', async () => {
        const adminController = require('../src/controllers/adminController');
        const adminRoutes = require('../src/routes/adminRoutes');
        const AdminLog = require('../src/models/AdminLog');
        const cacheHelper = require('../src/utils/cacheHelper');

        assert.equal(typeof adminController.getCacheStatus, 'function');
        assert.equal(typeof adminController.flushCache, 'function');

        const hasStatusRoute = adminRoutes.stack.some(l => l.route?.path === '/cache/status' && l.route.methods.get);
        const hasFlushRoute = adminRoutes.stack.some(l => l.route?.path === '/cache/flush' && l.route.methods.post);
        assert.ok(hasStatusRoute, 'Phải có route GET /cache/status');
        assert.ok(hasFlushRoute, 'Phải có route POST /cache/flush');

        setEnv('USE_CACHE_IN_TEST', 'true');
        await cacheHelper.getOrSet('cache:stats:admin:system', 60, async () => ({ ok: true }));

        const statusRes = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
        await adminController.getCacheStatus({ user: { id: 1 } }, statusRes);
        assert.equal(statusRes.statusCode, 200);
        assert.equal(statusRes.body.redis.mode, 'memory-fallback');
        assert.equal(typeof statusRes.body.metrics.hits, 'number');
        assert.equal(typeof statusRes.body.metrics.misses, 'number');
        assert.equal(typeof statusRes.body.metrics.hitRate, 'number');

        let logCreated = false;
        stub(AdminLog, 'create', async () => { logCreated = true; return {}; });
        const flushRes = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
        await adminController.flushCache({ user: { id: 1 }, body: { scope: 'all' } }, flushRes);
        assert.equal(flushRes.statusCode, 200);
        assert.ok(flushRes.body.clearedKeys >= 1);
        assert.equal(logCreated, true);
    });
});
