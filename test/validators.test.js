/**
 * Unit test helper validate biên + sendError (T2.20).
 * Chạy: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateEmail, validatePhone, validatePassword } = require('../src/utils/validators');
const { sendError } = require('../src/utils/errors');

const is400 = (e) => e.statusCode === 400;

describe('validatePhone', () => {
    test('chuẩn hóa SĐT có khoảng trắng, +84, 84 về 0xxxxxxxxx', () => {
        assert.equal(validatePhone('0912 345 678'), '0912345678');
        assert.equal(validatePhone('+84912345678'), '0912345678');
        assert.equal(validatePhone('84 912 345 678'), '0912345678');
        assert.equal(validatePhone(' 0387.654.321 '), '0387654321');
    });

    test('từ chối SĐT sai định dạng với 400', () => {
        for (const bad of ['12345', '0112345678', '09123456789', 'abc', '', null, undefined, 912345678]) {
            assert.throws(() => validatePhone(bad), is400, `phải từ chối: ${bad}`);
        }
    });
});

describe('validateEmail', () => {
    test('trả email đã bỏ khoảng trắng hai đầu', () => {
        assert.equal(validateEmail('  a.b@gmail.com '), 'a.b@gmail.com');
    });

    test('từ chối email sai định dạng với 400', () => {
        for (const bad of ['abc', 'a@b', '@x.com', 'a b@x.com', '', null, 123]) {
            assert.throws(() => validateEmail(bad), is400, `phải từ chối: ${bad}`);
        }
    });
});

describe('validatePassword', () => {
    test('mật khẩu dưới 6 ký tự hoặc không phải chuỗi bị từ chối', () => {
        for (const bad of ['12345', '', null, 123456]) {
            assert.throws(() => validatePassword(bad), is400);
        }
    });

    test('mật khẩu đủ 6 ký tự được chấp nhận', () => {
        assert.doesNotThrow(() => validatePassword('123456'));
    });
});

describe('sendError', () => {
    const fakeRes = () => {
        const res = {};
        res.status = (c) => { res.code = c; return res; };
        res.json = (b) => { res.body = b; return res; };
        return res;
    };

    test('lỗi có statusCode giữ nguyên mã và thông điệp', () => {
        const res = fakeRes();
        const err = new Error('Không tìm thấy'); err.statusCode = 404;
        sendError(res, err);
        assert.equal(res.code, 404);
        assert.equal(res.body.message, 'Không tìm thấy');
    });

    test('SequelizeUniqueConstraintError → 400 tiếng Việt', () => {
        const res = fakeRes();
        const err = new Error('Validation error'); err.name = 'SequelizeUniqueConstraintError';
        sendError(res, err);
        assert.equal(res.code, 400);
        assert.notEqual(res.body.message, 'Validation error');
        assert.match(res.body.message, /đã tồn tại/);
    });

    test('SequelizeValidationError → 400 tiếng Việt', () => {
        const res = fakeRes();
        const err = new Error('notNull Violation: User.name cannot be null'); err.name = 'SequelizeValidationError';
        sendError(res, err);
        assert.equal(res.code, 400);
        assert.match(res.body.message, /không hợp lệ/);
    });

    test('lỗi không rõ → 500 thông điệp chung, không lộ chi tiết', () => {
        const res = fakeRes();
        const orig = console.error; console.error = () => {};
        try { sendError(res, new Error('ECONNREFUSED 127.0.0.1:3306')); } finally { console.error = orig; }
        assert.equal(res.code, 500);
        assert.doesNotMatch(res.body.message, /ECONNREFUSED/);
    });
});
