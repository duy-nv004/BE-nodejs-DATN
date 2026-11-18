/**
 * Unit test Quên mật khẩu / Đặt lại mật khẩu qua Email OTP (TDD RED -> GREEN).
 * Chạy: npm test
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const User = require('../src/models/User');
const RefreshToken = require('../src/models/RefreshToken');
const emailService = require('../src/services/emailService');
const authService = require('../src/services/authService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');

describe('forgotPassword & resetPassword', () => {
    test('forgotPassword từ chối email không hợp lệ với 400', async () => {
        await assert.rejects(
            authService.forgotPassword({ email: 'not-an-email' }),
            (e) => e.statusCode === 400
        );
    });

    test('forgotPassword trả về thông báo chung (200) ngay cả khi email không tồn tại để chống dò tài khoản', async () => {
        stub(User, 'findOne', async () => null);
        let mailSent = false;
        stub(emailService, 'sendPasswordResetOtpEmail', async () => { mailSent = true; return true; });

        const res = await authService.forgotPassword({ email: 'nobody@example.com' });
        assert.equal(mailSent, false);
        assert.match(res.message, /nếu email tồn tại/i);
    });

    test('forgotPassword sinh OTP 6 số, lưu hash + hạn 15 phút và gửi email', async () => {
        const user = {
            id: 7,
            email: 'landlord@example.com',
            name: 'Chủ trọ A',
            status: 'active',
            resetPasswordToken: null,
            resetPasswordExpiresAt: null,
            async save() { this.saved = true; }
        };
        stub(User, 'findOne', async () => user);

        let sentTo = null;
        let sentOtp = null;
        stub(emailService, 'sendPasswordResetOtpEmail', async (to, _name, otp) => {
            sentTo = to;
            sentOtp = otp;
            return true;
        });

        const res = await authService.forgotPassword({ email: '  LANDLORD@example.com ' });
        assert.equal(user.saved, true);
        assert.equal(sentTo, 'landlord@example.com');
        assert.match(String(sentOtp), /^\d{6}$/);
        assert.equal(user.resetPasswordToken, hashOtp(sentOtp));
        assert.ok(user.resetPasswordExpiresAt instanceof Date);
        assert.ok(user.resetPasswordExpiresAt.getTime() > Date.now() + 10 * 60 * 1000);
        assert.match(res.message, /nếu email tồn tại/i);
    });

    test('resetPassword từ chối khi mật khẩu mới dưới 6 ký tự', async () => {
        await assert.rejects(
            authService.resetPassword({ email: 'a@b.com', otp: '123456', newPassword: '123' }),
            (e) => e.statusCode === 400
        );
    });

    test('resetPassword từ chối khi OTP sai hoặc hết hạn', async () => {
        const user = {
            id: 7,
            email: 'landlord@example.com',
            resetPasswordToken: hashOtp('654321'),
            resetPasswordExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            async save() { this.saved = true; }
        };
        stub(User, 'findOne', async () => user);

        await assert.rejects(
            authService.resetPassword({ email: 'landlord@example.com', otp: '111111', newPassword: 'newpass123' }),
            (e) => e.statusCode === 400
        );

        user.resetPasswordToken = hashOtp('123456');
        user.resetPasswordExpiresAt = new Date(Date.now() - 1000);
        await assert.rejects(
            authService.resetPassword({ email: 'landlord@example.com', otp: '123456', newPassword: 'newpass123' }),
            (e) => e.statusCode === 400
        );
    });

    test('resetPassword hợp lệ: đổi mật khẩu, xóa OTP, tăng tokenVersion và thu hồi RefreshToken', async () => {
        const user = {
            id: 7,
            email: 'landlord@example.com',
            password: 'old-hashed-password',
            tokenVersion: 4,
            resetPasswordToken: hashOtp('123456'),
            resetPasswordExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            async save() { this.saved = true; }
        };
        stub(User, 'findOne', async () => user);
        let destroyedWhere = null;
        stub(RefreshToken, 'destroy', async (opts) => { destroyedWhere = opts.where; return 2; });

        const res = await authService.resetPassword({
            email: 'landlord@example.com',
            otp: '123456',
            newPassword: 'newpass123'
        });

        assert.equal(user.saved, true);
        assert.equal(user.password, 'newpass123');
        assert.equal(user.resetPasswordToken, null);
        assert.equal(user.resetPasswordExpiresAt, null);
        assert.equal(user.tokenVersion, 5);
        assert.deepEqual(destroyedWhere, { userId: 7 });
        assert.match(res.message, /thành công/i);
    });
});
