/**
 * PII Encryption & Masking Utilities (AES-256-GCM)
 * Bảo vệ thông tin danh tính cá nhân (CCCD, SĐT) tuân thủ Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân.
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Khuyến nghị cho GCM
const TAG_LENGTH = 16;

const getMasterKey = () => {
    const rawKey = process.env.PII_ENCRYPTION_KEY || process.env.JWT_SECRET || 'homesync_pii_master_key_secure_2026';
    return crypto.createHash('sha256').update(String(rawKey)).digest();
};

/**
 * Mã hóa chuỗi nhạy cảm bằng AES-256-GCM
 * @param {string} text 
 * @returns {string} iv:tag:ciphertext (dạng Hex)
 */
const encrypt = (text) => {
    if (text === null || text === undefined) return text;
    const str = String(text);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = getMasterKey();
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(str, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
};

/**
 * Giải mã chuỗi AES-256-GCM
 * @param {string} cipherTextWithIv `${iv}:${tag}:${ciphertext}`
 * @returns {string} Plaintext
 */
const decrypt = (cipherTextWithIv) => {
    if (!cipherTextWithIv) return cipherTextWithIv;
    const parts = String(cipherTextWithIv).split(':');
    if (parts.length !== 3) {
        throw new Error('Định dạng cipherText không hợp lệ');
    }

    const [ivHex, tagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const key = getMasterKey();

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    try {
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        throw new Error('Dữ liệu đã bị can thiệp trái phép (tampered ciphertext hoặc auth tag không hợp lệ)');
    }
};

/**
 * Che mờ số CCCD: giữ 6 số đầu, che 6 số cuối
 * @example maskCccd('079199001234') -> '079199******'
 */
const maskCccd = (cccd) => {
    if (!cccd) return '';
    const clean = String(cccd).trim();
    if (clean.length < 6) return '******';
    return clean.substring(0, 6) + '*'.repeat(Math.max(0, clean.length - 6));
};

/**
 * Che mờ số điện thoại: che 4 số ở giữa
 * @example maskPhone('0912345678') -> '0912****78'
 */
const maskPhone = (phone) => {
    if (!phone) return '';
    const clean = String(phone).trim();
    if (clean.length <= 6) return clean;
    const prefix = clean.substring(0, 4);
    const suffix = clean.substring(clean.length - 2);
    const stars = '*'.repeat(Math.max(0, clean.length - 6));
    return `${prefix}${stars}${suffix}`;
};

const isEncryptedFormat = (val) => {
    if (typeof val !== 'string') return false;
    const parts = val.split(':');
    return parts.length === 3
        && /^[0-9a-f]{24}$/i.test(parts[0])
        && /^[0-9a-f]{32}$/i.test(parts[1])
        && /^[0-9a-f]*$/i.test(parts[2]);
};

const encryptIfNeeded = (val) => {
    if (val === null || val === undefined || val === '') return val;
    const str = String(val);
    if (isEncryptedFormat(str)) return str;
    return encrypt(str);
};

const safeDecrypt = (val) => {
    if (val === null || val === undefined || val === '') return val;
    if (!isEncryptedFormat(val)) return val;
    try {
        return decrypt(val);
    } catch {
        return val;
    }
};

// Reuseable Sequelize attribute getter/setter for transparent AES-256-GCM PII fields
const piiField = (fieldName) => ({
    get() {
        return safeDecrypt(this.getDataValue(fieldName));
    },
    set(val) {
        this.setDataValue(fieldName, encryptIfNeeded(val));
    }
});

module.exports = {
    encrypt,
    decrypt,
    maskCccd,
    maskPhone,
    isEncryptedFormat,
    encryptIfNeeded,
    safeDecrypt,
    piiField
};

