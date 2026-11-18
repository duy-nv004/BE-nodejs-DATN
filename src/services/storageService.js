/**
 * Storage Service Abstraction Layer
 * Trừu tượng hóa việc lưu trữ file (Local Disk, AWS S3, Cloudinary).
 * Hỗ trợ tạo URL có chữ ký bảo mật (Signed URLs) cho các tài liệu nhạy cảm như ảnh CCCD.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_ROOT = path.resolve(__dirname, '../../uploads');

if (!fs.existsSync(UPLOAD_ROOT)) {
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

/**
 * Tải file lên storage provider
 * @param {Object} params
 * @param {Buffer} params.buffer Dữ liệu nhị phân của file
 * @param {string} params.originalname Tên file gốc
 * @param {string} params.mimetype Định dạng MIME
 * @param {string} params.folder Thư mục con (meters, cccd, contracts, avatars)
 * @returns {Promise<{ fileKey: string, url: string, mimetype: string, size: number }>}
 */
const uploadFile = async ({ buffer, originalname, mimetype, folder = 'general' }) => {
    const ext = path.extname(originalname || '') || '.bin';
    const randomName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    const fileKey = path.posix.join(folder, randomName);

    const targetDir = path.join(UPLOAD_ROOT, folder);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const fullFilePath = path.join(UPLOAD_ROOT, fileKey);
    await fs.promises.writeFile(fullFilePath, buffer);

    return {
        fileKey,
        url: `/uploads/${fileKey}`,
        mimetype,
        size: buffer.length
    };
};

/**
 * Xóa file khỏi storage provider
 * @param {string} fileKey Khóa định danh file
 * @returns {Promise<boolean>}
 */
const deleteFile = async (fileKey) => {
    try {
        const fullFilePath = path.join(UPLOAD_ROOT, fileKey);
        if (fs.existsSync(fullFilePath)) {
            await fs.promises.unlink(fullFilePath);
            return true;
        }
        return false;
    } catch (err) {
        console.error(`[storageService] Lỗi xóa file ${fileKey}:`, err.message);
        return false;
    }
};

/**
 * Tạo URL tạm thời có thời hạn và chữ ký bảo mật (Signed URL)
 * Cho phép xem ảnh nhạy cảm (như CCCD) trong khoảng thời gian nhất định mà không public vĩnh viễn.
 * @param {string} fileKey Khóa file
 * @param {number} expiresInSeconds Thời gian sống của link (giây)
 * @returns {Promise<string>}
 */
const getSignedUrl = async (fileKey, expiresInSeconds = 3600) => {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const secret = process.env.JWT_SECRET || 'homesync_secure_storage_token';
    const signature = crypto.createHmac('sha256', secret)
        .update(`${fileKey}:${expiresAt}`)
        .digest('hex');

    return `/api/storage/access?key=${encodeURIComponent(fileKey)}&expires=${expiresAt}&sig=${signature}`;
};

/**
 * Xác thực link xem file có chữ ký
 */
const verifySignedUrl = (fileKey, expiresAt, signature) => {
    if (!fileKey || !expiresAt || !signature) return false;
    const expNum = Number(expiresAt);
    if (!Number.isFinite(expNum) || Date.now() > expNum) return false;

    const secret = process.env.JWT_SECRET || 'homesync_secure_storage_token';
    const expectedSignature = crypto.createHmac('sha256', secret)
        .update(`${fileKey}:${expiresAt}`)
        .digest('hex');

    const sigBuf = Buffer.from(String(signature));
    const expectedBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expectedBuf.length) return false;

    return crypto.timingSafeEqual(sigBuf, expectedBuf);
};

module.exports = {
    uploadFile,
    deleteFile,
    getSignedUrl,
    verifySignedUrl
};

