const OpenAI = require("openai");
const fs = require("fs");
const { createError } = require("../utils/errors");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

exports.readMeterFromImage = async (file) => {
    if (!file) {
        throw createError(400, "Vui lòng upload ảnh đồng hồ");
    }

    try {
        // Chuyển ảnh sang Base64
        const base64Image = Buffer.from(fs.readFileSync(file.path)).toString("base64");

        const response = await openai.chat.completions.create({
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
                                url: `data:image/jpeg;base64,${base64Image}`,
                                detail: "low"
                            },
                        },
                    ],
                },
            ],
            max_tokens: 10,
        });

        // Xóa file tạm ngay lập tức
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

        const aiText = response.choices[0].message.content.trim();
        const readingValue = parseInt(aiText.replace(/\D/g, ""));

        if (isNaN(readingValue)) {
            const err = createError(422, "AI không nhận diện được các con số màu đen. Vui lòng chụp rõ hơn.");
            err.raw_output = aiText;
            throw err;
        }

        return {
            message: "AI đã trích xuất chỉ số (phần số đen) thành công",
            readingValue,
            raw: aiText
        };

    } catch (err) {
        if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
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
            return {
                type: "image_url",
                image_url: {
                    url: `data:image/jpeg;base64,${base64Image}`,
                    detail: "high"
                }
            };
        });

        const response = await openai.chat.completions.create({
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
                                   3. cccdNumber: Số CCCD (12 chữ số)
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
            max_tokens: 300,
        });

        // Xóa file tạm ngay lập tức
        files.forEach(file => {
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        });

        const aiText = response.choices[0].message.content.trim();
        
        // Clean JSON formatting
        let jsonText = aiText;
        if (jsonText.startsWith("```")) {
            jsonText = jsonText.replace(/^```json\s*/, "").replace(/```$/, "").trim();
        }

        const data = JSON.parse(jsonText);
        return {
            message: "AI đã trích xuất thông tin CCCD thành công",
            data
        };

    } catch (err) {
        files.forEach(file => {
            if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        });
        console.error("OpenAI scanCccd Error:", err);
        throw createError(422, "Không thể nhận diện được thông tin từ ảnh căn cước công dân này. Vui lòng chụp rõ và vuông góc hơn.");
    }
};
