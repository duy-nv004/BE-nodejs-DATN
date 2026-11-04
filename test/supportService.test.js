/**
 * Unit test báo sự cố (src/services/supportService.js) — stub model, không cần DB.
 * Chạy: npm test
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const Contract = require('../src/models/Contract');
const Room = require('../src/models/Room');
const User = require('../src/models/User');
const SupportRequest = require('../src/models/SupportRequest');
const notificationService = require('../src/services/notificationService');
const service = require('../src/services/supportService');
const supportController = require('../src/controllers/supportController');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const captureCreate = () => {
    const box = {};
    stub(Contract, 'findOne', async () => ({ roomId: 5 }));
    stub(Contract, 'count', async () => 1);
    stub(Room, 'findByPk', async () => null);
    stub(SupportRequest, 'create', async (data) => { box.data = data; return { id: 1, ...data }; });
    return box;
};

describe('createTenantRequest (S1)', () => {
    test('lưu category và images dạng JSON', async () => {
        const box = captureCreate();
        await service.createTenantRequest(7, { description: 'Vòi rò', category: 'water', images: ['uploads/support/a.jpg'] });
        assert.equal(box.data.category, 'water');
        assert.equal(box.data.images, '["uploads/support/a.jpg"]');
    });

    test('category không hợp lệ thì 400', async () => {
        captureCreate();
        await assert.rejects(service.createTenantRequest(7, { description: 'x', category: 'abc' }), { statusCode: 400 });
    });

    test('không truyền category thì lưu other', async () => {
        const box = captureCreate();
        await service.createTenantRequest(7, { description: 'x' });
        assert.equal(box.data.category, 'other');
        assert.equal(box.data.images, '[]');
    });
});

describe('createTenantRequest: khách nhiều phòng (T2.14)', () => {
    test('có từ 2 hợp đồng active mà không chọn phòng thì 400', async () => {
        const box = captureCreate();
        stub(Contract, 'count', async () => 2);
        await assert.rejects(service.createTenantRequest(7, { description: 'x' }),
            (e) => e.statusCode === 400 && /chọn phòng/i.test(e.message));
        assert.equal(box.data, undefined);
    });

    test('chọn phòng thì gắn đúng phòng đó', async () => {
        const box = captureCreate();
        let where;
        stub(Contract, 'count', async () => 2);
        stub(Contract, 'findOne', async (opts) => { where = opts.where; return { roomId: 9 }; });
        await service.createTenantRequest(7, { description: 'x', roomId: '9' });
        assert.equal(where.roomId, 9);
        assert.equal(where.tenantId, 7);
        assert.equal(box.data.roomId, 9);
    });

    test('phòng không thuộc hợp đồng active của khách thì 400', async () => {
        captureCreate();
        stub(Contract, 'findOne', async () => null);
        await assert.rejects(service.createTenantRequest(7, { description: 'x', roomId: 99 }), { statusCode: 400 });
    });

    test('roomId không phải số nguyên dương thì 400', async () => {
        captureCreate();
        await assert.rejects(service.createTenantRequest(7, { description: 'x', roomId: 'abc' }), { statusCode: 400 });
    });
});

describe('getTenantRequests (T2.14)', () => {
    test('trả kèm phòng và tòa nhà để hiển thị "Phòng X - Tòa Y"', async () => {
        let opts;
        stub(SupportRequest, 'findAll', async (o) => { opts = o; return []; });
        await service.getTenantRequests(7);
        const room = (opts.include || []).find((i) => i.as === 'room');
        assert.ok(room, 'include room');
        assert.ok((room.include || []).some((i) => i.as === 'building'), 'include building');
    });
});

describe('model SupportRequest (S1)', () => {
    test('getter images luôn trả mảng', () => {
        assert.deepEqual(SupportRequest.build({ description: 'x' }).images, []);
        assert.deepEqual(SupportRequest.build({ description: 'x', images: '["uploads/support/a.jpg"]' }).images, ['uploads/support/a.jpg']);
    });
});

describe('updateRequestStatus (S1)', () => {
    const fakeRequest = () => {
        const r = { id: 3, tenantId: 7, description: 'Vòi rò nước', status: 'in_progress', saved: 0 };
        r.save = async () => { r.saved++; };
        return r;
    };

    test('gán landlordNote, repairCost và nối ghi chú vào thông báo', async () => {
        const r = fakeRequest();
        let content;
        stub(SupportRequest, 'findByPk', async () => r);
        stub(notificationService, 'createNotification', async (uid, title, c) => { content = c; });
        await service.updateRequestStatus(2, 3, { status: 'resolved', landlordNote: 'Đã thay vòi', repairCost: 150000 });
        assert.equal(r.status, 'resolved');
        assert.equal(r.landlordNote, 'Đã thay vòi');
        assert.equal(r.repairCost, 150000);
        assert.equal(r.saved, 1);
        assert.match(content, /Đã thay vòi/);
    });

    test('repairCost âm thì 400', async () => {
        stub(SupportRequest, 'findByPk', async () => fakeRequest());
        await assert.rejects(service.updateRequestStatus(2, 3, { status: 'resolved', repairCost: -1 }), { statusCode: 400 });
    });
});

describe('tenantController.createSupportRequest (S1)', () => {
    const fs = require('fs');
    const controller = require('../src/controllers/tenantController');
    const fakeRes = () => {
        const res = {};
        res.status = (c) => { res.statusCode = c; return res; };
        res.json = (b) => { res.body = b; return res; };
        return res;
    };

    test('truyền đường dẫn uploads/support/<file> cho service', async () => {
        let args;
        stub(service, 'createTenantRequest', async (id, data) => { args = [id, data]; return {}; });
        const res = fakeRes();
        await controller.createSupportRequest({ user: { id: 7 }, body: { description: 'x', category: 'water' }, files: [{ filename: 'a.jpg', path: 'uploads/support/a.jpg' }] }, res);
        assert.equal(res.statusCode, 201);
        assert.deepEqual(args[1].images, ['uploads/support/a.jpg']);
        assert.equal(args[1].category, 'water');
    });

    test('service lỗi thì xóa file vừa upload', async () => {
        const unlinked = [];
        stub(service, 'createTenantRequest', async () => { const e = new Error('Không có HĐ'); e.statusCode = 400; throw e; });
        stub(fs, 'unlink', (p, cb) => { unlinked.push(p); cb && cb(); });
        const res = fakeRes();
        await controller.createSupportRequest({ user: { id: 7 }, body: { description: 'x' }, files: [{ filename: 'a.jpg', path: 'uploads/support/a.jpg' }] }, res);
        assert.equal(res.statusCode, 400);
        assert.deepEqual(unlinked, ['uploads/support/a.jpg']);
    });
});

// R4: ảnh sự cố không còn phục vụ công khai — chỉ khách tạo yêu cầu hoặc chủ nhà
// sở hữu tòa nhà được tải, và tên file phải đúng dạng do multer sinh ra.
describe('getRequestImageName (R4)', () => {
    const FILE = '1700000000000-11111111-2222-3333-4444-555555555555.png';
    const REQUEST = { id: 9, tenantId: 7, images: [`uploads/support/${FILE}`] };
    const withRequest = (request = REQUEST) => stub(SupportRequest, 'findByPk', async () => request);

    test('khách tạo yêu cầu tải được ảnh của mình', async () => {
        withRequest();
        assert.equal(await service.getRequestImageName({ id: 7 }, 9, FILE), FILE);
    });

    test('chủ nhà sở hữu tòa nhà của phòng tải được ảnh', async () => {
        withRequest({ ...REQUEST, room: { building: { landlordId: 2 } } });
        assert.equal(await service.getRequestImageName({ id: 2 }, 9, FILE), FILE);
    });

    test('người không liên quan bị 404', async () => {
        withRequest({ ...REQUEST, room: { building: { landlordId: 2 } } });
        await assert.rejects(service.getRequestImageName({ id: 99 }, 9, FILE), { statusCode: 404 });
    });

    test('tên file sai dạng hoặc chứa đường dẫn thì 404', async () => {
        withRequest();
        const bad = [
            '../.env',
            '..\secret.png',
            'abc.png',
            `${'a'.repeat(60)}.png`,
            `${FILE}/../../x.png`,
            '',
            null,
        ];
        for (const name of bad) {
            await assert.rejects(service.getRequestImageName({ id: 7 }, 9, name), { statusCode: 404 });
        }
    });

    test('ảnh không thuộc yêu cầu này thì 404', async () => {
        withRequest();
        await assert.rejects(
            service.getRequestImageName({ id: 7 }, 9, '1700000000000-99999999-2222-3333-4444-555555555555.png'),
            { statusCode: 404 }
        );
    });

    test('yêu cầu không tồn tại thì 404', async () => {
        withRequest(null);
        await assert.rejects(service.getRequestImageName({ id: 7 }, 404, FILE), { statusCode: 404 });
    });
});

// F2: chỉ cho phép chuyển trạng thái tiến lên; cùng trạng thái thì không lưu, không thông báo.
describe('updateRequestStatus chuyển trạng thái (F2)', () => {
    const withStatus = (status) => {
        const r = { id: 3, tenantId: 7, description: 'Vòi rò nước', status, saved: 0 };
        r.save = async () => { r.saved++; };
        stub(SupportRequest, 'findByPk', async () => r);
        const sent = [];
        stub(notificationService, 'createNotification', async (...a) => { sent.push(a); });
        return { r, sent };
    };

    for (const [from, to] of [['pending', 'in_progress'], ['pending', 'resolved'], ['in_progress', 'resolved']]) {
        test(`${from} -> ${to} hợp lệ`, async () => {
            const { r, sent } = withStatus(from);
            await service.updateRequestStatus(2, 3, { status: to });
            assert.equal(r.status, to);
            assert.equal(r.saved, 1);
            assert.equal(sent.length, 1);
        });
    }

    for (const [from, to] of [['resolved', 'in_progress'], ['resolved', 'pending'], ['in_progress', 'pending']]) {
        test(`${from} -> ${to} bị 400`, async () => {
            const { r, sent } = withStatus(from);
            await assert.rejects(service.updateRequestStatus(2, 3, { status: to }), { statusCode: 400 });
            assert.equal(r.status, from);
            assert.equal(r.saved, 0);
            assert.equal(sent.length, 0);
        });
    }

    test('cùng trạng thái thì không lưu, không thông báo', async () => {
        const { r, sent } = withStatus('resolved');
        const result = await service.updateRequestStatus(2, 3, { status: 'resolved' });
        assert.equal(r.saved, 0);
        assert.equal(sent.length, 0);
        assert.equal(result.supportRequest, r);
    });
});

describe('T2.13 & T2.17: escapeTelegramMarkdown, gửi Telegram và cập nhật nguyên tử', () => {
    test('escapeTelegramMarkdown escape các ký tự đặc biệt Markdown', () => {
        assert.equal(typeof service.escapeTelegramMarkdown, 'function');
        assert.equal(
            service.escapeTelegramMarkdown('Phòng_101 *VIP* [A] `code`'),
            'Phòng\\_101 \\*VIP\\* \\[A\\] \\`code\\`'
        );
    });

    test('createTenantRequest tự động gửi Telegram kèm inline keyboard cho chủ nhà có telegramChatId', async () => {
        stub(Contract, 'findOne', async () => ({ roomId: 5 }));
        stub(Contract, 'count', async () => 1);
        stub(SupportRequest, 'create', async (data) => ({ id: 88, ...data }));
        stub(Room, 'findByPk', async () => ({
            roomNumber: '101_A',
            building: { name: 'Tòa *Sao*', landlordId: 2, landlord: { id: 2, telegramChatId: '555666' } }
        }));
        stub(User, 'findByPk', async (id) => (id === 7 ? { id: 7, name: 'Khách A' } : { id: 2, telegramChatId: '555666' }));
        stub(notificationService, 'createNotification', async () => {});
        const telegramPayloads = [];
        stub(axios, 'post', async (url, payload) => { telegramPayloads.push(payload); return {}; });

        await service.createTenantRequest(7, { description: 'Hỏng_đèn *nặng*', category: 'electric' });

        assert.equal(telegramPayloads.length, 1);
        assert.equal(telegramPayloads[0].chat_id, '555666');
        assert.ok(telegramPayloads[0].text.includes('101\\_A'));
        assert.ok(telegramPayloads[0].text.includes('Tòa \\*Sao\\*'));
        assert.ok(telegramPayloads[0].text.includes('Hỏng\\_đèn \\*nặng\\*'));
        assert.ok(telegramPayloads[0].reply_markup?.inline_keyboard);
    });

    test('updateRequestStatus cập nhật nguyên tử: affectedRows === 0 thì chặn gửi thông báo trùng', async () => {
        const r = {
            id: 3, tenantId: 7, description: 'Vòi rò nước', status: 'pending',
            tenant: { id: 7, telegramChatId: '777888' }
        };
        stub(SupportRequest, 'findByPk', async () => r);
        let updateArgs;
        stub(SupportRequest, 'update', async (fields, opts) => {
            updateArgs = [fields, opts];
            return [0]; // Người khác đã bấm trước
        });
        const webNotifs = [];
        stub(notificationService, 'createNotification', async (...a) => { webNotifs.push(a); });
        const tgNotifs = [];
        stub(axios, 'post', async (url, payload) => { tgNotifs.push(payload); return {}; });

        await service.updateRequestStatus(2, 3, { status: 'in_progress' });

        assert.deepEqual(updateArgs[1].where, { id: 3, status: 'pending' });
        assert.equal(webNotifs.length, 0);
        assert.equal(tgNotifs.length, 0);
    });

    test('updateRequestStatus gửi Telegram cho khách thuê kèm trạng thái, ghi chú và chi phí sửa chữa', async () => {
        const r = {
            id: 3, tenantId: 7, description: 'Vòi_rò', status: 'in_progress',
            tenant: { id: 7, telegramChatId: '777888' }
        };
        stub(SupportRequest, 'findByPk', async () => r);
        stub(SupportRequest, 'update', async () => [1]);
        stub(notificationService, 'createNotification', async () => {});
        const tgNotifs = [];
        stub(axios, 'post', async (url, payload) => { tgNotifs.push(payload); return {}; });

        await service.updateRequestStatus(2, 3, {
            status: 'resolved',
            landlordNote: 'Đã thay_vòi mới',
            repairCost: 250000
        });

        assert.equal(tgNotifs.length, 1);
        assert.equal(tgNotifs[0].chat_id, '777888');
        assert.match(tgNotifs[0].text, /Vòi\\_rò/);
        assert.match(tgNotifs[0].text, /Đã thay\\_vòi mới/);
        assert.match(tgNotifs[0].text, /250[.,]000/);
    });
});

describe('T3.1: getLandlordRequests lọc và phân trang tùy chọn', () => {
    test('không truyền page thì trả mảng như cũ', async () => {
        const mockList = [{ id: 1 }, { id: 2 }];
        stub(SupportRequest, 'findAll', async () => mockList);
        const res = await service.getLandlordRequests(2);
        assert.ok(Array.isArray(res));
        assert.equal(res.length, 2);
    });

    test('truyền page và bộ lọc (status, severity, category, buildingId) thì trả object phân trang', async () => {
        let capturedOpts;
        stub(SupportRequest, 'findAndCountAll', async (opts) => {
            capturedOpts = opts;
            return { count: 15, rows: [{ id: 5 }] };
        });

        const res = await service.getLandlordRequests(2, {
            status: 'pending',
            severity: 'high',
            category: 'electric',
            buildingId: '10',
            page: '2',
            pageSize: '5'
        });

        assert.equal(capturedOpts.where.status, 'pending');
        assert.equal(capturedOpts.where.severity, 'high');
        assert.equal(capturedOpts.where.category, 'electric');
        assert.equal(capturedOpts.include[0].include[0].where.landlordId, 2);
        assert.equal(capturedOpts.include[0].include[0].where.id, 10);
        assert.equal(capturedOpts.limit, 5);
        assert.equal(capturedOpts.offset, 5);
        assert.deepEqual(res, {
            items: [{ id: 5 }],
            total: 15,
            page: 2,
            pageSize: 5,
            totalPages: 3
        });
    });

    test('supportController.getLandlordRequests truyền req.query xuống service', async () => {
        let args;
        stub(service, 'getLandlordRequests', async (...a) => { args = a; return { items: [], total: 0, page: 1, pageSize: 10, totalPages: 0 }; });
        let jsonBody;
        const req = { user: { id: 2 }, query: { page: '1', status: 'pending' } };
        const res = { status: () => res, json: (b) => { jsonBody = b; } };
        await supportController.getLandlordRequests(req, res);
        assert.deepEqual(args, [2, { page: '1', status: 'pending' }]);
        assert.equal(jsonBody.page, 1);
    });
});
