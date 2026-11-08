/**
 * Unit test chốt chỉ số (src/services/meterService.js) — stub model, không cần DB.
 * Chạy: npm test
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const MeterReading = require('../src/models/MeterReading');
const Room = require('../src/models/Room');
const Contract = require('../src/models/Contract');
const service = require('../src/services/meterService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const record = (fields) => ({ ...fields, async save() { return this; } });

// prev/next: { electricity, water } của kỳ liền trước / liền sau (null = không có)
const setup = ({ prev = { electricity: 100, water: 10 }, next = null, contract = null } = {}) => {
    const created = [];
    stub(Room, 'findByPk', async () => ({ id: 5, building: { landlordId: 1 } }));
    stub(Contract, 'findOne', async () => contract);
    stub(require('../src/models/Invoice'), 'findOne', async () => null);
    stub(MeterReading, 'findOne', async ({ where, order }) => {
        const src = order?.[0]?.[1] === 'DESC' ? prev : next;
        return src && src[where.type] !== undefined ? { readingValue: src[where.type] } : null;
    });
    stub(MeterReading, 'findOrCreate', async ({ defaults, transaction }) => {
        created.push({ ...defaults, _tx: transaction });
        return [record(defaults), true];
    });
    stub(sequelize, 'transaction', async (fn) => fn(TX));
    return created;
};
const sequelize = require('../src/config/db');
const TX = { id: 'tx' };
const call = (e, w) => service.updateRoomReadings(1, { roomId: 5, electricityValue: e, waterValue: w, period: '2026-10' });
const is400 = (re) => (err) => err.statusCode === 400 && (!re || re.test(err.message));

describe('updateRoomReadings (I6)', () => {
    test('giá trị âm, chuỗi không phải số, số lẻ thì 400', async () => {
        for (const [e, w] of [[-1, 12], ['abc', 12], [150, 1.5], ['', 12], [null, null]]) {
            setup();
            await assert.rejects(call(e, w), is400(), `${e}/${w}`);
        }
    });

    test('nhỏ hơn kỳ trước thì 400 kèm số cụ thể', async () => {
        setup();
        await assert.rejects(call(90, 12), is400(/Chỉ số điện mới \(90\) nhỏ hơn chỉ số kỳ trước \(100\)/));
    });

    test('không có kỳ trước thì so với chỉ số ban đầu của HĐ active', async () => {
        setup({ prev: null, contract: { initialElectricity: 200, initialWater: 5 } });
        await assert.rejects(call(150, 12), is400(/kỳ trước \(200\)/));
    });

    test('sửa kỳ cũ mà lớn hơn kỳ sau thì 400', async () => {
        setup({ next: { electricity: 120, water: 20 } });
        await assert.rejects(call(130, 12), is400(/kỳ sau \(120\)/));
    });

    test('hợp lệ thì gọi findOrCreate, chuỗi số được ép kiểu', async () => {
        const created = setup({ next: { electricity: 200, water: 20 } });
        await call('150', 12);
        assert.deepEqual(created.map(c => c.readingValue), [150, 12]);
    });
});

const Invoice = require('../src/models/Invoice');

describe('updateRoomReadings: chặn sửa mốc bàn giao (B2) và kỳ đã có hóa đơn (B4)', () => {
    test('B2: kỳ là mốc bàn giao isInitial=true thì 409, không ghi', async () => {
        const created = setup();
        stub(MeterReading, 'findOne', async ({ where }) => (where.isInitial ? { readingValue: 50, isInitial: true } : null));
        await assert.rejects(call(150, 12), (e) => e.statusCode === 409 && /bàn giao/.test(e.message));
        assert.equal(created.length, 0);
    });

    test('B4: kỳ đã có hóa đơn thì 409, không ghi', async () => {
        const created = setup();
        let where;
        stub(Invoice, 'findOne', async (q) => { where = q.where; return { id: 1 }; });
        await assert.rejects(call(150, 12),
            (e) => e.statusCode === 409 && e.message === 'Kỳ này đã có hóa đơn, hãy xóa hóa đơn trước khi sửa chỉ số');
        assert.deepEqual(where, { roomId: 5, month: 10, year: 2026 });
        assert.equal(created.length, 0);
    });
});

describe('T2.5: một transaction và kỳ nằm trong thời hạn HĐ', () => {
    const contract = { startDate: '2026-03-15', endDate: '2026-10-20', initialElectricity: 0, initialWater: 0 };

    test('ghi điện và nước cùng một transaction', async () => {
        const created = setup();
        await call(150, 12);
        assert.equal(created.length, 2);
        assert.ok(created.every(c => c._tx === TX), 'cả hai findOrCreate phải nhận transaction');
    });

    test('kỳ trước tháng bắt đầu HĐ thì 400, không ghi', async () => {
        const created = setup({ prev: null, contract });
        await assert.rejects(
            service.updateRoomReadings(1, { roomId: 5, electricityValue: 150, waterValue: 12, period: '2026-02' }),
            is400(/Kỳ 02\/2026 trước ngày bắt đầu hợp đồng \(15\/03\/2026\)/));
        assert.equal(created.length, 0);
    });

    test('kỳ sau tháng hết hạn HĐ thì 400, không ghi', async () => {
        const created = setup({ prev: null, contract });
        await assert.rejects(
            service.updateRoomReadings(1, { roomId: 5, electricityValue: 150, waterValue: 12, period: '2026-11' }),
            is400(/Kỳ 11\/2026 sau ngày hết hạn hợp đồng \(20\/10\/2026\)/));
        assert.equal(created.length, 0);
    });

    test('kỳ chứa ngày bắt đầu hoặc ngày hết hạn vẫn chốt được', async () => {
        for (const period of ['2026-03', '2026-10']) {
            const created = setup({ prev: null, contract });
            await service.updateRoomReadings(1, { roomId: 5, electricityValue: 150, waterValue: 12, period });
            assert.equal(created.length, 2, period);
        }
    });

    test('phòng không có HĐ active vẫn chốt được như cũ', async () => {
        const created = setup({ contract: null });
        await call(150, 12);
        assert.equal(created.length, 2);
    });
});

describe('Đợt 1: resolvePeriod không âm thầm đổi kỳ sai', () => {
    test('kỳ hợp lệ giữ nguyên', () => {
        assert.equal(service.resolvePeriod('2026-12'), '2026-12');
    });
    test('bỏ trống thì lấy tháng hiện tại', () => {
        assert.match(service.resolvePeriod(undefined), /^\d{4}-(0[1-9]|1[0-2])$/);
        assert.match(service.resolvePeriod(''), /^\d{4}-(0[1-9]|1[0-2])$/);
    });
    for (const bad of ['2026-13', '2026-00', '2026-1', '10/2026', 'abc']) {
        test(`kỳ sai "${bad}" ném 400`, () => {
            assert.throws(() => service.resolvePeriod(bad), (e) => e.statusCode === 400);
        });
    }
    test('updateRoomReadings với kỳ sai trả 400 trước khi ghi', async () => {
        const created = setup();
        await assert.rejects(
            service.updateRoomReadings(1, { roomId: 5, electricityValue: 200, waterValue: 20, period: '2026-13' }),
            (e) => e.statusCode === 400);
        assert.equal(created.length, 0);
    });
});

describe('T2.4 & T2.6 & T3.8 (Nhóm B - meterService)', () => {
    test('T2.4: validateReadingValue khi meterReset=false báo lỗi kèm hướng dẫn meterReset', () => {
        assert.throws(
            () => service.validateReadingValue(50, 'điện', 100, { meterReset: false }),
            (e) => e.statusCode === 400 && /meterReset/.test(e.message)
        );
    });

    test('T2.4: validateReadingValue khi meterReset=true bắt buộc resetReason >= 5 ký tự và cho phép số mới < số cũ', () => {
        assert.throws(
            () => service.validateReadingValue(10, 'điện', 100, { meterReset: true, resetReason: 'abc' }),
            (e) => e.statusCode === 400 && /tối thiểu 5 ký tự/.test(e.message)
        );
        const val = service.validateReadingValue(10, 'điện', 100, { meterReset: true, resetReason: 'Thay đồng hồ mới' });
        assert.equal(val, 10);
    });

    test('T2.4: updateRoomReadings hỗ trợ electricityReset/waterReset và lưu meterReset + resetReason', async () => {
        const created = setup({ prev: { electricity: 500, water: 50 } });
        await service.updateRoomReadings(1, {
            roomId: 5, electricityValue: 15, waterValue: 55, period: '2026-10',
            electricityReset: true, resetReason: 'Đồng hồ điện hỏng'
        });
        assert.equal(created.length, 2);
        const elec = created.find(c => c.type === 'electricity');
        assert.equal(elec.readingValue, 15);
        assert.equal(elec.meterReset, true);
        assert.equal(elec.resetReason, 'Đồng hồ điện hỏng');
    });

    test('T3.8: cho phép chốt riêng điện hoặc nước khi một trong hai là undefined/null', async () => {
        const createdElec = setup();
        await service.updateRoomReadings(1, { roomId: 5, electricityValue: 150, waterValue: null, period: '2026-10' });
        assert.equal(createdElec.length, 1);
        assert.equal(createdElec[0].type, 'electricity');

        const createdWater = setup();
        await service.updateRoomReadings(1, { roomId: 5, electricityValue: undefined, waterValue: 15, period: '2026-10' });
        assert.equal(createdWater.length, 1);
        assert.equal(createdWater[0].type, 'water');
    });

    test('T2.6: updateRoomReadings dùng options.transaction có sẵn thay vì mở transaction mới', async () => {
        const created = setup();
        let newTx = false;
        stub(sequelize, 'transaction', async () => { newTx = true; });
        const customTx = { id: 'custom-tx' };

        await service.updateRoomReadings(1, { roomId: 5, electricityValue: 150, waterValue: 15, period: '2026-10' }, { transaction: customTx });
        assert.equal(newTx, false);
        assert.ok(created.every(c => c._tx === customTx));
    });
});

describe('checkMeterAnomaly', () => {
    test('phát hiện chỉ số điện tăng đột biến > 150% so với trung bình', async () => {
        stub(MeterReading, 'findAll', async ({ where }) => {
            if (where.type === 'electricity') {
                return [
                    { readingValue: 300, period: '2026-09' },
                    { readingValue: 200, period: '2026-08' },
                    { readingValue: 100, period: '2026-07' }
                ];
            }
            return [];
        });

        const result = await service.checkMeterAnomaly(5, { electricityValue: 500, period: '2026-10' });
        assert.equal(result.isAbnormal, true);
        assert.equal(result.warnings.length, 1);
        assert.equal(result.warnings[0].type, 'electricity');
        assert.equal(result.warnings[0].currentUsage, 200);
        assert.equal(result.warnings[0].averageUsage, 100);
        assert.equal(result.warnings[0].percentIncrease, 100);
    });

    test('chỉ số bình thường không cảnh báo', async () => {
        stub(MeterReading, 'findAll', async () => [
            { readingValue: 300, period: '2026-09' },
            { readingValue: 200, period: '2026-08' },
            { readingValue: 100, period: '2026-07' }
        ]);

        const result = await service.checkMeterAnomaly(5, { electricityValue: 410, period: '2026-10' });
        assert.equal(result.isAbnormal, false);
        assert.equal(result.warnings.length, 0);
    });
});
