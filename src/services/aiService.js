const OpenAI = require("openai");
const fs = require("fs");
const { createError } = require("../utils/errors");

/**
 * Đọc chỉ số đồng hồ từ văn bản AI trả về. Chỉ chấp nhận ĐÚNG MỘT cụm chữ số
 * nguyên liên tiếp: "12.5" / "123 456" đều từ chối, không bóc hết ký tự rồi
 * parseInt (trước đây "12.5" thành 125, "123 456" thành 123456).
 */
const parseMeterText = (text) => {
    const raw = String(text ?? '').trim();
    if (!raw) throw createError(422, "AI không nhận diện được con số nào.");
    if (/\d+[.,]\d+/.test(raw)) {
        throw createError(422, "AI trả về chỉ số lẫn dấu thập phân. Vui lòng chụp rõ hơn.");
    }
    const groups = raw.match(/\d+/g) || [];
    if (groups.length !== 1) {
        throw createError(422, "AI trả về nhiều dãy số. Vui lòng chụp rõ hơn.");
    }
    const value = parseInt(groups[0], 10);
    // Đồng hồ điện/nước thực tế không quá 8 chữ số; dài hơn là AI đọc sai.
    if (!Number.isFinite(value) || value < 0 || value > 99999999) {
        throw createError(422, "AI không nhận diện được các con số màu đen. Vui lòng chụp rõ hơn.");
    }
    return value;
};

/**
 * Làm sạch thông tin CCCD do AI trả về (T1.12).
 * Mọi trường hợp sau khi lấy chữ số mà digits.length !== 12 đều trả cccdNumber = ''
 * và thêm cảnh báo vào warnings (không tự động padStart thêm số 0).
 */
const normalizeCccdData = (data) => {
    const out = {
        name: String(data?.name ?? '').trim(),
        dob: String(data?.dob ?? '').trim(),
        cccdNumber: '',
        hometown: String(data?.hometown ?? '').trim(),
    };
    const warnings = [];

    const raw = data?.cccdNumber;
    const digits = String(raw ?? '').replace(/\D/g, '');
    if (digits.length === 12) {
        out.cccdNumber = digits;
    } else if (digits.length === 0) {
        warnings.push('Không đọc được số CCCD.');
    } else {
        warnings.push(`Số CCCD chỉ nhận được ${digits.length} chữ số, vui lòng kiểm tra lại.`);
    }

    const dobMatch = out.dob.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!dobMatch) {
        warnings.push('Ngày sinh sai định dạng DD/MM/YYYY.');
        out.dob = '';
    } else {
        const [, dd, mm, yyyy] = dobMatch;
        const d = new Date(+yyyy, +mm - 1, +dd);
        if (d.getFullYear() !== +yyyy || d.getMonth() !== +mm - 1 || d.getDate() !== +dd) {
            warnings.push('Ngày sinh không tồn tại.');
            out.dob = '';
        }
    }
    return { data: out, warnings };
};

/**
 * Ánh xạ lỗi từ OpenAI SDK sang thông báo tiếng Việt thân thiện, không lộ API key/billing (T3.8).
 */
const mapOpenAIError = (err) => {
    const status = err?.status || err?.statusCode;
    if (status === 429) {
        return createError(503, "Hệ thống AI đang quá tải, vui lòng thử lại sau ít phút.");
    }
    if (status === 401 || status === 403) {
        return createError(500, "Dịch vụ AI tạm thời gián đoạn.");
    }
    return null;
};

exports.parseMeterText = parseMeterText;
exports.normalizeCccdData = normalizeCccdData;
exports.mapOpenAIError = mapOpenAIError;

// Khởi tạo client khi cần (không phải lúc require) để test các hàm thuần không
// đòi OPENAI_API_KEY.
let openaiClient = null;
const getOpenAI = () => {
    if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openaiClient;
};
exports.__setOpenAIClientForTest = (client) => {
    openaiClient = client;
};

