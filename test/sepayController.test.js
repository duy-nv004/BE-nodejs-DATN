/**
 * Unit test xác thực webhook SePay (C7) — stub service, không cần DB.
 * Chạy: npm test
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sepayService = require('../src/services/sepayService');
const controller = require('../src/controllers/sepayController');

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

test('C7: production thiếu SEPAY_API_KEY thì 503, không xử lý payload', async () => {
    setEnv('SEPAY_API_KEY', undefined);
    setEnv('NODE_ENV', 'production');
    let called = false;
    stub(sepayService, 'processWebhookPayload', async () => { called = true; return {}; });
    stub(console, 'error', () => {});
    const res = fakeRes();
    await controller.handleWebhook({ headers: {}, body: {} }, res);
    assert.equal(res.code, 503);
    assert.equal(called, false);
});

test('C7: dev thiếu SEPAY_API_KEY vẫn xử lý (kèm cảnh báo)', async () => {
    setEnv('SEPAY_API_KEY', undefined);
    setEnv('NODE_ENV', 'development');
    stub(sepayService, 'processWebhookPayload', async () => ({ success: true }));
    stub(console, 'warn', () => {});
    const res = fakeRes();
    await controller.handleWebhook({ headers: {}, body: {} }, res);
    assert.equal(res.code, 200);
});

test('C7: sai token thì 401 và không log token nhận được', async () => {
    setEnv('SEPAY_API_KEY', 'secret');
    const logged = [];
    stub(console, 'warn', (...a) => logged.push(a.join(' ')));
    const res = fakeRes();
    await controller.handleWebhook({ headers: { authorization: 'Apikey leaked-token-xyz' }, body: {} }, res);
    assert.equal(res.code, 401);
    assert.ok(!logged.some((l) => l.includes('leaked-token-xyz')));
});
