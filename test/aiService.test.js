/**
 * Unit test xử lý kết quả AI (src/services/aiService.js) — không gọi OpenAI thật.
 * Chạy: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/aiService');

describe('Đợt 1: parseMeterText đọc chỉ số đồng hồ an toàn', () => {
    const ok = [['12345', 12345], [' 01234 ', 1234], ['Chỉ số: 4521 kWh', 4521], ['0', 0]];
    for (const [text, value] of ok) {
        test(`"${text}" -> ${value}`, () => assert.equal(service.parseMeterText(text), value));
    }

    // Trước đây bóc hết ký tự không phải số rồi parseInt: "12.5" thành 125, "123 456" thành 123456
    const bad = ['12.5', '12,5', '123 456', 'abc', '', '12345678901'];
    for (const text of bad) {
        test(`"${text}" bị từ chối 422`, () => {
            assert.throws(() => service.parseMeterText(text), (e) => e.statusCode === 422);
        });
    }
});

describe('Đợt 1: normalizeCccdData không bịa số CCCD', () => {
    test('chuỗi 12 số có dấu cách/chấm được làm sạch', () => {
        const { data, warnings } = service.normalizeCccdData({ cccdNumber: '0012 0401.2345', dob: '17/12/2004' });
        assert.equal(data.cccdNumber, '001204012345');
        assert.deepEqual(warnings, []);
    });

    test('T1.12: AI trả kiểu number dưới 12 chữ số thì để trống và cảnh báo, KHÔNG padStart thêm số 0', () => {
        const { data, warnings } = service.normalizeCccdData({ cccdNumber: 1204012345, dob: '17/12/2004' });
        assert.equal(data.cccdNumber, '');
        assert.ok(warnings.some((w) => /CCCD/.test(w)));
    });
    test('chuỗi chỉ 9 số thì để trống và cảnh báo, không tự thêm số 0', () => {
        const { data, warnings } = service.normalizeCccdData({ cccdNumber: '123456789' });
        assert.equal(data.cccdNumber, '');
        assert.ok(warnings.some((w) => /CCCD/.test(w)));
    });

    test('ngày sinh sai định dạng hoặc không tồn tại thì để trống và cảnh báo', () => {
        for (const dob of ['32/13/2004', '2004-12-17', '30/02/2004']) {
            const { data, warnings } = service.normalizeCccdData({ cccdNumber: '001204012345', dob });
            assert.equal(data.dob, '', dob);
            assert.ok(warnings.length > 0, dob);
        }
    });
});

describe('T1.11 & T3.8: readMeterFromImage mimeType, detail="high" & OpenAI error mapping', () => {
    test('T1.11: readMeterFromImage dùng mimeType thật và detail="high"', async () => {
        let capturedPayload = null;
        service.__setOpenAIClientForTest({
            chat: {
                completions: {
                    create: async (payload) => {
                        capturedPayload = payload;
                        return { choices: [{ message: { content: '1234' } }] };
                    }
                }
            }
        });
        const res = await service.readMeterFromImage('ZmFrZWJhc2U2NA==', 'image/png');
        assert.equal(res.readingValue, 1234);
        const imgPart = capturedPayload.messages[0].content.find((c) => c.type === 'image_url');
        assert.equal(imgPart.image_url.url, 'data:image/png;base64,ZmFrZWJhc2U2NA==');
        assert.equal(imgPart.image_url.detail, 'high');
    });

    test('T3.8: map lỗi OpenAI 429 -> 503 và 401/403 -> 500 tiếng Việt', async () => {
        service.__setOpenAIClientForTest({
            chat: {
                completions: {
                    create: async () => {
                        const err = new Error('Rate limit reached');
                        err.status = 429;
                        throw err;
                    }
                }
            }
        });
        await assert.rejects(
            () => service.readMeterFromImage('ZmFrZQ==', 'image/jpeg'),
            (e) => e.statusCode === 503 && e.message === 'Hệ thống AI đang quá tải, vui lòng thử lại sau ít phút.'
        );

        service.__setOpenAIClientForTest({
            chat: {
                completions: {
                    create: async () => {
                        const err = new Error('Incorrect API key provided');
                        err.status = 401;
                        throw err;
                    }
                }
            }
        });
        await assert.rejects(
            () => service.readMeterFromImage('ZmFrZQ==', 'image/jpeg'),
            (e) => e.statusCode === 500 && e.message === 'Dịch vụ AI tạm thời gián đoạn.'
        );
    });
});
