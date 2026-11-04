/**
 * Unit test nhắc hóa đơn quá hạn (I4) — stub model, không cần DB.
 * Chạy: npm test
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const Invoice = require('../src/models/Invoice');
const Notification = require('../src/models/Notification');
const User = require('../src/models/User');
const telegramService = require('../src/utils/telegramService');
const service = require('../src/services/notificationService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const inv = (f) => ({
    id: 1, month: 9, year: 2026, totalAmount: 1000000, isPaid: false, tenantId: 7, dueDate: '2026-09-05',
    roomDetails: { roomNumber: '101', building: { landlordId: 1 } }, ...f,
});

describe('remindOverdueInvoices (I4)', () => {
    const setup = (invoices, { latest = null } = {}) => {
        const created = [];
        const queries = [];
        stub(Invoice, 'findAll', async (opts) => { queries.push(opts); return invoices; });
        stub(Notification, 'findOne', async () => latest);
        stub(Notification, 'create', async (d) => { created.push(d); return d; });
        stub(User, 'findByPk', async (id) => ({ id, telegramChatId: null }));
        stub(telegramService, 'sendTextToTelegram', async () => {});
        return { created, queries };
    };

    test('quét toàn hệ thống: 2 hóa đơn của 2 HĐ cùng một khách đều được nhắc (khách + chủ)', async () => {
        const { created, queries } = setup([inv({ id: 1, contractId: 10 }), inv({ id: 2, contractId: 11 })]);
        const n = await service.remindOverdueInvoices(new Date('2026-10-28T08:00:00'));
        assert.equal(n, 4);
        assert.deepEqual(created.map(c => [c.userId, c.relatedId]), [[7, 1], [1, 1], [7, 2], [1, 2]]);
        assert.ok(created.every(c => c.type === 'invoice_overdue'));
        assert.equal(queries[0].where.isPaid, false);
        assert.equal(queries[0].where[Op.or][0].dueDate[Op.lt], '2026-10-28');
    });

    test('đã nhắc cách đây 1 ngày thì bỏ qua', async () => {
        const { created } = setup([inv()], { latest: { createdAt: new Date('2026-10-27T08:00:00') } });
        await service.remindOverdueInvoices(new Date('2026-10-28T08:00:00'));
        assert.equal(created.length, 0);
    });

    test('hóa đơn tháng 2 payDay 30 (dueDate 28/02) đã quá hạn vào ngày 1/3', async () => {
        const { queries } = setup([]);
        await service.remindOverdueInvoices(new Date('2027-03-01T08:00:00'));
        // '2027-02-28' < '2027-03-01' nên hóa đơn này lọt vào truy vấn
        assert.ok('2027-02-28' < queries[0].where[Op.or][0].dueDate[Op.lt]);
    });

    test('mở chuông thông báo không còn tự sinh nhắc quá hạn', async () => {
        assert.doesNotMatch(service.checkAndGenerateNotifications.toString(), /invoice_overdue/);
    });
});

describe('T3.6: getNotifications không chạy checkAndGenerateNotifications liên tục & hỗ trợ phân trang', () => {
    test('gọi getNotifications liên tiếp cho cùng userId chỉ chạy checkAndGenerateNotifications tối đa 1 lần/ngày', async () => {
        if (typeof service._resetCheckCache === 'function') service._resetCheckCache();
        let checkCount = 0;
        stub(service, 'checkAndGenerateNotifications', async () => { checkCount++; });
        stub(Notification, 'findAll', async () => []);

        await service.getNotifications(42);
        await service.getNotifications(42);
        await service.getNotifications(42);

        assert.equal(checkCount, 1);
    });

    test('getNotifications hỗ trợ phân trang tùy chọn với limit (mặc định 20) và before (id hoặc timestamp)', async () => {
        if (typeof service._resetCheckCache === 'function') service._resetCheckCache();
        stub(service, 'checkAndGenerateNotifications', async () => {});
        const queries = [];
        stub(Notification, 'findAll', async (opts) => { queries.push(opts); return []; });

        // Không truyền query -> không giới hạn limit để giữ tương thích cũ
        await service.getNotifications(42);
        assert.equal(queries[0].limit, undefined);

        // Truyền before dạng id -> limit mặc định 20 và where.id < before
        await service.getNotifications(42, { before: '100' });
        assert.equal(queries[1].limit, 20);
        assert.equal(queries[1].where.id[Op.lt], 100);

        // Truyền limit và before dạng timestamp
        await service.getNotifications(42, { limit: '15', before: '2026-10-01T00:00:00.000Z' });
        assert.equal(queries[2].limit, 15);
        assert.ok(queries[2].where.createdAt[Op.lt] instanceof Date);
    });
});
