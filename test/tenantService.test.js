/**
 * Unit test khách thuê nhiều hợp đồng (src/services/tenantService.js) — stub model, không cần DB.
 * Chạy: npm test
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Contract = require('../src/models/Contract');
const User = require('../src/models/User');
const Invoice = require('../src/models/Invoice');
const SupportRequest = require('../src/models/SupportRequest');
const DepositRecord = require('../src/models/DepositRecord');
const service = require('../src/services/tenantService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const TENANT = 7;
const makeContract = (id, roomId, status, roomNumber) => ({
    id, roomId, status, startDate: '2026-01-01', endDate: '2026-12-31',
    room: { id: roomId, roomNumber, price: 3000000, building: { id: 1, name: 'Sunshine', address: 'HN', landlord: { name: 'Chủ' } } }
});

const baseStubs = (contracts, invoiceSpy = () => []) => {
    stub(User, 'findByPk', async () => ({ id: TENANT, name: 'Khách' }));
    stub(Contract, 'findAll', async ({ where }) => contracts.filter(c => !where.status || [].concat(where.status).includes(c.status)));
    stub(Invoice, 'findAll', async (opts) => invoiceSpy(opts));
    stub(SupportRequest, 'findAll', async () => []);
    // getDashboardSummary đọc lịch sử tiền cọc; không stub thì test gọi MySQL thật và fail.
    stub(DepositRecord, 'findAll', async () => []);
};

describe('getDashboardSummary', () => {
    test('trả về danh sách mọi phòng đang thuê/chờ ký để khách chọn', async () => {
        baseStubs([makeContract(1, 5, 'active', '101'), makeContract(2, 6, 'active', '202')]);
        const res = await service.getDashboardSummary(TENANT);
        assert.equal(res.contracts.length, 2);
        assert.deepEqual(res.contracts.map(c => c.roomNumber), ['101', '202']);
        assert.equal(res.contract.id, 1);
    });

    test('mỗi hợp đồng trong danh sách có roomId để báo sự cố đúng phòng (T2.14)', async () => {
        baseStubs([makeContract(1, 5, 'active', '101'), makeContract(2, 6, 'active', '202')]);
        const res = await service.getDashboardSummary(TENANT);
        assert.deepEqual(res.contracts.map(c => c.roomId), [5, 6]);
    });

    test('chọn đúng hợp đồng theo contractId', async () => {
        baseStubs([makeContract(1, 5, 'active', '101'), makeContract(2, 6, 'active', '202')]);
        const res = await service.getDashboardSummary(TENANT, 2);
        assert.equal(res.contract.id, 2);
        assert.equal(res.room.roomNumber, '202');
    });

    test('đang có bản gia hạn chờ ký: hiển thị hợp đồng active và báo có hợp đồng chờ ký', async () => {
        baseStubs([makeContract(1, 5, 'active', '101'), makeContract(3, 5, 'pending_tenant_signature', '101')]);
        const res = await service.getDashboardSummary(TENANT);
        assert.equal(res.contract.id, 1);
        assert.equal(res.hasActiveContract, true);
        assert.equal(res.pendingContractIds.length, 1);
    });

    test('hóa đơn lấy theo mọi hợp đồng của cùng phòng (gồm hợp đồng đã gia hạn)', async () => {
        let where = null;
        baseStubs(
            [makeContract(1, 5, 'renewed', '101'), makeContract(4, 5, 'active', '101')],
            (opts) => { where = opts.where; return []; }
        );
        await service.getDashboardSummary(TENANT);
        assert.deepEqual([...where.contractId].sort(), [1, 4]);
    });
});

describe('getInvoices', () => {
    test('trả hóa đơn của mọi hợp đồng của khách, không chỉ một hợp đồng active', async () => {
        let where = null;
        stub(Contract, 'findAll', async () => [{ id: 1 }, { id: 2 }, { id: 3 }]);
        stub(Invoice, 'findAll', async (opts) => { where = opts.where; return []; });
        await service.getInvoices(TENANT);
        assert.deepEqual(where.contractId, [1, 2, 3]);
    });
});

describe('getDashboardSummary: tiền cọc (C5)', () => {
    test('trả kèm contract.deposits', async () => {
        const DepositRecord = require('../src/models/DepositRecord');
        baseStubs([makeContract(1, 5, 'active', '101')]);
        let where = null;
        stub(DepositRecord, 'findAll', async (opts) => { where = opts.where; return [{ amount: 2000000, status: 'held' }]; });
        const res = await service.getDashboardSummary(TENANT);
        assert.deepEqual(where, { contractId: 1 });
        assert.equal(res.contract.deposits[0].status, 'held');
    });
});

describe('T2.8: khách xem hợp đồng đã thanh lý (terminated)', () => {
    test('lấy cả HĐ terminated trong danh sách contracts, ưu tiên active mặc định, trả đủ thông tin thanh lý khi chọn HĐ terminated', async () => {
        const termContract = {
            ...makeContract(1, 5, 'terminated', '101'),
            terminatedAt: '2026-10-31',
            finalElectricity: 250,
            finalWater: 30,
            terminationNote: 'Trả phòng đúng hạn',
            outstandingAmount: 500000,
        };
        const activeContract = makeContract(2, 6, 'active', '202');
        baseStubs([termContract, activeContract]);

        // Mặc định ưu tiên chọn HĐ active
        const defRes = await service.getDashboardSummary(TENANT);
        assert.equal(defRes.contract.id, 2);
        assert.equal(defRes.contracts.length, 2);
        assert.ok(defRes.contracts.some(c => c.id === 1 && c.status === 'terminated'));

        // Chọn xem HĐ đã thanh lý
        const termRes = await service.getDashboardSummary(TENANT, 1);
        assert.equal(termRes.contract.id, 1);
        assert.equal(termRes.contract.status, 'terminated');
        assert.equal(termRes.contract.terminatedAt, '2026-10-31');
        assert.equal(termRes.contract.finalElectricity, 250);
        assert.equal(termRes.contract.finalWater, 30);
        assert.equal(termRes.contract.terminationNote, 'Trả phòng đúng hạn');
        assert.equal(termRes.contract.outstandingAmount, 500000);
    });
});
