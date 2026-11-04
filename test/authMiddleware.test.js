/**
 * Unit test middleware xác thực (src/middleware/authMiddleware.js) — stub model, không cần DB.
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User');
const { protect } = require('../src/middleware/authMiddleware');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const makeRes = () => ({
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
});

describe('protect', () => {
    test('E2: tài khoản bị khóa -> 403 kèm code ACCOUNT_LOCKED và lý do', async () => {
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
        const token = jwt.sign({ id: 3 }, process.env.JWT_SECRET);
        stub(User, 'findByPk', async () => ({ id: 3, status: 'locked', lockReason: 'Vi phạm' }));
        const res = makeRes();
        let nextCalled = false;
        await protect({ headers: { authorization: `Bearer ${token}` } }, res, () => { nextCalled = true; });
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.code, 'ACCOUNT_LOCKED');
        assert.match(res.body.message, /đã bị khóa.*Vi phạm/);
    });

    test('T1.14: jwt.verify lỗi -> 401 Token không hợp lệ', async () => {
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
        const res = makeRes();
        let nextCalled = false;
        await protect({ headers: { authorization: 'Bearer invalid.token.here' } }, res, () => { nextCalled = true; });
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 401);
        assert.equal(res.body.message, 'Token không hợp lệ');
    });

    test('T1.14: User.findByPk ném lỗi DB -> 500 chứ không trả 401', async () => {
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
        const token = jwt.sign({ id: 3, tokenVersion: 0 }, process.env.JWT_SECRET);
        stub(User, 'findByPk', async () => { throw new Error('SequelizeConnectionError: DB down'); });
        const res = makeRes();
        let nextCalled = false;
        await protect({ headers: { authorization: `Bearer ${token}` } }, res, () => { nextCalled = true; });
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 500);
        assert.equal(res.body.message, 'Lỗi máy chủ khi xác thực phiên đăng nhập');
    });

    test('T1.14: lỗi từ syncExpiredPlan hoặc createNotification không làm hỏng request', async () => {
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
        const token = jwt.sign({ id: 3, tokenVersion: 0 }, process.env.JWT_SECRET);
        stub(User, 'findByPk', async () => ({ id: 3, status: 'active', tokenVersion: 0, roleData: { name: 'landlord' } }));
        const planService = require('../src/services/planService');
        const notificationService = require('../src/services/notificationService');
        stub(planService, 'syncExpiredPlan', async () => ({ expired: true, oldPlan: 'pro' }));
        stub(notificationService, 'createNotification', async () => { throw new Error('Notification failed'); });

        const res = makeRes();
        let nextCalled = false;
        await protect({ headers: { authorization: `Bearer ${token}` } }, res, () => { nextCalled = true; });
        assert.equal(nextCalled, true);
        assert.equal(res.statusCode, 200);
    });

    test('bỏ qua kiểm tra hạn gói syncExpiredPlan với vai trò tenant và admin', async () => {
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
        const token = jwt.sign({ id: 5, tokenVersion: 0 }, process.env.JWT_SECRET);
        stub(User, 'findByPk', async () => ({ id: 5, status: 'active', tokenVersion: 0, roleData: { name: 'tenant' } }));
        const planService = require('../src/services/planService');
        let syncCalled = false;
        stub(planService, 'syncExpiredPlan', async () => {
            syncCalled = true;
            return { expired: false };
        });

        const res = makeRes();
        let nextCalled = false;
        await protect({ headers: { authorization: `Bearer ${token}` } }, res, () => { nextCalled = true; });
        assert.equal(nextCalled, true);
        assert.equal(syncCalled, false, 'syncExpiredPlan không được gọi cho tenant');
    });
});