exports.readMeterFromImage = async (fileOrBase64, mimeType = 'image/jpeg') => {
    if (!fileOrBase64) {
        throw createError(400, "Vui lòng upload ảnh đồng hồ");
    }

    const isFileObj = typeof fileOrBase64 === 'object' && fileOrBase64 !== null;
    const filePath = isFileObj ? fileOrBase64.path : null;
    const resolvedMime = (isFileObj ? (mimeType !== 'image/jpeg' ? mimeType : fileOrBase64.mimetype) : mimeType) || 'image/jpeg';

    try {
        let base64Image;
        if (isFileObj) {
            if (fileOrBase64.buffer) {
                base64Image = Buffer.from(fileOrBase64.buffer).toString("base64");
            } else {
                base64Image = Buffer.from(fs.readFileSync(fileOrBase64.path)).toString("base64");
            }
        } else if (typeof fileOrBase64 === 'string' && fs.existsSync(fileOrBase64)) {
            base64Image = Buffer.from(fs.readFileSync(fileOrBase64)).toString("base64");
        } else {
            base64Image = String(fileOrBase64);
        }

        const response = await getOpenAI().chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: [
                        { 
                            type: "text", 
                            text: `Bạn là chuyên gia đọc chỉ số đồng hồ điện nước chuyên nghiệp.
                                   Hãy nhìn vào dãy số hiển thị trên mặt đồng hồ trong ảnh.
                                   QUY TẮC ĐỌC SỐ DUY NHẤT:
                                   1. Chỉ nhận diện và đọc các chữ số nằm trong ô màu ĐEN hoặc trên nền ĐEN/TRẮNG (phần số nguyên).
                                   2. TUYỆT ĐỐI BỎ QUA (KHÔNG ĐỌC) bất kỳ chữ số nào nằm trong ô màu ĐỎ hoặc có ký tự màu đỏ (phần thập phân).
                                   3. Không quan tâm đó là đồng hồ điện (kWh) hay nước (m3), luôn áp dụng quy tắc bỏ số đỏ.
                                   4. Chỉ trả về DUY NHẤT con số nguyên tìm được, không thêm bất kỳ văn bản, đơn vị hay lời giải thích nào.` 
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${resolvedMime};base64,${base64Image}`,
                                detail: "high"
                            },
                        },
                    ],
                },
            ],
            max_tokens: 10,
        });

        // Xóa file tạm ngay lập tức
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);

        const aiText = response.choices[0].message.content.trim();
        const readingValue = parseMeterText(aiText);

        return {
            message: "AI đã trích xuất chỉ số (phần số đen) thành công",
            readingValue,
            raw: aiText
        };

    } catch (err) {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        const mapped = mapOpenAIError(err);
        if (mapped) throw mapped;
        console.error("OpenAI Service Error:", err);
        throw err;
    }
};

exports.readCccdFromImage = async (filesOrFile) => {
    let files = [];
    if (Array.isArray(filesOrFile)) {
        files = filesOrFile;
    } else if (filesOrFile) {
        files = [filesOrFile];
    }

    if (files.length === 0) {
        throw createError(400, "Vui lòng upload ảnh căn cước công dân");
    }

    try {
        const imageContent = files.map(file => {
            const base64Image = Buffer.from(fs.readFileSync(file.path)).toString("base64");
            const mime = file.mimetype || 'image/jpeg';
            return {
                type: "image_url",
                image_url: {
                    url: `data:${mime};base64,${base64Image}`,
                    detail: "high"
                }
            };
        });

        const response = await getOpenAI().chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: [
                        { 
                            type: "text", 
                            text: `Bạn là một trợ lý AI chuyên nghiệp về trích xuất thông tin từ ảnh thẻ Căn cước công dân (CCCD) Việt Nam.
                                   Bạn có thể nhận được 1 hoặc 2 ảnh thể hiện mặt trước và/hoặc mặt sau của CCCD.
                                   Hãy phân tích tất cả các ảnh thẻ CCCD được cung cấp và tổng hợp trả về thông tin dưới dạng JSON duy nhất.
                                   Các trường thông tin cần trích xuất bao gồm:
                                   1. name: Họ và tên (chữ in hoa có dấu, ví dụ: "TẠ ĐÌNH CƯỜNG")
                                   2. dob: Ngày tháng năm sinh (định dạng DD/MM/YYYY, ví dụ: "17/12/2004")
                                   3. cccdNumber: Số CCCD, chuỗi đủ 12 chữ số kể cả các số 0 ở đầu (ví dụ: "001204012345"), không cắt bớt
                                   4. hometown: Nơi thường trú hoặc Quê quán (ví dụ: "Hồng Giang, Lục Ngạn, Bắc Giang")
                                   
                                   YÊU CẦU QUAN TRỌNG:
                                   - Trả về dữ liệu dưới dạng JSON thuần túy, không có thẻ code block markdown (không có \`\`\`json ... \`\`\`), không có dòng thừa.
                                   - Chỉ trả về đúng cấu trúc JSON sau:
                                   {
                                     "name": "...",
                                     "dob": "...",
                                     "cccdNumber": "...",
                                     "hometown": "..."
                                   }
                                   - Nếu không đọc được trường nào, trả về chuỗi rỗng "".`
                        },
                        ...imageContent
                    ],
                },
            ],
            max_tokens: 500,
        });

        // Xóa file tạm ngay lập tức
        files.forEach(file => {
            if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        });

        const aiText = response.choices[0].message.content.trim();
        
        // Clean JSON formatting
        let jsonText = aiText;
        if (jsonText.startsWith("```")) {
            jsonText = jsonText.replace(/^```json\s*/, "").replace(/```$/, "").trim();
        }

        const data = JSON.parse(jsonText);
        // Số CCCD luôn là chuỗi 12 chữ số: sai độ dài thì để trống + cảnh báo cho UI.
        const normalized = normalizeCccdData(data);
        return {
            message: "AI đã trích xuất thông tin CCCD thành công",
            ...normalized
        };

    } catch (err) {
        files.forEach(file => {
            if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        });
        const mapped = mapOpenAIError(err);
        if (mapped) throw mapped;
        console.error("OpenAI scanCccd Error:", err);
        throw createError(422, "Không thể nhận diện được thông tin từ ảnh căn cước công dân này. Vui lòng chụp rõ và vuông góc hơn.");
    }
};
