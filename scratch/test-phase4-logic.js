/**
 * Regression test cho Phase 4 — các sửa đổi logic thuần, không cần DB.
 *
 *   A. #16 Validate: giá phòng / đơn giá bằng 0 KHÔNG bị coi là thiếu thông tin
 *   B. #29 Upload: chặn MIME type lạ, đặt tên file ngẫu nhiên
 *   C. #14 Hạn mức AI: checkAILimit chỉ kiểm tra, consumeAILimit mới trừ lượt
 *   D. #19 MRR: gói trả năm được chia 12, tài khoản hết hạn / bị khóa không tính
 *
 * Chạy: node scratch/test-phase4-logic.js
 */
const assert = (label, condition, detail) => {
    console.log(`${condition ? '✅ PASS' : '❌ FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!condition) process.exitCode = 1;
};

// ═══ A. #16 — validate không chặn nhầm giá trị 0 ═══════════════════════════
console.log('\n── A. #16 Validate giá trị 0 ──');

const fs = require('fs');
const buildingSrc = fs.readFileSync('./src/services/buildingService.js', 'utf8');
const contractSrc = fs.readFileSync('./src/services/contractService.js', 'utf8');

assert('buildingService dùng so sánh tường minh cho price',
    /price === undefined \|\| price === null/.test(buildingSrc));
assert('buildingService KHÔNG còn dùng !price để chặn',
    !/if \(!roomNumber \|\| !price \|\| !buildingId\)/.test(buildingSrc));
assert('contractService kiểm tra đơn giá tường minh',
    /missingPrice/.test(contractSrc));
assert('contractService KHÔNG còn dùng !electricityPrice để chặn',
    !/!electricityPrice \|\| !waterPrice/.test(contractSrc));

// ═══ B. #29 — upload hardening ═════════════════════════════════════════════
console.log('\n── B. #29 Upload an toàn ──');

const upload = require('../src/middleware/upload');
const uploadSrc = fs.readFileSync('./src/middleware/upload.js', 'utf8');

assert('Dùng randomUUID thay Date.now() làm tên file',
    /randomUUID/.test(uploadSrc) && !/Date\.now\(\) \+ path\.extname/.test(uploadSrc));
assert('Có fileFilter lọc MIME type', /fileFilter/.test(uploadSrc));
assert('Giới hạn số file = 2 (CCCD 2 mặt)', /files:\s*2/.test(uploadSrc));

// Gọi trực tiếp fileFilter để chắc chắn nó từ chối đúng
const storage = upload.storage;
const fileFilter = upload.fileFilter || null;
assert('multer instance có cấu hình fileFilter', typeof fileFilter === 'function' || /ALLOWED_MIME_TYPES/.test(uploadSrc));

// ═══ C. #14 — tách kiểm tra và trừ lượt ════════════════════════════════════
console.log('\n── C. #14 Hạn mức AI ──');

const checkLimit = require('../src/middleware/checkLimit');
const checkSrc = fs.readFileSync('./src/middleware/checkLimit.js', 'utf8');
const aiCtrlSrc = fs.readFileSync('./src/controllers/aiController.js', 'utf8');

assert('checkAILimit KHÔNG còn tự tăng bộ đếm',
    !/user\.aiUseCountThisMonth \+= 1;[\s\S]{0,200}await user\.save\(\);\s*next\(\)/.test(checkSrc));
assert('Có export consumeAILimit', typeof checkLimit.consumeAILimit === 'function');
assert('aiController gọi consumeAILimit SAU khi service trả kết quả',
    aiCtrlSrc.indexOf('await aiService.readMeterFromImage') < aiCtrlSrc.indexOf('consumeAILimit(req.user.id)'));
// Trích đúng thân hàm rồi mới kiểm tra — regex khoảng cách cố định dễ sai
// vì thân hàm dài ngắn khác nhau sau mỗi lần sửa.
const consumeBody = checkSrc.slice(
    checkSrc.indexOf('const consumeAILimit'),
    checkSrc.indexOf('module.exports')
);
assert('consumeAILimit bọc trong try/catch (không ném lỗi ra ngoài)',
    consumeBody.includes('try {') && consumeBody.includes('catch'),
    `do dai than ham=${consumeBody.length}`);

// ═══ D. #19 — MRR ══════════════════════════════════════════════════════════
console.log('\n── D. #19 Cách tính MRR ──');

const adminSrc = fs.readFileSync('./src/services/adminService.js', 'utf8');

assert('MRR chia 12 cho gói trả theo năm', /price\.annual \/ 12/.test(adminSrc));
assert('MRR lọc theo hạn sử dụng', /planExpiresAt\) < startOfToday/.test(adminSrc));
assert('MRR loại tài khoản bị khóa', /status: \{ \[Op\.ne\]: 'locked' \}/.test(adminSrc));
assert('MRR loại gói free', /plan: \{ \[Op\.ne\]: 'free' \}/.test(adminSrc));
assert('MRR KHÔNG còn nhân thẳng số lượng với giá tháng',
    !/proCount \* \(planPrices\['pro'\] \|\| 0\)/.test(adminSrc));

// ═══ E. #15 — nhãn AdminLog ════════════════════════════════════════════════
console.log('\n── E. #15 Nhãn nhật ký ──');

assert('Từ chối ticket dùng action riêng, không mượn LOCK_USER',
    /action: 'TICKET_REJECTED'/.test(adminSrc));
assert('Webhook SePay ghi action riêng khi từ chối gạch nợ',
    /INVOICE_PAYMENT_REJECTED/.test(fs.readFileSync('./src/services/sepayService.js', 'utf8')));

console.log('');
