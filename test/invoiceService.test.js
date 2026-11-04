/**
 * Unit test hóa đơn (src/services/invoiceService.js) — stub model, không cần DB.
 * Chạy: npm test
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sequelize = require('../src/config/db');
const Invoice = require('../src/models/Invoice');
const SePayEvent = require('../src/models/SePayEvent');
const AdminLog = require('../src/models/AdminLog');
const service = require('../src/services/invoiceService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
beforeEach(() => {
    stub(sequelize, 'transaction', async (fn) => fn({}));
    stub(SePayEvent, 'findOne', async () => null);
    stub(AdminLog, 'create', async () => ({}));
});
afterEach(() => { while (restores.length) restores.pop()(); });

describe('getRevenueStats', () => {
    test('kỳ chưa có hóa đơn trả invoiceCount = 0', async () => {
        stub(Invoice, 'findAll', async () => []);
        const res = await service.getRevenueStats(1, { month: 12, year: 2030 });
        assert.equal(res.stats.invoiceCount, 0);
    });

    test('đếm đúng số hóa đơn trong kỳ', async () => {
        stub(Invoice, 'findAll', async () => [{ totalAmount: 100, isPaid: true }, { totalAmount: 50, isPaid: false }]);
        const res = await service.getRevenueStats(1, { month: 1, year: 2026 });
        assert.equal(res.stats.invoiceCount, 2);
        assert.equal(res.stats.unpaidRooms, 1);
    });
});

const Contract = require('../src/models/Contract');
const Room = require('../src/models/Room');
const User = require('../src/models/User');
const MeterReading = require('../src/models/MeterReading');
const telegramService = require('../src/utils/telegramService');

const record = (fields) => ({ ...fields, saved: 0, async save() { this.saved++; return this; } });
const makeInvoice = (fields = {}) => record({
    id: 3, roomId: 5, landlordId: 1, tenantId: 7, month: 10, year: 2026, totalAmount: 2500000,
    isPaid: false, paidAt: null, paidAmount: 0, paymentMethod: null,
    roomDetails: { roomNumber: '101', building: { landlordId: 1 } }, ...fields,
});

describe('computeDueDate (I3)', () => {
    test('kẹp ngày đóng tiền về cuối tháng', () => {
        assert.equal(service.computeDueDate(2027, 2, 30), '2027-02-28');
        assert.equal(service.computeDueDate(2028, 2, 30), '2028-02-29');
        assert.equal(service.computeDueDate(2026, 10, 5), '2026-10-05');
        assert.equal(service.computeDueDate(2026, 4, null), '2026-04-30');
    });
});

describe('updatePaymentStatus (I3 + I8)', () => {
    const sent = [];
    const setup = (invoice, { activeTenantId = 9 } = {}) => {
        sent.length = 0;
        stub(Invoice, 'findByPk', async () => invoice);
        stub(Contract, 'findOne', async () => record({ id: 2, tenantId: activeTenantId, status: 'active' }));
        stub(User, 'findByPk', async (id) => ({ id, name: `U${id}`, telegramChatId: `chat-${id}` }));
        stub(telegramService, 'sendTextToTelegram', async (chatId, text) => { sent.push({ chatId, text }); });
    };

    test('xác nhận tiền mặt: lưu paidAt, paidAmount = totalAmount, paymentMethod', async () => {
        const inv = makeInvoice();
        setup(inv);
        await service.updatePaymentStatus(3, { isPaid: true, paymentMethod: 'cash' }, 1);
        assert.equal(inv.isPaid, true);
        assert.ok(inv.paidAt instanceof Date);
        assert.equal(inv.paidAmount, 2500000);
        assert.equal(inv.paymentMethod, 'cash');
        assert.equal(inv.saved, 1);
    });

    test('không gửi paymentMethod thì mặc định cash; paidAmount gửi kèm được giữ', async () => {
        const inv = makeInvoice();
        setup(inv);
        await service.updatePaymentStatus(3, { isPaid: true, paidAmount: 2600000 });
        assert.equal(inv.paymentMethod, 'cash');
        assert.equal(inv.paidAmount, 2600000);
    });

    test('hủy xác nhận: reset paidAt, paidAmount, paymentMethod', async () => {
        const inv = makeInvoice({ isPaid: true, paidAt: new Date(), paidAmount: 2500000, paymentMethod: 'cash' });
        setup(inv);
        await service.updatePaymentStatus(3, { isPaid: false }, 1);
        assert.equal(inv.isPaid, false);
        assert.equal(inv.paidAt, null);
        assert.equal(inv.paidAmount, 0);
        assert.equal(inv.paymentMethod, null);
        assert.equal(sent.length, 0);
    });

    test('paymentMethod không hợp lệ hoặc isPaid không phải boolean thì 400', async () => {
        setup(makeInvoice());
        await assert.rejects(() => service.updatePaymentStatus(3, { isPaid: true, paymentMethod: 'abc' }, 1),
            (e) => e.statusCode === 400);
        await assert.rejects(() => service.updatePaymentStatus(3, { isPaid: 'true' }, 1),
            (e) => e.statusCode === 400);
        await assert.rejects(() => service.updatePaymentStatus(3, { isPaid: true, paidAmount: -1 }, 1),
            (e) => e.statusCode === 400);
        await assert.rejects(() => service.updatePaymentStatus(3, { isPaid: true, paidAmount: 'abc' }, 1),
            (e) => e.statusCode === 400);
    });

    test('hóa đơn đã ở trạng thái yêu cầu thì không lưu, không gửi Telegram lần nữa', async () => {
        const inv = makeInvoice({ isPaid: true, paymentMethod: 'sepay' });
        setup(inv);
        await service.updatePaymentStatus(3, { isPaid: true, paymentMethod: 'cash' }, 1);
        assert.equal(inv.saved, 0);
        assert.equal(inv.paymentMethod, 'sepay');
        assert.equal(sent.length, 0);
    });

    test('I8: Telegram gửi cho invoice.tenantId, không phải người đang thuê', async () => {
        setup(makeInvoice({ tenantId: 7 }), { activeTenantId: 9 });
        await service.updatePaymentStatus(3, { isPaid: true }, 1);
        assert.deepEqual(sent.map(s => s.chatId), ['chat-7']);
    });

    test('I8: hóa đơn cũ không có tenantId thì fallback người thuê HĐ active', async () => {
        setup(makeInvoice({ tenantId: null }), { activeTenantId: 9 });
        await service.updatePaymentStatus(3, { isPaid: true }, 1);
        assert.deepEqual(sent.map(s => s.chatId), ['chat-9']);
    });
});

describe('generateInvoice (I3 + I7)', () => {
    test('lưu dueDate, chỉ số cũ/mới và đơn giá vào hóa đơn', async () => {
        stub(Room, 'findByPk', async () => ({ id: 5, roomNumber: '101', price: 3000000, building: { landlordId: 1 } }));
        stub(Contract, 'findOne', async () => ({ id: 2, tenantId: 7, paymentDay: 30, electricityPrice: 3500, waterPrice: 20000 }));
        stub(Invoice, 'findOne', async () => null);
        stub(MeterReading, 'findOne', async ({ where }) => {
            const prev = typeof where.period === 'object';
            if (where.type === 'electricity') return { readingValue: prev ? 100 : 150 };
            return { readingValue: prev ? 10 : 14 };
        });
        let payload;
        stub(Invoice, 'create', async (data) => { payload = data; return record({ id: 11, ...data }); });
        stub(User, 'findOne', async () => null);

        await service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1);
        assert.equal(payload.dueDate, '2027-02-28');
        assert.equal(payload.electricityOld, 100);
        assert.equal(payload.electricityNew, 150);
        assert.equal(payload.waterOld, 10);
        assert.equal(payload.waterNew, 14);
        assert.equal(payload.electricityPrice, 3500);
        assert.equal(payload.waterPrice, 20000);
        assert.equal(payload.electricityTotal, 50 * 3500);
    });
});

describe('generateInvoice: chỉ số (I6), giá thuê (I5), hết hạn (C3)', () => {
    // prev = null: không có kỳ trước
    const setupGen = ({ prev = { electricity: 100, water: 10 }, cur = { electricity: 150, water: 14 }, contract = {}, room = {} } = {}) => {
        stub(Room, 'findByPk', async () => ({ id: 5, roomNumber: '101', price: 3000000, building: { landlordId: 1 }, ...room }));
        stub(Contract, 'findOne', async () => ({
            id: 2, tenantId: 7, paymentDay: 30, electricityPrice: 3500, waterPrice: 20000,
            initialElectricity: 80, initialWater: 8, endDate: '2027-12-31', ...contract
        }));
        stub(Invoice, 'findOne', async () => null);
        stub(MeterReading, 'findOne', async ({ where }) => {
            const src = typeof where.period === 'object' ? prev : cur;
            return src ? { readingValue: src[where.type] } : null;
        });
        const out = {};
        stub(Invoice, 'create', async (data) => { out.payload = data; return record({ id: 11, ...data }); });
        stub(User, 'findOne', async () => null);
        return out;
    };

    test('I6: không có kỳ trước thì số cũ = chỉ số ban đầu của HĐ', async () => {
        const out = setupGen({ prev: null });
        await service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1);
        assert.equal(out.payload.electricityOld, 80);
        assert.equal(out.payload.waterOld, 8);
        assert.equal(out.payload.electricityTotal, 70 * 3500);
    });

    test('I6: số mới nhỏ hơn số cũ thì 400, không tính âm thầm thành 0', async () => {
        setupGen({ cur: { electricity: 90, water: 14 } });
        await assert.rejects(service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1),
            (e) => e.statusCode === 400 && /nhỏ hơn/.test(e.message));
    });

    test('I5: tiền phòng lấy rentPrice của HĐ, không lấy room.price', async () => {
        const out = setupGen({ contract: { rentPrice: 2500000, internetPrice: 0, cleaningPrice: 0 } });
        await service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1);
        assert.equal(out.payload.roomPrice, 2500000);
        assert.equal(out.payload.totalAmount, 2500000 + 50 * 3500 + 4 * 20000);
    });

    test('I5: HĐ cũ chưa có rentPrice thì fallback room.price', async () => {
        const out = setupGen({ contract: { rentPrice: null } });
        await service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1);
        assert.equal(out.payload.roomPrice, 3000000);
    });

    test('C3: kỳ sau endDate thì 400, kỳ chứa endDate vẫn xuất được', async () => {
        setupGen({ contract: { endDate: '2027-01-15' } });
        await assert.rejects(service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1),
            (e) => e.statusCode === 400 && /hết hạn/.test(e.message));
        setupGen({ contract: { endDate: '2027-02-15' } });
        await service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1);
    });

    // T2.3: tiền phòng tháng đầu/tháng cuối theo ngày, làm tròn tới 1.000đ.
    // Điện nước theo chỉ số, Internet và vệ sinh giữ nguyên cả tháng.
    const ELEC_WATER = 50 * 3500 + 4 * 20000;

    test('T2.3: mặc định (full) vào giữa tháng vẫn tính tròn tháng', async () => {
        const out = setupGen({ contract: { startDate: '2027-01-15' } });
        await service.generateInvoice({ roomId: 5, month: 1, year: 2027 }, 1);
        assert.equal(out.payload.roomPrice, 3000000);
        assert.equal(out.payload.prorated, false);
        assert.equal(out.payload.daysCharged, null);
    });

    test('T2.3: prorated tháng đầu tính từ startDate tới hết tháng, kể cả ngày vào', async () => {
        const out = setupGen({ contract: { firstLastMonthPolicy: 'prorated', startDate: '2027-01-15' } });
        await service.generateInvoice({ roomId: 5, month: 1, year: 2027 }, 1);
        // 3.000.000 × 17/31 = 1.645.161 → 1.645.000
        assert.equal(out.payload.roomPrice, 1645000);
        assert.equal(out.payload.prorated, true);
        assert.equal(out.payload.daysCharged, 17);
        assert.equal(out.payload.totalAmount, 1645000 + ELEC_WATER);
    });

    test('T2.3: prorated tháng cuối tính từ ngày 1 tới endDate', async () => {
        const out = setupGen({ contract: { firstLastMonthPolicy: 'prorated', startDate: '2026-01-01', endDate: '2027-02-10' } });
        await service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1);
        // 3.000.000 × 10/28 = 1.071.428 → 1.071.000
        assert.equal(out.payload.roomPrice, 1071000);
        assert.equal(out.payload.daysCharged, 10);
    });

    test('T2.3: prorated vào và ra cùng tháng', async () => {
        const out = setupGen({ contract: { firstLastMonthPolicy: 'prorated', startDate: '2027-02-05', endDate: '2027-02-20' } });
        await service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1);
        // 16/28 ngày → 1.714.285 → 1.714.000
        assert.equal(out.payload.roomPrice, 1714000);
        assert.equal(out.payload.daysCharged, 16);
    });

    test('T2.3: prorated nhưng tháng giữa hợp đồng thì tròn tháng', async () => {
        const out = setupGen({ contract: { firstLastMonthPolicy: 'prorated', startDate: '2027-01-01' } });
        await service.generateInvoice({ roomId: 5, month: 1, year: 2027 }, 1);
        assert.equal(out.payload.roomPrice, 3000000);
        assert.equal(out.payload.prorated, false);
    });

    test('T2.3: thanh lý giữa tháng (terminationDate) tính tới ngày trả phòng', async () => {
        const out = setupGen({ contract: { firstLastMonthPolicy: 'prorated', startDate: '2026-01-01' } });
        await service.generateInvoice({ roomId: 5, month: 2, year: 2027, terminationDate: '2027-02-10' }, 1);
        assert.equal(out.payload.roomPrice, 1071000);
        assert.equal(out.payload.daysCharged, 10);
    });

    test('T2.3: terminationDate sau endDate thì tính tới endDate', async () => {
        const out = setupGen({ contract: { firstLastMonthPolicy: 'prorated', startDate: '2026-01-01', endDate: '2027-02-10' } });
        await service.generateInvoice({ roomId: 5, month: 2, year: 2027, terminationDate: '2027-02-25' }, 1);
        assert.equal(out.payload.daysCharged, 10);
    });

    test('T2.3: policy full thì terminationDate không làm đổi tiền phòng', async () => {
        const out = setupGen({ contract: { startDate: '2026-01-01' } });
        await service.generateInvoice({ roomId: 5, month: 2, year: 2027, terminationDate: '2027-02-10' }, 1);
        assert.equal(out.payload.roomPrice, 3000000);
    });

    test('T2.3: Internet và vệ sinh không chia theo ngày', async () => {
        const out = setupGen({ contract: { firstLastMonthPolicy: 'prorated', startDate: '2027-01-15', internetPrice: 100000, cleaningPrice: 30000 } });
        await service.generateInvoice({ roomId: 5, month: 1, year: 2027 }, 1);
        assert.equal(out.payload.serviceTotal, 130000);
        assert.equal(out.payload.totalAmount, 1645000 + ELEC_WATER + 130000);
    });
});

const { Op } = require('sequelize');
const dayjs = require('dayjs');

describe('listInvoices / deleteInvoice (I1)', () => {
    const capture = () => {
        const out = {};
        stub(Invoice, 'findAll', async (opts) => { out.opts = opts; return []; });
        return out;
    };
    const buildingWhere = (opts) => opts.include.find(i => i.as === 'roomDetails').include.find(i => i.as === 'building').where;

    test('lọc theo chủ nhà qua include building, sắp xếp kỳ mới nhất trước', async () => {
        const out = capture();
        await service.listInvoices(1, { month: '10', year: '2026', buildingId: '4' });
        assert.deepEqual(buildingWhere(out.opts), { landlordId: 1, id: 4 });
        assert.equal(out.opts.where.month, 10);
        assert.equal(out.opts.where.year, 2026);
        assert.deepEqual(out.opts.order, [['year', 'DESC'], ['month', 'DESC']]);
        assert.ok(out.opts.include.some(i => i.as === 'tenant'));
    });

    test('status=overdue sinh điều kiện isPaid false và dueDate < hôm nay', async () => {
        const out = capture();
        await service.listInvoices(1, { status: 'overdue' });
        assert.equal(out.opts.where.isPaid, false);
        assert.equal(out.opts.where.dueDate[Op.lt], dayjs().format('YYYY-MM-DD'));
    });

    test('status=paid / unpaid lọc isPaid', async () => {
        const out = capture();
        await service.listInvoices(1, { status: 'paid' });
        assert.equal(out.opts.where.isPaid, true);
        await service.listInvoices(1, { status: 'unpaid' });
        assert.equal(out.opts.where.isPaid, false);
        assert.equal(out.opts.where.dueDate, undefined);
    });

    test('xóa hóa đơn đã thu thì 409, của chủ khác thì 404, chưa thu thì xóa', async () => {
        let destroyed = 0;
        const inv = (f) => ({ ...makeInvoice(f), async destroy() { destroyed++; } });
        stub(Invoice, 'findByPk', async () => inv({ isPaid: true }));
        await assert.rejects(service.deleteInvoice(3, 1), (e) => e.statusCode === 409);
        stub(Invoice, 'findByPk', async () => inv({ landlordId: 2, roomDetails: { building: { landlordId: 2 } } }));
        await assert.rejects(service.deleteInvoice(3, 1), (e) => e.statusCode === 404);
        stub(Invoice, 'findByPk', async () => inv());
        await service.deleteInvoice(3, 1);
        assert.equal(destroyed, 1);
    });

    test('không hủy xác nhận được hóa đơn đã cấn trừ tiền cọc', async () => {
        stub(Invoice, 'findByPk', async () => makeInvoice({ isPaid: true, paymentMethod: 'deposit' }));
        await assert.rejects(service.updatePaymentStatus(3, { isPaid: false }, 1), (e) => e.statusCode === 400);
    });
});

describe('generateInvoice: QR luôn dùng tài khoản hệ thống đã liên kết SePay', () => {
    const setupQr = (landlord) => {
        stub(Room, 'findByPk', async () => ({ id: 5, roomNumber: '101', price: 3000000, building: { landlordId: 1 } }));
        stub(Contract, 'findOne', async () => ({ id: 2, tenantId: 7, paymentDay: 5, electricityPrice: 0, waterPrice: 0, endDate: '2027-12-31' }));
        stub(Invoice, 'findOne', async () => null);
        stub(MeterReading, 'findOne', async () => ({ readingValue: 10 }));
        stub(Invoice, 'create', async (data) => record({ id: 11, ...data }));
        stub(User, 'findOne', async () => null);
        stub(User, 'findByPk', async () => landlord);
    };

    test('chủ nhà còn tài khoản cũ trong DB thì QR vẫn dùng tài khoản hệ thống', async () => {
        setupQr({ id: 1, bankId: 'VCB', bankAccount: '123456789' });
        const { systemBank } = require('../src/utils/bank');
        const res = await service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1);
        assert.ok(res.invoice.qrCode.includes(`acc=${systemBank().bankAccount}&`));
        assert.doesNotMatch(res.invoice.qrCode, /acc=123456789&/);
        assert.match(res.invoice.qrCode, /amount=3000000&/);
    });

    test('chủ nhà chưa cấu hình thì dùng tài khoản hệ thống (env)', async () => {
        setupQr({ id: 1, bankId: null, bankAccount: null });
        const { systemBank } = require('../src/utils/bank');
        const res = await service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1);
        assert.ok(res.invoice.qrCode.includes(`acc=${systemBank().bankAccount}&`));
    });
});

describe('Sửa lỗi B1-B3', () => {
    const setupGen = (contract = {}) => {
        stub(Room, 'findByPk', async () => ({ id: 5, roomNumber: '101', price: 3000000, building: { landlordId: 1 } }));
        stub(Contract, 'findOne', async () => ({
            id: 2, tenantId: 7, paymentDay: 30, electricityPrice: 0, waterPrice: 0,
            endDate: '2027-12-31', startDate: '2026-10-15', ...contract
        }));
        stub(Invoice, 'findOne', async () => null);
        stub(MeterReading, 'findOne', async () => ({ readingValue: 10 }));
        const out = {};
        stub(Invoice, 'create', async (data) => { out.payload = data; return record({ id: 11, ...data }); });
        stub(User, 'findOne', async () => null);
        return out;
    };

    test('B1: xác nhận tay với paidAmount < totalAmount thì 400, không lưu', async () => {
        const inv = makeInvoice();
        stub(Invoice, 'findByPk', async () => inv);
        await assert.rejects(service.updatePaymentStatus(3, { isPaid: true, paidAmount: 2000000 }, 1),
            (e) => e.statusCode === 400 && /ít hơn tổng tiền/.test(e.message));
        assert.equal(inv.saved, 0);
        assert.equal(inv.isPaid, false);
    });

    test('B2: kỳ trước tháng bắt đầu HĐ thì 400, tháng bắt đầu vẫn xuất được', async () => {
        setupGen();
        await assert.rejects(service.generateInvoice({ roomId: 5, month: 9, year: 2026 }, 1),
            (e) => e.statusCode === 400 && /trước ngày bắt đầu/.test(e.message));
        await service.generateInvoice({ roomId: 5, month: 10, year: 2026 }, 1);
    });

    test('B3: month/year không hợp lệ thì 400, chuỗi số được ép kiểu', async () => {
        for (const [month, year] of [[0, 2026], [13, 2026], [1.5, 2026], ['abc', 2026], [10, 'x'], [10, 2026.5], [undefined, 2026]]) {
            setupGen();
            await assert.rejects(service.generateInvoice({ roomId: 5, month, year }, 1),
                (e) => e.statusCode === 400 && /Tháng|Năm/.test(e.message), `${month}/${year}`);
        }
        const out = setupGen();
        await service.generateInvoice({ roomId: 5, month: '11', year: '2026' }, 1);
        assert.equal(out.payload.month, 11);
        assert.equal(out.payload.year, 2026);
    });
});

describe('Đợt 1: updatePaymentStatus kiểm tra quyền sở hữu trước (IDOR)', () => {
    test('chủ trọ khác gửi paidAmount thấp vẫn nhận 404, không lộ tổng tiền', async () => {
        stub(Invoice, 'findByPk', async () => makeInvoice({ landlordId: 1 }));
        await assert.rejects(
            service.updatePaymentStatus(3, { isPaid: true, paymentMethod: 'cash', paidAmount: 1 }, 2),
            (e) => e.statusCode === 404 && !/2500000/.test(e.message));
    });
});

describe('Đợt 1: getRevenueStats dùng tiền thực thu và đếm phòng', () => {
    test('totalCollected = paidAmount; hóa đơn cũ paidAmount 0 thì lấy totalAmount', async () => {
        stub(Invoice, 'findAll', async () => [
            { roomId: 1, totalAmount: 100, isPaid: true, paidAmount: 120 },
            { roomId: 2, totalAmount: 50, isPaid: true, paidAmount: 0 },
            { roomId: 3, totalAmount: 30, isPaid: false, paidAmount: 0 },
        ]);
        const res = await service.getRevenueStats(1, { month: 1, year: 2026 });
        assert.equal(res.stats.totalCollected, 170);
        assert.equal(res.stats.unpaidAmount, 30);
    });

    test('unpaidRooms đếm số phòng khác nhau, không đếm số hóa đơn', async () => {
        stub(Invoice, 'findAll', async () => [
            { roomId: 1, totalAmount: 10, isPaid: false, month: 1 },
            { roomId: 1, totalAmount: 10, isPaid: false, month: 2 },
            { roomId: 2, totalAmount: 10, isPaid: false, month: 2 },
        ]);
        const res = await service.getRevenueStats(1, { month: 'all', year: 2026 });
        assert.equal(res.stats.unpaidRooms, 2);
        assert.equal(res.stats.invoiceCount, 3);
    });

    test('T2.11: hóa đơn cấn trừ cọc tách riêng depositOffset, cashCollected chỉ là tiền thu thật', async () => {
        stub(Invoice, 'findAll', async () => [
            { roomId: 1, totalAmount: 100, isPaid: true, paidAmount: 100, paymentMethod: 'cash' },
            { roomId: 2, totalAmount: 40, isPaid: true, paidAmount: 40, paymentMethod: 'deposit' },
        ]);
        const res = await service.getRevenueStats(1, { month: 1, year: 2026 });
        assert.equal(res.stats.totalCollected, 140);
        assert.equal(res.stats.depositOffset, 40);
        assert.equal(res.stats.cashCollected, 100);
    });
});

describe('Đợt 1: gia hạn sớm vẫn xuất được hóa đơn tháng cuối của HĐ cũ', () => {
    test('kỳ thuộc HĐ cũ (renewed) thì dùng HĐ cũ, không báo "trước ngày bắt đầu"', async () => {
        const oldC = { id: 2, tenantId: 7, status: 'renewed', paymentDay: 30, electricityPrice: 3500, waterPrice: 20000,
            rentPrice: 2000000, startDate: '2026-02-01', endDate: '2027-01-31' };
        const newC = { ...oldC, id: 3, status: 'active', rentPrice: 2500000, startDate: '2027-02-01', endDate: '2028-01-31' };
        stub(Room, 'findByPk', async () => ({ id: 5, roomNumber: '101', price: 3000000, building: { landlordId: 1 } }));
        // Giả lập DB: truy vấn theo kỳ (status là điều kiện Op.in) trả HĐ phủ kỳ; truy vấn status='active' trả HĐ mới
        stub(Contract, 'findOne', async ({ where }) => (typeof where.status === 'object' ? oldC : newC));
        stub(Invoice, 'findOne', async () => null);
        stub(MeterReading, 'findOne', async ({ where }) => ({ readingValue: typeof where.period === 'object' ? 100 : 150 }));
        let payload;
        stub(Invoice, 'create', async (data) => { payload = data; return record({ id: 11, ...data }); });
        stub(User, 'findOne', async () => null);

        await service.generateInvoice({ roomId: 5, month: 1, year: 2027 }, 1);
        assert.equal(payload.contractId, 2);
        assert.equal(payload.roomPrice, 2000000);
    });
});

describe('Đợt 1: tạo hóa đơn nguyên tử, trùng kỳ trả 409', () => {
    const sequelize = require('../src/config/db');
    const setupDup = () => {
        stub(Room, 'findByPk', async () => ({ id: 5, roomNumber: '101', price: 3000000, building: { landlordId: 1 } }));
        stub(Contract, 'findOne', async () => ({ id: 2, tenantId: 7, paymentDay: 30, electricityPrice: 3500, waterPrice: 20000, endDate: '2027-12-31' }));
        stub(Invoice, 'findOne', async () => null);
        stub(MeterReading, 'findOne', async ({ where }) => ({ readingValue: typeof where.period === 'object' ? 100 : 150 }));
        stub(User, 'findOne', async () => null);
    };

    test('hai request đua nhau: lỗi unique của DB thành 409 tiếng Việt, không phải 500', async () => {
        setupDup();
        stub(sequelize, 'transaction', async (fn) => fn({}));
        stub(Invoice, 'create', async () => {
            const e = new Error('Duplicate entry');
            e.name = 'SequelizeUniqueConstraintError';
            throw e;
        });
        await assert.rejects(service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1),
            (e) => e.statusCode === 409 && /đã có hóa đơn/.test(e.message));
    });

    test('Invoice.create và lưu QR chạy trong cùng transaction', async () => {
        setupDup();
        const t = { id: 'tx' };
        let usedTx = false;
        stub(sequelize, 'transaction', async (fn) => { usedTx = true; return fn(t); });
        let createOpts, saveOpts;
        stub(Invoice, 'create', async (data, opts) => {
            createOpts = opts;
            return { id: 11, ...data, async save(o) { saveOpts = o; return this; } };
        });
        await service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1);
        assert.equal(usedTx, true);
        assert.equal(createOpts?.transaction, t);
        assert.equal(saveOpts?.transaction, t);
    });
});

describe('T1.5 & T2.2 & T2.4 & T2.6 (Nhóm B - invoiceService)', () => {
    test('T1.5: hủy xác nhận hóa đơn SePay không có cancelReason (>= 5 ký tự) thì chặn 409', async () => {
        const inv = makeInvoice({ isPaid: true, paymentMethod: 'sepay', paidAmount: 2500000 });
        stub(Invoice, 'findByPk', async () => inv);
        await assert.rejects(
            service.updatePaymentStatus(3, { isPaid: false }, 1),
            (e) => e.statusCode === 409 && /tối thiểu 5 ký tự/.test(e.message)
        );
        await assert.rejects(
            service.updatePaymentStatus(3, { isPaid: false, cancelReason: 'sai' }, 1),
            (e) => e.statusCode === 409 && /tối thiểu 5 ký tự/.test(e.message)
        );
    });

    test('T1.5: hủy xác nhận hóa đơn SePay có cancelReason hợp lệ thì ghi AdminLog INVOICE_SEPAY_UNPAID', async () => {
        const inv = makeInvoice({ isPaid: true, paymentMethod: 'sepay', paidAmount: 2500000, status: 'paid' });
        stub(Invoice, 'findByPk', async () => inv);
        let logged = null;
        stub(AdminLog, 'create', async (data) => { logged = data; return data; });

        await service.updatePaymentStatus(3, { isPaid: false, cancelReason: 'Đối soát nhầm giao dịch' }, 1);
        assert.equal(inv.isPaid, false);
        assert.equal(inv.status, 'unpaid');
        assert.ok(logged);
        assert.equal(logged.action, 'INVOICE_SEPAY_UNPAID');
    });

    test('T2.2: thanh toán một phần (partial) cập nhật paidAmount, status=partial, isPaid=false', async () => {
        const inv = makeInvoice({ totalAmount: 2500000, isPaid: false, paidAmount: 0, status: 'unpaid' });
        stub(Invoice, 'findByPk', async () => inv);

        await service.updatePaymentStatus(3, { isPaid: false, paidAmount: 1000000, paymentMethod: 'bank_transfer', allowPartial: true }, 1);
        assert.equal(inv.isPaid, false);
        assert.equal(inv.status, 'partial');
        assert.equal(inv.paidAmount, 1000000);
        assert.equal(inv.paymentMethod, 'bank_transfer');
    });

    test('T1.5: deleteInvoice chặn 409 khi paidAmount > 0 hoặc có giao dịch SePay 24h gần nhất, và gắn voided/deletedAt khi xóa', async () => {
        let destroyed = 0;
        const makeDelInv = (f = {}) => ({ ...makeInvoice(f), async destroy() { destroyed++; } });

        stub(Invoice, 'findByPk', async () => makeDelInv({ isPaid: false, paidAmount: 500000 }));
        await assert.rejects(service.deleteInvoice(3, 1), (e) => e.statusCode === 409);

        stub(Invoice, 'findByPk', async () => makeDelInv({ isPaid: false, paidAmount: 0 }));
        stub(SePayEvent, 'findOne', async () => ({ id: 99, invoiceId: 3 }));
        await assert.rejects(
            service.deleteInvoice(3, 1),
            (e) => e.statusCode === 409 && /Đang có giao dịch SePay liên quan đến hóa đơn này/.test(e.message)
        );

        const targetInv = makeDelInv({ isPaid: false, paidAmount: 0 });
        stub(Invoice, 'findByPk', async () => targetInv);
        stub(SePayEvent, 'findOne', async () => null);
        await service.deleteInvoice(3, 1);
        assert.equal(targetInv.status, 'voided');
        assert.ok(targetInv.deletedAt instanceof Date);
        assert.equal(destroyed, 1);
        assert.equal(Invoice.options?.paranoid, true, 'Invoice model must have paranoid: true for soft delete');
    });

    test('T2.4: generateInvoice khi MeterReading có meterReset=true tính tiêu thụ = readingValue (từ 0)', async () => {
        stub(Room, 'findByPk', async () => ({ id: 5, roomNumber: '101', price: 3000000, building: { landlordId: 1 } }));
        stub(Contract, 'findOne', async () => ({ id: 2, tenantId: 7, paymentDay: 30, electricityPrice: 3500, waterPrice: 20000, endDate: '2027-12-31' }));
        stub(Invoice, 'findOne', async () => null);
        stub(MeterReading, 'findOne', async ({ where }) => {
            const isPrev = typeof where.period === 'object';
            if (where.type === 'electricity') {
                return isPrev ? { readingValue: 500 } : { readingValue: 40, meterReset: true };
            }
            return isPrev ? { readingValue: 20 } : { readingValue: 25, meterReset: false };
        });
        let createdPayload = null;
        stub(Invoice, 'create', async (data) => { createdPayload = data; return record({ id: 11, ...data }); });
        stub(User, 'findOne', async () => null);

        await service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1);
        assert.equal(createdPayload.electricityOld, 0);
        assert.equal(createdPayload.electricityNew, 40);
        assert.equal(createdPayload.electricityTotal, 40 * 3500);
        assert.equal(createdPayload.waterTotal, 5 * 20000);
    });

    test('T2.6: generateInvoice nhận options.transaction thì dùng luôn và đăng ký Telegram vào afterCommit', async () => {
        stub(Room, 'findByPk', async () => ({ id: 5, roomNumber: '101', price: 3000000, building: { landlordId: 1 } }));
        stub(Contract, 'findOne', async () => ({ id: 2, tenantId: 7, paymentDay: 30, electricityPrice: 3500, waterPrice: 20000, endDate: '2027-12-31' }));
        stub(Invoice, 'findOne', async () => null);
        stub(MeterReading, 'findOne', async ({ where }) => ({ readingValue: typeof where.period === 'object' ? 100 : 120 }));
        stub(User, 'findOne', async () => ({ id: 7, telegramChatId: 'chat-7' }));

        let sentTele = 0;
        stub(telegramService, 'sendInvoiceToTelegram', async () => { sentTele++; });

        let newTxOpened = false;
        stub(sequelize, 'transaction', async () => { newTxOpened = true; });

        const afterCallbacks = [];
        const extTx = {
            id: 'ext-tx',
            afterCommit(cb) { afterCallbacks.push(cb); }
        };
        let createTx = null;
        stub(Invoice, 'create', async (data, opts) => {
            createTx = opts?.transaction;
            return record({ id: 11, ...data });
        });

        await service.generateInvoice({ roomId: 5, month: 2, year: 2027 }, 1, { transaction: extTx });
        assert.equal(newTxOpened, false);
        assert.equal(createTx, extTx);
        assert.equal(sentTele, 0);
        assert.equal(afterCallbacks.length, 1);
        await afterCallbacks[0]();
        assert.equal(sentTele, 1);
    });
});
