/**
 * Unit test tiền cọc (src/services/depositService.js) — stub model, không cần DB.
 * Chạy: npm test
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Contract = require('../src/models/Contract');
const DepositRecord = require('../src/models/DepositRecord');
const service = require('../src/services/depositService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

test('C1: refundDeposit trên HĐ đang active thì 400', async () => {
    stub(Contract, 'findByPk', async () => ({ id: 3, status: 'active', room: { building: { landlordId: 1 } } }));
    stub(DepositRecord, 'findOne', async () => ({ amount: 1000, async save() {} }));
    await assert.rejects(service.refundDeposit(1, 3, { amount: 1000 }),
        (e) => e.statusCode === 400 && /sau khi thanh lý/.test(e.message));
});

test('C8: refundDeposit từ chối số âm / không hợp lệ / tổng khác số cọc', async () => {
    stub(Contract, 'findByPk', async () => ({ id: 3, status: 'terminated', room: { building: { landlordId: 1 } } }));
    const saved = [];
    stub(DepositRecord, 'findOne', async () => ({ amount: 1000, async save() { saved.push(1); } }));
    for (const body of [{ amount: -500, deductAmount: 1500 }, { amount: 'abc', deductAmount: 0 }, { amount: 300, deductAmount: 200 }, { amount: Infinity }]) {
        await assert.rejects(service.refundDeposit(1, 3, body), (e) => e.statusCode === 400, JSON.stringify(body));
    }
    assert.equal(saved.length, 0);
    const res = await service.refundDeposit(1, 3, { amount: 700, deductAmount: 300 });
    assert.equal(res.record.status, 'deducted');
});
