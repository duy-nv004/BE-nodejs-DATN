const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const storageService = require('../src/services/storageService');
const User = require('../src/models/User');
const Contract = require('../src/models/Contract');
const ContractOccupant = require('../src/models/ContractOccupant');

describe('Stage 1 (P0): Security, PII AES-256-GCM, Signed URLs & AI/Chat RBAC', () => {
    test('storageService.verifySignedUrl từ chối chữ ký lệch độ dài không ném RangeError & từ chối expires không hợp lệ', async () => {
        const key = 'cccd/front-123.jpg';
        const signed = await storageService.getSignedUrl(key, 60);
        const url = new URL(`http://localhost${signed}`);
        const expires = url.searchParams.get('expires');
        const sig = url.searchParams.get('sig');

        assert.equal(storageService.verifySignedUrl(key, expires, sig), true);
        assert.doesNotThrow(() => {
            assert.equal(storageService.verifySignedUrl(key, expires, 'short-sig'), false);
        });
        assert.equal(storageService.verifySignedUrl(key, 'not-a-number', sig), false);
    });

    test('index.js import module path cho route /api/storage/access', () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
        assert.match(indexSrc, /require\(['"]path['"]\)/);
    });

    test('User, Contract và ContractOccupant tự động mã hóa AES-256-GCM ở dataValues và giải mã khi đọc', () => {
        const rawCccd = '079199001234';
        const user = User.build({ cccd: rawCccd, password: 'secret', roleId: 3 });
        const storedUserCccd = user.getDataValue('cccd');
        assert.notEqual(storedUserCccd, rawCccd);
        assert.equal(storedUserCccd.split(':').length, 3);
        assert.equal(user.cccd, rawCccd);

        const contract = Contract.build({
            startDate: '2026-01-01',
            endDate: '2026-12-31',
            electricityPrice: 3500,
            waterPrice: 20000,
            landlordCccd: '001190001111',
            tenantCccd: '001195002222'
        });
        assert.equal(contract.getDataValue('landlordCccd').split(':').length, 3);
        assert.equal(contract.getDataValue('tenantCccd').split(':').length, 3);
        assert.equal(contract.landlordCccd, '001190001111');
        assert.equal(contract.tenantCccd, '001195002222');

        const occupant = ContractOccupant.build({
            contractId: 1,
            fullName: 'Nguyen Van A',
            cccd: rawCccd
        });
        assert.equal(occupant.getDataValue('cccd').split(':').length, 3);
        assert.equal(occupant.cccd, rawCccd);

        // Tương thích ngược dữ liệu plaintext cũ trong DB
        const legacyUser = User.build({ password: 'secret', roleId: 3 });
        legacyUser.setDataValue('cccd', rawCccd);
        assert.equal(legacyUser.cccd, rawCccd);
    });

    test('chatRoutes gắn checkChatLimit và aiRoutes gắn authorize phân quyền RBAC', () => {
        const chatSrc = fs.readFileSync(path.join(__dirname, '../src/routes/chatRoutes.js'), 'utf8');
        assert.match(chatSrc, /router\.post\(\s*['"]\/['"]\s*,\s*protect\s*,\s*chatLimiter\s*,\s*checkChatLimit\s*,\s*chatController\.chat/);

        const aiSrc = fs.readFileSync(path.join(__dirname, '../src/routes/aiRoutes.js'), 'utf8');
        assert.match(aiSrc, /\/read-meter['"][^\n]*authorize\(/);
        assert.match(aiSrc, /\/scan-cccd['"][^\n]*authorize\(/);
    });
});
