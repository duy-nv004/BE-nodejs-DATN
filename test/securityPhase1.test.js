/**
 * TDD Tests cho Giai đoạn 1: Bảo mật khẩn cấp & Toàn vẹn giao dịch SePay
 * Chạy: node --test test/securityPhase1.test.js
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sepayService = require('../src/services/sepayService');
const sepayController = require('../src/controllers/sepayController');
const sequelize = require('../src/config/db');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
const setEnv = (key, value) => {
    const orig = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    restores.push(() => { if (orig === undefined) delete process.env[key]; else process.env[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const fakeRes = () => {
    const r = { code: 200, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
};

describe('Giai đoạn 1: Toàn vẹn Webhook SePay', () => {
    test('SePay Webhook từ chối số tiền <= 0 (zero hoặc số âm)', async () => {
        const resZero = await sepayService.processWebhookPayload({
            id: 'test_sec_' + Math.random(),
            transferType: 'in',
            content: 'HD 12 LL 1',
            transferAmount: 0
        });
        assert.equal(resZero.success, false);
        assert.match(resZero.message, /số tiền/i);

        const resNeg = await sepayService.processWebhookPayload({
            id: 'test_sec_' + Math.random(),
            transferType: 'in',
            content: 'HD 12 LL 1',
            transferAmount: -500000
        });
        assert.equal(resNeg.success, false);
        assert.match(resNeg.message, /số tiền/i);
    });

    test('SePay Webhook từ chối số tiền không hợp lệ (NaN hoặc chuỗi rác)', async () => {
        const resNaN = await sepayService.processWebhookPayload({
            id: 'test_sec_' + Math.random(),
            transferType: 'in',
            content: 'HD 12 LL 1',
            transferAmount: 'invalid_amount'
        });
        assert.equal(resNaN.success, false);
        assert.match(resNaN.message, /số tiền/i);
    });

    test('SePay Controller xác thực khóa an toàn chống Timing Attack với khóa hợp lệ', async () => {
        setEnv('SEPAY_API_KEY', 'my-super-secret-key-123456');
        let processed = false;
        stub(sepayService, 'processWebhookPayload', async () => {
            processed = true;
            return { success: true };
        });

        const res = fakeRes();
        await sepayController.handleWebhook({
            headers: { authorization: 'Apikey my-super-secret-key-123456' },
            body: {}
        }, res);

        assert.equal(res.code, 200);
        assert.equal(processed, true);
    });
});

describe('Giai đoạn 1: Cấu hình Connection Pool CSDL', () => {
    test('Sequelize pool được cấu hình tối đa 20 kết nối và thời gian idle 10s', () => {
        assert.ok(sequelize.options.pool, 'Thiếu cấu hình pool trong sequelize');
        assert.equal(sequelize.options.pool.max, 20, 'pool.max phải là 20');
        assert.equal(sequelize.options.pool.idle, 10000, 'pool.idle phải là 10000');
    });
});

describe('Giai đoạn 1: CORS & Global Error Handling', () => {
    const { corsOriginValidator } = require('../src/utils/cors');

    test('CORS cho phép request không có Origin (server-to-server / curl)', (t, done) => {
        corsOriginValidator(undefined, (err, allow) => {
            assert.equal(err, null);
            assert.equal(allow, true);
            done();
        });
    });

    test('CORS chặn origin lạ nếu không nằm trong whitelist', (t, done) => {
        setEnv('CORS_ORIGINS', 'https://homesync.vn,http://localhost:5173');
        corsOriginValidator('https://malicious-attacker.com', (err, allow) => {
            assert.ok(err);
            assert.match(err.message, /CORS/);
            done();
        });
    });

    test('CORS cho phép origin hợp lệ nằm trong whitelist', (t, done) => {
        setEnv('CORS_ORIGINS', 'https://homesync.vn,http://localhost:5173');
        corsOriginValidator('http://localhost:5173', (err, allow) => {
            assert.equal(err, null);
            assert.equal(allow, true);
            done();
        });
    });
});
