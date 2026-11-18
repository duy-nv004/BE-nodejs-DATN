const test = require('node:test');
const assert = require('node:assert');
const { encrypt, decrypt, maskCccd, maskPhone } = require('../src/utils/crypto');
const storageService = require('../src/services/storageService');
const fs = require('fs');
const path = require('path');

test('Phase 4 - PII Encryption & Masking (AES-256-GCM)', async (t) => {
    await t.test('encrypt và decrypt chuỗi nhạy cảm (CCCD / SĐT) toàn vẹn', () => {
        const secretCccd = '012345678901';
        const encrypted = encrypt(secretCccd);
        
        assert.notStrictEqual(encrypted, secretCccd);
        assert.ok(encrypted.includes(':'), 'Dữ liệu mã hóa phải chứa iv, tag và ciphertext');

        const decrypted = decrypt(encrypted);
        assert.strictEqual(decrypted, secretCccd);
    });

    await t.test('decrypt ném lỗi hoặc trả null nếu ciphertext bị giả mạo / tag không khớp', () => {
        const encrypted = encrypt('0987654321');
        const parts = encrypted.split(':');
        // Giả mạo ciphertext
        parts[2] = 'tamperedData123';
        const tampered = parts.join(':');

        assert.throws(() => {
            decrypt(tampered);
        }, /tampered|cipher|auth/i);
    });

    await t.test('maskCccd che 6 ký tự cuối của căn cước', () => {
        const cccd = '079199001234';
        const masked = maskCccd(cccd);
        assert.strictEqual(masked, '079199******');
    });

    await t.test('maskPhone che 4 chữ số giữa của số điện thoại', () => {
        const phone = '0912345678';
        const masked = maskPhone(phone);
        assert.strictEqual(masked, '0912****78');
    });
});

test('Phase 4 - Storage Service Abstraction & File Management', async (t) => {
    await t.test('uploadFile lưu file thành công và trả về fileKey cùng url', async () => {
        const testBuffer = Buffer.from('test-content-datn', 'utf-8');
        const uploadResult = await storageService.uploadFile({
            buffer: testBuffer,
            originalname: 'meter_photo.jpg',
            mimetype: 'image/jpeg',
            folder: 'meters'
        });

        assert.ok(uploadResult.fileKey);
        assert.ok(uploadResult.url);
        assert.strictEqual(uploadResult.mimetype, 'image/jpeg');

        // Lấy signed / private URL
        const signedUrl = await storageService.getSignedUrl(uploadResult.fileKey, 3600);
        assert.ok(signedUrl);

        // Xóa file test sau khi upload
        const deleted = await storageService.deleteFile(uploadResult.fileKey);
        assert.strictEqual(deleted, true);
    });
});

