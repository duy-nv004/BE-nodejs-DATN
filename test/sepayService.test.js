/**
 * Unit test webhook SePay, nhánh hóa đơn (I2, T1.2, T1.3, T2.2) & nâng cấp gói (T1.16, T1.17) — stub model, không cần DB.
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Invoice = require('../src/models/Invoice');
const User = require('../src/models/User');
const AdminLog = require('../src/models/AdminLog');
const SePayEvent = require('../src/models/SePayEvent');
const Role = require('../src/models/Role');
const Plan = require('../src/models/Plan');
const PlanUpgradeRequest = require('../src/models/PlanUpgradeRequest');
const invoiceService = require('../src/services/invoiceService');
const notificationService = require('../src/services/notificationService');
const sequelize = require('../src/config/db');
const { addPlanDaysVN, todayVN } = require('../src/utils/dateVN');
const service = require('../src/services/sepayService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

describe('processWebhookPayload: hóa đơn tiền phòng (I2, T1.2, T1.3, T2.2)', () => {
    const setup = ({ owner = { id: 1 }, invoiceOver = {} } = {}) => {
        const calls = { paid: [], logs: [], notes: [], events: [] };
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' }, afterCommit: (cb) => cb() }));
        stub(SePayEvent, 'create', async (row) => {
            const ev = { ...row, async save() {}, async destroy() {} };
            calls.events.push(ev);
            return ev;
        });
        stub(Role, 'findOne', async () => ({ id: 9 }));
        stub(User, 'findOne', async () => ({ id: 77 }));
        const inv = {
            id: 12, landlordId: 1, tenantId: 88, isPaid: false, totalAmount: 1000000, paidAmount: 0,
            roomDetails: { roomNumber: '101', building: { landlordId: 1 } },
            ...invoiceOver,
        };
        stub(Invoice, 'findByPk', async () => inv);
        stub(User, 'findByPk', async () => owner);
        stub(AdminLog, 'create', async (d) => { calls.logs.push(d); });
        stub(notificationService, 'createNotification', async (...a) => { calls.notes.push(a); });
        stub(invoiceService, 'updatePaymentStatus', async (...a) => { calls.paid.push(a); });
        return calls;
    };
    const pay = (extra) => service.processWebhookPayload({
        id: Math.random(), transferType: 'in', content: 'HD 12 LL 1', transferAmount: 1000000, ...extra,
    });

    // Mọi tiền phòng về một tài khoản hệ thống đã liên kết SePay, nên không so tài khoản với chủ nhà
    test('chủ nhà còn tài khoản cũ trong DB vẫn gạch nợ khi tiền vào tài khoản hệ thống', async () => {
        const calls = setup();
        const res = await pay({ accountNumber: '0383808466' });
        assert.equal(res.type, 'ROOM_INVOICE');
        assert.equal(calls.paid.length, 1);
        assert.equal(calls.logs.filter(l => l.action === 'INVOICE_ACCOUNT_MISMATCH').length, 0);
    });

    test('đúng tài khoản, đủ tiền thì ROOM_INVOICE', async () => {
        const calls = setup();
        const res = await pay({ accountNumber: '111222333' });
        assert.equal(res.type, 'ROOM_INVOICE');
        assert.equal(res.landlordId, 1);
        assert.equal(calls.paid.length, 1);
    });

    test('LL trong nội dung khác chủ thật thì từ chối', async () => {
        const calls = setup();
        const res = await pay({ content: 'HD 12 LL 5', accountNumber: '111222333' });
        assert.equal(res.success, false);
        assert.equal(calls.paid.length, 0);
    });

    test('thanh toán hợp lệ thì gạch nợ (tiền về tài khoản hệ thống)', async () => {
        const calls = setup({ owner: { id: 1 } });
        const res = await pay({ accountNumber: '999888777' });
        assert.equal(res.type, 'ROOM_INVOICE');
        assert.equal(calls.paid.length, 1);
    });

    // Tài liệu SePay: transferAmount luôn dương, chiều giao dịch nằm ở transferType ('in'|'out').
    test('transferType = out thì bỏ qua, không gạch nợ dù nội dung đúng', async () => {
        const calls = setup();
        const res = await pay({ transferType: 'out', accountNumber: '111222333' });
        assert.equal(res.success, true);
        assert.match(res.message, /out/);
        assert.equal(calls.paid.length, 0);
    });

    test('hai giao dịch khác tài khoản ảo, không có id, không bị coi là trùng', async () => {
        setup();
        const seen = new Set();
        stub(SePayEvent, 'create', async (row) => {
            if (seen.has(row.eventKey)) {
                const err = new Error('unique');
                err.name = 'SequelizeUniqueConstraintError';
                throw err;
            }
            seen.add(row.eventKey);
            return { async save() {} };
        });

        const base = {
            id: undefined, transferType: 'in', content: 'HD 12 LL 1', transferAmount: 1000000,
            accountNumber: '111222333', transactionDate: '2026-10-28 10:00:00',
        };
        const first = await service.processWebhookPayload({ ...base, subAccount: 'VA-1' });
        const second = await service.processWebhookPayload({ ...base, subAccount: 'VA-2' });

        assert.equal(first.type, 'ROOM_INVOICE');
        assert.equal(second.type, 'ROOM_INVOICE');
        assert.equal(seen.size, 2);
    });

    test('T2.2: thanh toán một phần (amount < remainingAmount) thì ghi nhận INVOICE_PARTIAL và cộng dồn paidAmount', async () => {
        const calls = setup({ invoiceOver: { totalAmount: 1000000, paidAmount: 200000 } });
        const res = await pay({ transferAmount: 300000 });
        assert.equal(res.success, true);
        assert.equal(res.type, 'INVOICE_PARTIAL');
        assert.equal(calls.paid.length, 1);
        assert.equal(calls.paid[0][0], 12);
        assert.deepEqual(calls.paid[0][1], { isPaid: false, paymentMethod: 'sepay', paidAmount: 500000 });
        assert.ok(calls.notes.some((n) => /Đã nhận/i.test(n[2])));
    });

    test('T2.2: thanh toán thừa (amount > remainingAmount) thì gạch nợ đủ, ghi AdminLog INVOICE_OVERPAID và báo chủ nhà + khách thuê', async () => {
        const calls = setup({ invoiceOver: { totalAmount: 1000000, paidAmount: 0, tenantId: 88 } });
        const res = await pay({ transferAmount: 1250000 });
        assert.equal(res.success, true);
        assert.equal(calls.paid.length, 1);
        assert.deepEqual(calls.paid[0][1], { isPaid: true, paymentMethod: 'sepay', paidAmount: 1250000 });
        assert.ok(calls.logs.some((l) => l.action === 'INVOICE_OVERPAID'));
        assert.ok(calls.notes.some((n) => n[0] === 1));
        assert.ok(calls.notes.some((n) => n[0] === 88));
    });

    test('T1.3: mọi nhánh từ chối (UNKNOWN_INVOICE, INVOICE_LANDLORD_MISMATCH, SEPAY_UNMATCHED) đều ghi AdminLog và đánh dấu SePayEvent REJECTED', async () => {
        const calls = setup();
        const resMismatch = await pay({ content: 'HD 12 LL 5', transferAmount: 1000000 });
        assert.equal(resMismatch.success, false);
        assert.equal(calls.events[0].status, 'REJECTED');
        assert.ok(calls.logs.some((l) => l.action === 'INVOICE_LANDLORD_MISMATCH'));

        stub(Invoice, 'findByPk', async () => null);
        const resUnknown = await pay({ content: 'HD 999 LL 1', transferAmount: 1000000 });
        assert.equal(resUnknown.success, false);
        assert.equal(calls.events[1].status, 'REJECTED');
        assert.ok(calls.logs.some((l) => l.action === 'UNKNOWN_INVOICE'));

        const resUnmatched = await pay({ content: 'CHUYEN TIEN KHONG RO CU PHAP', transferAmount: 500000 });
        assert.equal(resUnmatched.success, false);
        assert.equal(calls.events[2].status, 'REJECTED');
        assert.ok(calls.logs.some((l) => l.action === 'SEPAY_UNMATCHED'));
    });
});

// ─── Các lỗi C1–C6 ────────────────────────────────────────────────────────────
const plus = (days) => addPlanDaysVN(todayVN(), days);

describe('processWebhookPayload: C1–C6', () => {
    const setupPlan = ({ landlord, plans = { pro: { name: 'pro', price: 200000, annualPrice: 1920000 }, basic: { name: 'basic', price: 100000, annualPrice: 960000 } } } = {}) => {
        const calls = { logs: [], notes: [], destroyed: 0 };
        const user = { id: 5, name: 'A', plan: 'free', planExpiresAt: null, roleData: { name: 'landlord' }, async save() {}, ...landlord };
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' }, afterCommit: (cb) => cb() }));
        stub(SePayEvent, 'create', async () => ({ async save() {}, async destroy() { calls.destroyed++; } }));
        stub(User, 'findByPk', async () => user);
        stub(Role, 'findOne', async () => ({ id: 9 }));
        stub(User, 'findOne', async () => ({ id: 77 }));
        stub(Plan, 'findOne', async ({ where }) => plans[where.name] || null);
        stub(PlanUpgradeRequest, 'findOne', async () => null);
        stub(AdminLog, 'create', async (d) => { calls.logs.push(d); });
        stub(notificationService, 'createNotification', async (...a) => { calls.notes.push(a); });
        return { calls, user };
    };
    const send = (content, transferAmount) => service.processWebhookPayload({ id: Math.random(), transferType: 'in', content, transferAmount });

    test('C1: processPayload lỗi thì xoá SePayEvent và ném lại lỗi', async () => {
        const { calls } = setupPlan();
        stub(Plan, 'findOne', async () => { throw new Error('db down'); });
        await assert.rejects(send('PLAN 5 PRO', 200000), /db down/);
        assert.equal(calls.destroyed, 1);
    });

    test('C2 + T1.16: đổi gói (basic còn 20 ngày -> pro) thì quy đổi 20 ngày basic (100k) sang 10 ngày pro (200k) + 30 ngày mới = 40 ngày', async () => {
        const { user } = setupPlan({ landlord: { plan: 'basic', planExpiresAt: plus(20) } });
        const res = await send('PLAN 5 PRO', 200000);
        assert.equal(res.type, 'PLAN_UPGRADE');
        assert.equal(user.planExpiresAt, plus(40));
        assert.equal(user.billingCycle, 'monthly');
        assert.equal(user.planSource, 'sepay');
    });

    test('T2.2: thiếu cycleToken và không có pendingRequest nhưng chuyển đủ annualPrice thì tự suy chu kỳ năm (annual)', async () => {
        const { user } = setupPlan({ landlord: { plan: 'free', planExpiresAt: null } });
        const res = await send('PLAN 5 PRO', 1920000);
        assert.equal(res.type, 'PLAN_UPGRADE');
        assert.equal(user.planExpiresAt, plus(365));
        assert.equal(user.billingCycle, 'annual');
        assert.equal(user.planSource, 'sepay');
    });

    test('C2: gia hạn cùng gói còn hạn thì cộng dồn', async () => {
        const { user } = setupPlan({ landlord: { plan: 'pro', planExpiresAt: plus(20) } });
        await send('PLAN 5 PRO', 200000);
        assert.equal(user.planExpiresAt, plus(50));
    });

    test('C3: thông báo thiếu tiền yêu cầu chuyển lại đủ, không bảo chuyển bổ sung', async () => {
        const { calls } = setupPlan();
        const res = await send('PLAN 5 PRO', 1000);
        assert.equal(res.type, 'PLAN_UNDERPAID');
        const msg = calls.notes[0][2];
        assert.doesNotMatch(msg, /bổ sung phần còn thiếu/);
        assert.match(msg, /toàn bộ/);
    });

    test('C4: AdminLog dùng id admin thật, không hardcode 1', async () => {
        const { calls } = setupPlan();
        await send('PLAN 5 PRO', 200000);
        assert.equal(calls.logs[0].adminId, 77);
    });

    test('C4: ghi log lỗi sau khi đã lưu thì không ném 500', async () => {
        setupPlan();
        stub(AdminLog, 'create', async () => { throw new Error('log fail'); });
        stub(console, 'error', () => {});
        const res = await send('PLAN 5 PRO', 200000);
        assert.equal(res.type, 'PLAN_UPGRADE');
    });

    test('C5: người nhận không phải chủ nhà thì từ chối và ghi AdminLog SEPAY_UNMATCHED', async () => {
        const { user, calls } = setupPlan({ landlord: { roleData: { name: 'tenant' } } });
        const res = await send('PLAN 5 PRO', 200000);
        assert.equal(res.success, false);
        assert.equal(user.plan, 'free');
        assert.ok(calls.logs.some(l => l.action === 'SEPAY_UNMATCHED'));
    });

    test('C5: gói free thì từ chối và ghi AdminLog PLAN_INVALID', async () => {
        const { user, calls } = setupPlan({ plans: { free: { name: 'free', price: 0 } } });
        const res = await send('PLAN 5 FREE', 0);
        assert.equal(res.success, false);
        assert.equal(user.planExpiresAt, null);
        assert.ok(calls.logs.some(l => l.action === 'PLAN_INVALID'));
    });

    test('C6: hoá đơn đã thanh toán nhận thêm tiền thì ghi log và báo chủ nhà', async () => {
        const { calls } = setupPlan();
        stub(Invoice, 'findByPk', async () => ({
            id: 12, landlordId: 1, isPaid: true, totalAmount: 1000000,
            roomDetails: { roomNumber: '101', building: { landlordId: 1 } },
        }));
        const res = await send('HD 12 LL 1', 1000000);
        assert.equal(res.type, 'INVOICE_DUPLICATE_PAYMENT');
        assert.equal(calls.logs[0].action, 'INVOICE_DUPLICATE_PAYMENT');
        assert.equal(calls.notes[0][0], 1);
        assert.match(calls.notes[0][2], /1\.000\.000/);
    });
});

describe('Đợt 1: kích hoạt gói qua SePay trong transaction', () => {
    const setupTx = ({ pending } = {}) => {
        const t = { id: 'tx', LOCK: { UPDATE: 'UPDATE' }, afterCommit: (cb) => cb() };
        const seen = { lockReads: 0, userSaveTx: null, reqSaveTx: null };
        const user = { id: 5, name: 'A', plan: 'free', planExpiresAt: null, roleData: { name: 'landlord' },
            async save(o) { seen.userSaveTx = o?.transaction; } };
        stub(sequelize, 'transaction', async (fn) => fn(t));
        stub(SePayEvent, 'create', async () => ({ async save() {}, async destroy() {} }));
        stub(User, 'findByPk', async (id, opts) => { if (opts?.lock) seen.lockReads++; return user; });
        stub(Role, 'findOne', async () => ({ id: 9 }));
        stub(User, 'findOne', async () => ({ id: 77 }));
        stub(Plan, 'findOne', async () => ({ name: 'pro', price: 200000 }));
        const req = pending && { id: 3, status: pending, amount: 200000, billingCycle: 'monthly',
            async save(o) { seen.reqSaveTx = o?.transaction; } };
        stub(PlanUpgradeRequest, 'findOne', async () => req || null);
        stub(PlanUpgradeRequest, 'findByPk', async () => req || null);
        stub(AdminLog, 'create', async () => {});
        stub(notificationService, 'createNotification', async () => {});
        return { t, seen, user, req };
    };
    const send = () => service.processWebhookPayload({ id: Math.random(), transferType: 'in', content: 'PLAN 5 PRO', transferAmount: 200000 });

    test('đọc lại chủ trọ có khóa dòng và lưu cùng transaction', async () => {
        const { t, seen } = setupTx({ pending: 'pending' });
        const res = await send();
        assert.equal(res.type, 'PLAN_UPGRADE');
        assert.ok(seen.lockReads >= 1, 'phải đọc User với lock');
        assert.equal(seen.userSaveTx, t);
        assert.equal(seen.reqSaveTx, t);
    });

    test('yêu cầu đã paid ở request song song thì không cộng hạn lần hai', async () => {
        const { user, req } = setupTx({ pending: 'pending' });
        // Giả lập request khác vừa thanh toán xong yêu cầu này
        stub(PlanUpgradeRequest, 'findByPk', async () => ({ ...req, status: 'paid' }));
        const res = await send();
        assert.equal(res.success, true);
        assert.equal(res.duplicated, true);
        assert.equal(user.planExpiresAt, null);
    });
});
