const OpenAI = require("openai");
const fs = require("fs");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

exports.readMeter = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: "Vui lòng upload ảnh đồng hồ" });

        // Chuyển ảnh sang Base64
        const base64Image = Buffer.from(fs.readFileSync(req.file.path)).toString("base64");

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
                                detail: "low" // Tiết kiệm chi phí nhưng vẫn đủ để nhận diện màu sắc
                            },
                        },
                    ],
                },
            ],
            max_tokens: 10, // Chỉ cần nhận về con số ngắn gọn
        });

        // Xóa file tạm ngay lập tức để giải phóng bộ nhớ server
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        const aiText = response.choices[0].message.content.trim();
        
        // Trích xuất số (loại bỏ khoảng trắng hoặc ký tự lạ nếu có)
        const readingValue = parseInt(aiText.replace(/\D/g, ""));

        if (isNaN(readingValue)) {
            return res.status(422).json({ 
                message: "AI không nhận diện được các con số màu đen. Vui lòng chụp rõ hơn.", 
                raw_output: aiText 
            });
        }

        res.status(200).json({
            message: "AI đã trích xuất chỉ số (phần số đen) thành công",
            readingValue, // Kết quả mong đợi cho ảnh của bạn là 3772
            raw: aiText
        });

    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error("OpenAI Error:", err);
        res.status(500).json({ message: "Lỗi hệ thống AI: " + err.message });
    }
};