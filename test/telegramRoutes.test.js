/**
 * Unit test webhook Telegram (src/routes/telegramRoutes.js) — stub model + axios, không cần DB.
 * Chạy: node --test test/telegramRoutes.test.js
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const User = require('../src/models/User');
const Contract = require('../src/models/Contract');
const Room = require('../src/models/Room');
const SupportRequest = require('../src/models/SupportRequest');
const supportService = require('../src/services/supportService');
const router = require('../src/routes/telegramRoutes');

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

const webhook = router.stack.find(l => l.route?.path === '/webhook').route.stack[0].handle;
const call = async (body, headers = {}) => {
    const res = {};
    res.status = (c) => { res.statusCode = c; return res; };
    res.send = (b) => { res.body = b; return res; };
    await webhook({ body, headers }, res);
    return res;
};
const devEnv = () => {
    setEnv('TELEGRAM_WEBHOOK_SECRET', undefined);
    setEnv('NODE_ENV', 'development');
};
const captureMessages = () => {
    const sent = [];
    stub(axios, 'post', async (url, payload) => { sent.push(payload); return {}; });
    return sent;
};

describe('xác thực webhook (F3)', () => {
    test('production thiếu TELEGRAM_WEBHOOK_SECRET thì 401', async () => {
        setEnv('TELEGRAM_WEBHOOK_SECRET', undefined);
        setEnv('NODE_ENV', 'production');
        let touched = false;
        stub(User, 'findOne', async () => { touched = true; return null; });
        captureMessages();
        const res = await call({ message: { chat: { id: 1 }, text: '/menu' } });
        assert.equal(res.statusCode, 401);
        assert.equal(touched, false);
    });

    test('dev thiếu secret vẫn xử lý', async () => {
        devEnv();
        captureMessages();
        stub(User, 'findOne', async () => null);
        const res = await call({ message: { chat: { id: 1 }, text: '/menu' } });
        assert.equal(res.statusCode, 200);
    });

    test('sai secret thì 401', async () => {
        setEnv('TELEGRAM_WEBHOOK_SECRET', 's3cret');
        const res = await call({}, { 'x-telegram-bot-api-secret-token': 'nope' });
        assert.equal(res.statusCode, 401);
    });
});

describe('báo hỏng qua Telegram đi qua supportService (F1)', () => {
    const tenantSetup = () => {
        devEnv();
        const sent = captureMessages();
        stub(User, 'findOne', async () => ({ id: 7, roleData: { name: 'tenant' } }));
        stub(Contract, 'findAll', async () => [{ id: 11, roomId: 5, room: { roomNumber: '101' } }]);
        stub(Room, 'findByPk', async () => null);
        return sent;
    };

    test('tạo yêu cầu bằng createTenantRequest với phòng đã chọn', async () => {
        const sent = tenantSetup();
        let directCreate = false;
        stub(SupportRequest, 'create', async () => { directCreate = true; return { id: 1 }; });
        let args;
        stub(supportService, 'createTenantRequest', async (...a) => { args = a; return { supportRequest: { id: 42 } }; });

        await call({ callback_query: { message: { chat: { id: 900 } }, data: 'tenant_report_issue' } });
        await call({ message: { chat: { id: 900 }, text: 'Bóng đèn cháy' } });

        assert.equal(directCreate, false);
        assert.deepEqual(args, [7, { description: 'Bóng đèn cháy', roomId: 5 }]);
        assert.match(sent.at(-1).text, /Đã gửi báo hỏng thành công/);
    });

    test('service lỗi thì báo lỗi cho khách, không báo thành công', async () => {
        const sent = tenantSetup();
        stub(supportService, 'createTenantRequest', async () => {
            const e = new Error('Bạn phải ở trong phòng có hợp đồng kích hoạt mới có thể báo sự cố.');
            e.statusCode = 400;
            throw e;
        });

        await call({ callback_query: { message: { chat: { id: 901 } }, data: 'tenant_report_issue' } });
        await call({ message: { chat: { id: 901 }, text: 'Hỏng vòi' } });

        assert.match(sent.at(-1).text, /hợp đồng kích hoạt/);
        assert.ok(!sent.some(m => /báo hỏng thành công/.test(m.text)));
    });
});

describe('chủ nhà đổi trạng thái qua Telegram đi qua supportService (F1)', () => {
    const setup = (status = 'pending') => {
        devEnv();
        const sent = captureMessages();
        stub(User, 'findOne', async () => ({ id: 2, roleData: { name: 'landlord' } }));
        const request = {
            id: 3, status, description: 'Vòi rò',
            tenant: { telegramChatId: '777' },
            room: { roomNumber: '101', building: { landlordId: 2 } },
            update: async () => { throw new Error('không được gọi update trực tiếp'); }
        };
        stub(SupportRequest, 'findByPk', async () => request);
        return sent;
    };
    const press = (data) => call({ callback_query: { message: { chat: { id: 500 } }, data } });

    test('gọi updateRequestStatus với landlordId, requestId và trạng thái DB', async () => {
        const sent = setup();
        let args;
        stub(supportService, 'updateRequestStatus', async (...a) => { args = a; return {}; });
        await press('landlord_status_repairing_3');
        assert.deepEqual(args, [2, '3', { status: 'in_progress' }]);
        assert.match(sent[0].text, /Đang sửa/);
        assert.equal(sent[1].chat_id, '777');
    });

    test('chuyển không hợp lệ thì báo lỗi, không nhắn khách', async () => {
        const sent = setup('resolved');
        stub(supportService, 'updateRequestStatus', async () => {
            const e = new Error('Không thể chuyển trạng thái sự cố.');
            e.statusCode = 400;
            throw e;
        });
        await press('landlord_status_repairing_3');
        assert.equal(sent.length, 1);
        assert.match(sent[0].text, /Không thể chuyển/);
    });

    test('cùng trạng thái thì không gọi service, không nhắn khách', async () => {
        const sent = setup('resolved');
        let called = false;
        stub(supportService, 'updateRequestStatus', async () => { called = true; return {}; });
        await press('landlord_status_resolved_3');
        assert.equal(called, false);
        assert.equal(sent.length, 1);
    });
});

describe('T2.13 & T2.17: /start gỡ chatId trùng và escape Markdown', () => {
    test('/start <token> gỡ telegramChatId khỏi tài khoản cũ trước khi lưu tài khoản mới', async () => {
        devEnv();
        const sent = captureMessages();
        const order = [];
        let clearArgs;
        stub(User, 'update', async (values, opts) => {
            order.push('update');
            clearArgs = [values, opts];
            return [1];
        });
        const linkedUser = {
            id: 9,
            telegramChatId: null,
            telegramLinkToken: 'tok123',
            telegramLinkTokenExpiresAt: new Date(Date.now() + 60000),
            roleData: { name: 'tenant' },
            save: async () => { order.push('save'); }
        };
        stub(User, 'findOne', async () => linkedUser);

        const res = await call({ message: { chat: { id: 888 }, text: '/start tok123' } });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(order, ['update', 'save']);
        assert.deepEqual(clearArgs[0], { telegramChatId: null });
        assert.equal(clearArgs[1].where.telegramChatId, '888');
        assert.equal(linkedUser.telegramChatId, '888');
        assert.match(sent[0].text, /Kết nối thành công/);
    });

    test('escape Markdown cho dữ liệu động khi hiển thị hợp đồng / báo hỏng', async () => {
        devEnv();
        const sent = captureMessages();
        stub(User, 'findOne', async () => ({ id: 7, roleData: { name: 'tenant' } }));
        stub(Contract, 'findAll', async () => [{
            id: 11,
            roomId: 5,
            startDate: '2026-01-01',
            endDate: '2026-12-31',
            deposit: 1000000,
            electricityPrice: 3500,
            waterPrice: 20000,
            room: { roomNumber: '101_A', price: 3000000, building: { name: 'Tòa *Sao* [1]' } }
        }]);

        await call({ callback_query: { message: { chat: { id: 900 } }, data: 'tenant_contract' } });
        assert.ok(sent[0].text.includes('101\\_A'));
        assert.ok(sent[0].text.includes('Tòa \\*Sao\\* \\[1\\]'));
    });
});
