const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 🔥 WEBHOOK
app.post('/webhook', async (req, res) => {
    try {
        console.log("📩 Webhook recebido da Z-API");

        const body = req.body;
        console.log("BODY:", JSON.stringify(body, null, 2));

        const numero = body.phone || body.from;
        const imageUrl = body.image?.imageUrl;
        const mensagemTexto = body.text?.message;

        // =========================
        // 🔥 SE FOR TEXTO
        // =========================
        if (mensagemTexto) {
            console.log("💬 Texto recebido:", mensagemTexto);

            await axios.post(
                `https://api.z-api.io/instances/${process.env.ZAPI_ID}/token/${process.env.ZAPI_TOKEN}/send-text`,
                {
                    phone: numero,
                    message: `Boa. Você disse: "${mensagemTexto}"\n\nAgora consigo ajustar melhor sua análise.`
                },
                {
                    headers: {
                        "Client-Token": process.env.ZAPI_CLIENT_TOKEN
                    }
                }
            );

            return res.send("ok");
        }

        // =========================
        // 🔥 SE NÃO FOR IMAGEM
        // =========================
        if (!imageUrl || typeof imageUrl !== "string") {
            console.log("❌ Não é imagem nem texto");
            return res.send("ok");
        }

        console.log("📸 URL da imagem:", imageUrl);

        // 🔥 BAIXAR IMAGEM
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer'
        });

        const base64 = Buffer.from(response.data).toString('base64');

        // 🔥 OPENAI
        const aiResponse = await axios.post(
            "https://api.openai.com/v1/responses",
            {
                model: "gpt-4.1-mini",
                input: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: `
Você é um nutricionista direto e prático.

Analise a refeição de forma profissional.

REGRAS:
- Seja claro e organizado
- Sem exagero
- Foque em ajudar

IMPORTANTE:
- Se não tiver certeza (ex: tipo de suco), pergunte

FORMATO:

*Análise da refeição*

- Alimentos:
• lista simples

- Resumo nutricional:
• Calorias: X kcal
• Proteína: Xg
• Carboidratos: Xg
• Gordura: Xg

- Avaliação:
(comentário útil)

- Sugestão:
(uma dica simples)

- Pergunta:
(se necessário)

Seja direto.
`
                            },
                            {
                                type: "input_image",
                                image_url: `data:image/jpeg;base64,${base64}`
                            }
                        ]
                    }
                ]
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        const texto =
            aiResponse.data.output?.[0]?.content?.[0]?.text ||
            "Não consegui analisar.";

        console.log("🤖 IA respondeu:", texto);

        // 🔥 ENVIA WHATSAPP
        await axios.post(
            `https://api.z-api.io/instances/${process.env.ZAPI_ID}/token/${process.env.ZAPI_TOKEN}/send-text`,
            {
                phone: numero,
                message: `${texto}\n\n*Valores estimados*`
            },
            {
                headers: {
                    "Client-Token": process.env.ZAPI_CLIENT_TOKEN
                }
            }
        );

        res.send("ok");

    } catch (error) {
        console.error("❌ ERRO COMPLETO:");
        console.log(error.response?.data || error.message);
        res.status(500).send("erro");
    }
});

// 🔥 TESTE
app.get('/', (req, res) => {
    res.send("Servidor rodando 🚀");
});

app.listen(process.env.PORT || 3000, () => {
    console.log("✅ NutriBot rodando");
});