/**
 * Unit test cho tool "tạo phòng" của chatbot (src/services/chatTools.js) — không cần DB.
 * Chạy: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { CHAT_TOOLS, validateToolCall, executeTool } = require('../src/services/chatTools');

const landlord = { id: 3, roleData: { name: 'landlord' } };
const tenant = { id: 7, roleData: { name: 'tenant' } };

const validParams = { buildingId: 1, roomNumber: '101', price: 3500000, capacity: 2, area: 20 };

const expectStatus = (fn, status) =>
    assert.throws(fn, (err) => err.statusCode === status);

describe('CHAT_TOOLS registry', () => {
    test('có tool create_room, chỉ landlord được phép', () => {
        assert.ok(CHAT_TOOLS.create_room, 'thiếu tool create_room');
        assert.deepEqual(CHAT_TOOLS.create_room.allowedRoles, ['landlord']);
    });

    test('mô tả tool có đủ tham số cho AI function calling', () => {
        const fn = CHAT_TOOLS.create_room.spec.function;
        assert.ok(fn.description);
        assert.equal(fn.name, 'create_room');
        assert.ok(fn.parameters.properties.roomNumber);
        assert.ok(fn.parameters.properties.buildingId);
        assert.ok(fn.parameters.properties.price);
    });
});

describe('validateToolCall', () => {
    test('tool lạ -> 400', () => {
        expectStatus(() => validateToolCall('delete_everything', {}, landlord), 400);
        expectStatus(() => validateToolCall(undefined, {}, landlord), 400);
    });

    test('tenant/admin không được gọi create_room -> 403', () => {
        expectStatus(() => validateToolCall('create_room', validParams, tenant), 403);
        expectStatus(() => validateToolCall('create_room', validParams, { id: 1, roleData: { name: 'admin' } }), 403);
        expectStatus(() => validateToolCall('create_room', validParams, {}), 403);
    });

    test('thiếu tham số bắt buộc -> 400 (validate nằm trong tool.run)', async () => {
        const service = { createRoom: async () => ({ roomNumber: 'x' }) };
        for (const missing of ['roomNumber', 'buildingId', 'price']) {
            await assert.rejects(() => executeTool(landlord, 'create_room', { ...validParams, [missing]: undefined }, { service }),
                (e) => e.statusCode === 400);
        }
    });

    test('tham số hợp lệ -> không ném lỗi', () => {
        assert.doesNotThrow(() => validateToolCall('create_room', validParams, landlord));
    });
});

describe('executeTool', () => {
    test('gọi service đúng (landlordId, params) và trả kết quả', async () => {
        let called;
        const service = { createRoom: async (landlordId, params) => { called = [landlordId, params]; return { id: 9, ...params }; } };
        const result = await executeTool(landlord, 'create_room', validParams, { service });

        assert.deepEqual(called, [3, validParams]);
        assert.equal(result.room.id, 9);
        assert.match(result.message, /101/);
    });

    test('role sai -> 403, service KHÔNG được gọi', async () => {
        let called = false;
        const service = { createRoom: async () => { called = true; } };
        await assert.rejects(() => executeTool(tenant, 'create_room', validParams, { service }),
            (err) => err.statusCode === 403);
        assert.equal(called, false);
    });

    test('service ném lỗi có statusCode -> pass through cho controller', async () => {
        const service = { createRoom: async () => { const e = new Error('Tòa nhà không tồn tại'); e.statusCode = 404; throw e; } };
        await assert.rejects(() => executeTool(landlord, 'create_room', validParams, { service }),
            (err) => err.statusCode === 404);
    });
});

// ═══ Mở rộng: đầy đủ tác vụ thêm/xóa/sửa, phân quyền theo vai trò ═══
const { toolsForUser } = require('../src/services/chatTools');

describe('tool mở rộng', () => {
    test('landlord có đủ tool quản lý; tenant chỉ có tool của mình; admin không có gì', () => {
        const landlordTools = toolsForUser(landlord).map((t) => t.function.name);
        for (const expected of ['create_room', 'update_room', 'delete_room', 'create_building', 'delete_building',
            'update_meter_readings', 'generate_invoice', 'update_invoice_payment',
            'cancel_contract', 'terminate_contract', 'update_support_status']) {
            assert.ok(landlordTools.includes(expected), `thiếu tool ${expected}`);
        }
        const tenantTools = toolsForUser(tenant).map((t) => t.function.name);
        assert.deepEqual(tenantTools, ['create_support_request']);
        assert.deepEqual(toolsForUser({ id: 1, roleData: { name: 'admin' } }), []);
    });

    test('create_building: cần name + address trong spec và khi chạy', async () => {
        assert.deepEqual(CHAT_TOOLS.create_building.spec.function.parameters.required, ['name', 'address']);
        let called;
        const service = { createBuilding: async (id, p) => { called = [id, p]; return { id: 5, name: p.name }; } };
        const r = await executeTool(landlord, 'create_building', { name: 'Tòa A', address: '12 Láng Hạ' }, { service });
        assert.deepEqual(called, [3, { name: 'Tòa A', address: '12 Láng Hạ' }]);
        assert.match(r.message, /Tòa A/);
        await assert.rejects(() => executeTool(landlord, 'create_building', { name: 'Tòa A' }, { service }),
            (e) => e.statusCode === 400);
    });

    test('update_room: cần roomId; truyền đủ tham số', async () => {
        let called;
        const service = { updateRoom: async (id, roomId, p) => { called = [id, roomId, p]; return { id: roomId, roomNumber: '105' }; } };
        const r = await executeTool(landlord, 'update_room', { roomId: 7, price: 4000000 }, { service });
        assert.deepEqual(called, [3, 7, { price: 4000000 }]);
        assert.match(r.message, /105/);
        await assert.rejects(() => executeTool(landlord, 'update_room', { price: 4 }, { service }),
            (e) => e.statusCode === 400);
    });

    test('delete_room và delete_building: cần id; message xác nhận từ service', async () => {
        const service = { deleteRoom: async () => ({ message: 'Xóa phòng trọ thành công' }) };
        const r = await executeTool(landlord, 'delete_room', { roomId: 7 }, { service });
        assert.match(r.message, /Xóa phòng/);
        await assert.rejects(() => executeTool(landlord, 'delete_room', {}, { service }),
            (e) => e.statusCode === 400);
    });

    test('T1.10 & T3.8: update_meter_readings cho phép chốt riêng điện hoặc nước và validate period YYYY-MM', async () => {
        assert.deepEqual(CHAT_TOOLS.update_meter_readings.spec.function.parameters.required, ['roomId']);
        let called;
        const service = { updateRoomReadings: async (id, p) => { called = [id, p]; return { id: 1 }; } };
        await executeTool(landlord, 'update_meter_readings',
            { roomId: 7, electricityValue: 10500, waterValue: 130, period: '2026-10' }, { service });
        assert.deepEqual(called[1], { roomId: 7, electricityValue: 10500, waterValue: 130, period: '2026-10' });

        // Chốt riêng chỉ số điện
        await executeTool(landlord, 'update_meter_readings',
            { roomId: 7, electricityValue: 10600 }, { service });
        assert.deepEqual(called[1], { roomId: 7, electricityValue: 10600 });

        // Chốt riêng chỉ số nước
        await executeTool(landlord, 'update_meter_readings',
            { roomId: 7, waterValue: 140 }, { service });
        assert.deepEqual(called[1], { roomId: 7, waterValue: 140 });

        // Thiếu cả điện và nước -> 400
        await assert.rejects(() => executeTool(landlord, 'update_meter_readings', { roomId: 7 }, { service }),
            (e) => e.statusCode === 400);

        // Sai định dạng period -> 400
        for (const badPeriod of ['2026-13', '2026-00', '10/2026', 'abc']) {
            await assert.rejects(
                () => executeTool(landlord, 'update_meter_readings', { roomId: 7, electricityValue: 100, period: badPeriod }, { service }),
                (e) => e.statusCode === 400
            );
        }
    });

    test('generate_invoice: cần roomId + tháng/năm hợp lệ', async () => {
        let called;
        const service = { generateInvoice: async (p, id) => { called = [p, id]; return { id: 3, roomId: p.roomId }; } };
        const r = await executeTool(landlord, 'generate_invoice', { roomId: 7, month: 10, year: 2026 }, { service });
        assert.deepEqual(called, [{ roomId: 7, month: 10, year: 2026 }, 3]);
        assert.ok(r.message);
        await assert.rejects(() => executeTool(landlord, 'generate_invoice', { roomId: 7, month: 13, year: 2026 }, { service }),
            (e) => e.statusCode === 400);
        await assert.rejects(() => executeTool(landlord, 'generate_invoice', { roomId: 7 }, { service }),
            (e) => e.statusCode === 400);
    });

    test('update_invoice_payment: cần invoiceId + isPaid boolean', async () => {
        let called;
        const service = { updatePaymentStatus: async (invoiceId, p, id) => { called = [invoiceId, p, id]; return { id: invoiceId }; } };
        const r = await executeTool(landlord, 'update_invoice_payment', { invoiceId: 3, isPaid: true }, { service });
        assert.deepEqual(called, [3, { isPaid: true }, 3]);
        assert.ok(r.message);
        await assert.rejects(() => executeTool(landlord, 'update_invoice_payment', { invoiceId: 3, isPaid: 'yes' }, { service }),
            (e) => e.statusCode === 400);
    });

    test('cancel_contract / terminate_contract: cần contractId', async () => {
        let calls = [];
        const service = {
            cancelContractByLandlord: async (id, cid) => { calls.push(['cancel', id, cid]); return { message: 'Hủy ok' }; },
            terminateContract: async (id, cid) => { calls.push(['term', id, cid]); return { message: 'Thanh lý ok' }; },
        };
        const r1 = await executeTool(landlord, 'cancel_contract', { contractId: 4 }, { service });
        assert.match(r1.message, /Hủy/);
        const r2 = await executeTool(landlord, 'terminate_contract', { contractId: 4 }, { service });
        assert.match(r2.message, /Thanh lý/);
        await assert.rejects(() => executeTool(landlord, 'cancel_contract', {}, { service }),
            (e) => e.statusCode === 400);
    });

    test('terminate_contract: spec có tham số quyết toán tùy chọn, chỉ contractId bắt buộc', () => {
        const fn = CHAT_TOOLS.terminate_contract.spec.function;
        for (const p of ['finalElectricity', 'finalWater', 'terminationDate', 'damageAmount', 'forfeitDeposit', 'note']) {
            assert.ok(fn.parameters.properties[p], `thiếu tham số ${p}`);
        }
        assert.deepEqual(fn.parameters.required, ['contractId']);
    });

    test('terminate_contract: truyền chỉ số cuối, ngày, hư hỏng, mất cọc, ghi chú xuống service', async () => {
        let called;
        const service = { terminateContract: async (id, cid, body) => { called = [id, cid, body]; return { message: 'Thanh lý ok' }; } };
        await executeTool(landlord, 'terminate_contract', {
            contractId: 4, finalElectricity: 15000, finalWater: 130,
            terminationDate: '2026-10-31', damageAmount: 200000, forfeitDeposit: true, note: 'Khách trả phòng sớm'
        }, { service });
        assert.deepEqual(called, [3, 4, {
            finalElectricity: 15000, finalWater: 130, terminationDate: '2026-10-31',
            damageAmount: 200000, forfeit: true, note: 'Khách trả phòng sớm'
        }]);
    });

    test('terminate_contract: chỉ gửi contractId -> body rỗng', async () => {
        let called;
        const service = { terminateContract: async (id, cid, body) => { called = [id, cid, body]; return { message: 'Thanh lý ok' }; } };
        await executeTool(landlord, 'terminate_contract', { contractId: 4 }, { service });
        assert.deepEqual(called[2], {});
    });

    test('terminate_contract: thiếu chỉ số cuối -> trả lời hỏi chủ nhà, không ném lỗi', async () => {
        const service = {
            terminateContract: async () => {
                const e = new Error('Chưa có hóa đơn tháng 10/2026: vui lòng nhập chỉ số cuối điện và nước');
                e.statusCode = 400;
                e.code = 'FINAL_READINGS_REQUIRED';
                throw e;
            }
        };
        const r = await executeTool(landlord, 'terminate_contract', { contractId: 4 }, { service });
        assert.equal(r.needsFinalReadings, true);
        assert.match(r.message, /chỉ số điện/i);
        assert.match(r.message, /chỉ số nước/i);
        assert.match(r.message, /vui lòng cho tôi biết/i);
    });

    test('terminate_contract: lỗi 400 khác (vượt cọc) vẫn ném ra cho controller', async () => {
        const service = {
            terminateContract: async () => {
                const e = new Error('Công nợ 3.000.000 đ vượt tiền cọc 2.000.000 đ, yêu cầu khách thanh toán trước khi thanh lý');
                e.statusCode = 400;
                throw e;
            }
        };
        await assert.rejects(() => executeTool(landlord, 'terminate_contract', { contractId: 4 }, { service }),
            (e) => e.statusCode === 400);
    });

    test('update_support_status: cần requestId + status hợp lệ', async () => {
        let called;
        const service = { updateRequestStatus: async (id, rid, p) => { called = [id, rid, p]; return { id: rid }; } };
        const r = await executeTool(landlord, 'update_support_status', { requestId: 6, status: 'in_progress' }, { service });
        assert.deepEqual(called, [3, 6, { status: 'in_progress' }]);
        assert.ok(r.message);
        await assert.rejects(() => executeTool(landlord, 'update_support_status', { requestId: 6, status: 'done' }, { service }),
            (e) => e.statusCode === 400);
    });

    test('create_support_request: chỉ tenant, cần description, severity enum', async () => {
        let called;
        const service = { createTenantRequest: async (id, p) => { called = [id, p]; return { message: 'Gửi báo cáo sự cố thành công', supportRequest: { id: 8, description: p.description } }; } };
        const r = await executeTool(tenant, 'create_support_request', { description: 'Đèn hỏng', severity: 'low' }, { service });
        assert.deepEqual(called, [7, { description: 'Đèn hỏng', severity: 'low' }]);
        assert.match(r.message, /thành công/i);
        // severity lạ -> tool tự chuẩn hóa về medium, không ném
        await assert.doesNotReject(() => executeTool(tenant, 'create_support_request', { description: 'x', severity: 'urgent' }, { service }));
        await assert.rejects(() => executeTool(landlord, 'create_support_request', { description: 'x' }, { service }),
            (e) => e.statusCode === 403);
    });

    test('D7: create_support_request nhận roomId tùy chọn và truyền xuống service', async () => {
        assert.ok(CHAT_TOOLS.create_support_request.spec.function.parameters.properties.roomId);
        let called;
        const service = { createTenantRequest: async (id, p) => { called = [id, p]; return { message: 'ok', supportRequest: { id: 8 } }; } };
        await executeTool(tenant, 'create_support_request', { description: 'Đèn hỏng', roomId: 12 }, { service });
        assert.deepEqual(called, [7, { description: 'Đèn hỏng', severity: 'medium', roomId: 12 }]);
    });
});
