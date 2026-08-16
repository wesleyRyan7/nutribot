const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const db = new Pool({ connectionString: "postgresql://postgres:nutribot123@localhost:5432/evolution_api" });
const INSTANCE = "nutribot-teste";
const API_KEY = process.env.EVOLUTION_API_KEY || "intelbraS12";

async function enviarMensagem(numero, mensagem) {
    try {
        await axios.post("http://localhost:8080/message/sendText/" + INSTANCE, { number: numero, text: mensagem }, { headers: { apikey: API_KEY, "Content-Type": "application/json" } });
    } catch (e) { console.error("Erro envio:", e.message); }
}

async function enviarDigitando(numero, segundos) {
    try {
        await axios.post("http://localhost:8080/chat/presence/" + INSTANCE, { number: numero, presence: "composing", delay: (segundos || 2) * 1000 }, { headers: { apikey: API_KEY, "Content-Type": "application/json" } });
        await new Promise(r => setTimeout(r, (segundos || 2) * 1000));
    } catch (e) {}
}

async function buscarUsuario(numero) {
    const r = await db.query("SELECT * FROM usuarios WHERE numero = $1", [numero]);
    return r.rows[0] || null;
}

async function criarUsuario(numero) {
    const r = await db.query("INSERT INTO usuarios (numero, estado, plano) VALUES ($1, 'apresentacao', 'trial') RETURNING *", [numero]);
    return r.rows[0];
}

async function atualizarUsuario(numero, dados) {
    const campos = Object.keys(dados).map((k, i) => k + " = $" + (i + 2)).join(", ");
    await db.query("UPDATE usuarios SET " + campos + " WHERE numero = $1", [numero, ...Object.values(dados)]);
}

async function salvarRefeicao(numero, refeicao, calorias, proteina, carboidratos, gordura) {
    await db.query("INSERT INTO diario (numero, refeicao, calorias, proteina, carboidratos, gordura, horario) VALUES ($1,$2,$3,$4,$5,$6, CURRENT_TIME)", [numero, refeicao, calorias, proteina, carboidratos, gordura]);
}

async function buscarDiarioHoje(numero) {
    const r = await db.query("SELECT * FROM diario WHERE numero = $1 AND data = CURRENT_DATE ORDER BY criado_em", [numero]);
    return r.rows;
}

function calcularCalorias(peso, altura, objetivo) {
    const tmb = 10 * peso + 6.25 * altura - 5 * 30 + 5;
    const get = tmb * 1.4;
    if (objetivo === "emagrecer") return Math.round(get - 400);
    if (objetivo === "ganhar") return Math.round(get + 300);
    return Math.round(get);
}

function verificarTrialAtivo(usuario) {
    if (usuario.plano === "premium") return true;
    if (!usuario.trial_inicio) return false;
    const dias = (Date.now() - new Date(usuario.trial_inicio).getTime()) / (1000 * 60 * 60 * 24);
    return dias <= 4;
}

function getDados(usuario) {
    try { return usuario.estado_dados ? JSON.parse(usuario.estado_dados) : {}; } catch { return {}; }
}

function horaAtual() {
    return new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
}

async function chamarOpenAI(messages, max_tokens) {
    const response = await axios.post("https://api.openai.com/v1/chat/completions", { model: "gpt-4o-mini", messages, max_tokens: max_tokens || 300 }, { headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" } });
    return response.data.choices[0].message.content;
}

async function gerarPlano(usuario) {
    const prompt = "Voce e " + (usuario.apelido_bot || "nutri") + ", nutricionista direto e humano.\n\nPerfil:\n- " + usuario.nome + ", " + usuario.objetivo + "\n- " + usuario.peso + "kg / " + usuario.altura + "cm / meta: " + usuario.calorias_diarias + " kcal\n- Proteina: " + Math.round(usuario.peso * 1.8) + "g / Carbo: " + Math.round(usuario.calorias_diarias * 0.4 / 4) + "g / Gordura: " + Math.round(usuario.calorias_diarias * 0.25 / 9) + "g\n- Come em: " + usuario.alimentacao_local + "\n- Gosta de: " + usuario.comida + "\n- Restricoes: " + usuario.restricoes + "\n- Rotina: " + usuario.rotina + "\n- Orcamento: R$" + usuario.orcamento + " " + usuario.frequencia_compras + "\n\nEscreva 3 mensagens curtas separadas por ---SEP---\n1: boas vindas + meta calorica + macros do dia (proteina carbo gordura)\n2: plano alimentar simples pro dia baseado na realidade da pessoa + lista de compras enxuta\n3: treino simples e realista\n\nRegras: frases curtas, sem enrolacao, use pq, sem pontuacao exagerada";
    const resposta = await chamarOpenAI([{ role: "user", content: prompt }], 600);
    return resposta.split("---SEP---").map(m => m.trim()).filter(m => m);
}

async function analisarImagem(base64, mimeType, usuario, diario) {
    const totalAtual = diario.reduce((acc, r) => acc + (r.calorias || 0), 0);
    const restante = Math.max(0, usuario.calorias_diarias - totalAtual);
    const prompt = "Voce e " + (usuario.apelido_bot || "nutri") + ". Analise a refeicao.\nUsuario: " + usuario.nome + " / meta: " + usuario.calorias_diarias + " kcal / ja consumiu: " + totalAtual + " kcal / restante: " + restante + " kcal\nObjetivo: " + usuario.objetivo + "\n\nResponda APENAS JSON:\n{\"refeicao\": \"descricao curta\", \"calorias\": numero, \"proteina\": numero, \"carboidratos\": numero, \"gordura\": numero, \"mensagem\": \"analise curta em 2 linhas max, fale se ta bom ou ruim pro objetivo, seja direto e honesto\"}";
    const resposta = await chamarOpenAI([{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: "data:" + mimeType + ";base64," + base64 } }] }], 300);
    return JSON.parse(resposta.replace(/```json|```/g, "").trim());
}

async function transcreverAudio(base64, mimeType) {
    try {
        const FormData = require("form-data");
        const form = new FormData();
        const buffer = Buffer.from(base64, "base64");
        form.append("file", buffer, { filename: "audio.ogg", contentType: mimeType || "audio/ogg" });
        form.append("model", "whisper-1");
        form.append("language", "pt");
        const response = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, { headers: { ...form.getHeaders(), Authorization: "Bearer " + process.env.OPENAI_API_KEY } });
        return response.data.text;
    } catch (e) {
        console.error("Erro transcricao:", e.message);
        return null;
    }
}

async function responderTexto(mensagem, usuario, diario) {
    const totalAtual = diario.reduce((acc, r) => acc + (r.calorias || 0), 0);
    const restante = Math.max(0, usuario.calorias_diarias - totalAtual);
    const refeicoes = diario.map(r => r.refeicao + " (" + r.calorias + " kcal as " + (r.horario ? r.horario.substring(0, 5) : "?") + "h)").join(", ");

    const system = "Voce e " + (usuario.apelido_bot || "nutri") + ", nutricionista direto, honesto e as vezes rigoroso.\n" +
        "Usuario: " + usuario.nome + " / objetivo: " + usuario.objetivo + " / meta: " + usuario.calorias_diarias + " kcal\n" +
        "Macros diarios: proteina " + Math.round(usuario.peso * 1.8) + "g / carbo " + Math.round(usuario.calorias_diarias * 0.4 / 4) + "g / gordura " + Math.round(usuario.calorias_diarias * 0.25 / 9) + "g\n" +
        "Consumido hoje: " + totalAtual + " kcal / restante: " + restante + " kcal\n" +
        "Refeicoes de hoje: " + (refeicoes || "nenhuma registrada") + "\n" +
        "Hora atual: " + horaAtual() + "\n\n" +
        "Regras: frases curtas, sem enrolacao, use pq, seja honesto e direto. Se a pessoa desleixou cobra. Se faltam calorias sugira algo especifico pra fechar. Se comeu errado fala. Max 4 linhas.";

    return await chamarOpenAI([{ role: "system", content: system }, { role: "user", content: mensagem }], 200);
}

async function processarOnboarding(numero, usuario, texto) {
    const estado = usuario.estado;
    const dados = getDados(usuario);
    await enviarDigitando(numero, 1);

    if (estado === "apresentacao") {
        if (texto && texto.toLowerCase().includes("come")) { await atualizarUsuario(numero, { estado: "nome" }); await enviarMensagem(numero, "qual seu nome"); }
        else { await enviarMensagem(numero, "digita comecar pra iniciar"); }
        return;
    }
    if (estado === "nome") {
        dados.nome = texto.trim();
        await atualizarUsuario(numero, { nome: dados.nome, estado: "apelido_bot", estado_dados: JSON.stringify(dados) });
        await enviarMensagem(numero, "prazer " + dados.nome + "\n\ncomo voce quer me chamar");
        return;
    }
    if (estado === "apelido_bot") {
        dados.apelido_bot = texto.trim();
        await atualizarUsuario(numero, { apelido_bot: dados.apelido_bot, estado: "objetivo", estado_dados: JSON.stringify(dados) });
        await enviarMensagem(numero, "combinado\n\nqual seu objetivo\n\n1 emagrecer\n2 ganhar massa\n3 manter o peso");
        return;
    }
    if (estado === "objetivo") {
        const t = texto.toLowerCase();
        if (t.includes("1") || t.includes("emagrec")) dados.objetivo = "emagrecer";
        else if (t.includes("2") || t.includes("ganhar") || t.includes("massa")) dados.objetivo = "ganhar";
        else dados.objetivo = "manter";
        await atualizarUsuario(numero, { objetivo: dados.objetivo, estado: "peso", estado_dados: JSON.stringify(dados) });
        await enviarMensagem(numero, "qual seu peso em kg\n\nex: 75");
        return;
    }
    if (estado === "peso") {
        const peso = parseFloat(texto.replace(",", "."));
        if (isNaN(peso) || peso < 30 || peso > 300) { await enviarMensagem(numero, "manda so o numero\n\nex: 75"); return; }
        dados.peso = peso;
        await atualizarUsuario(numero, { peso: dados.peso, estado: "altura", estado_dados: JSON.stringify(dados) });
        await enviarMensagem(numero, "altura em cm\n\nex: 175");
        return;
    }
    if (estado === "altura") {
        let altura = parseFloat(texto.replace(",", "."));
        if (isNaN(altura)) { await enviarMensagem(numero, "manda so o numero\n\nex: 175"); return; }
        if (altura < 3) altura = Math.round(altura * 100);
        dados.altura = altura;
        await atualizarUsuario(numero, { altura: dados.altura, estado: "alimentacao_local", estado_dados: JSON.stringify(dados) });
        await enviarMensagem(numero, "onde voce faz suas refeicoes\n\n1 em casa\n2 refeitorio da empresa\n3 restaurante\n4 como o que tiver");
        return;
    }
    if (estado === "alimentacao_local") {
        const t = texto.toLowerCase();
        if (t.includes("1") || t.includes("casa")) dados.alimentacao_local = "em casa";
        else if (t.includes("2") || t.includes("refeit") || t.includes("empresa")) dados.alimentacao_local = "refeitorio da empresa";
        else if (t.includes("3") || t.includes("restaur")) dados.alimentacao_local = "restaurante";
        else dados.alimentacao_local = "como o que tiver";
        await atualizarUsuario(numero, { alimentacao_local: dados.alimentacao_local, estado: "comida", estado_dados: JSON.stringify(dados) });
        await enviarMensagem(numero, "o que voce mais gosta de comer\n\npode listar a vontade");
        return;
    }
    if (estado === "comida") {
        dados.comida = texto.trim();
        await atualizarUsuario(numero, { comida: dados.comida, estado: "restricoes", estado_dados: JSON.stringify(dados) });
        await enviarMensagem(numero, "tem algum alimento que nao gosta ou alergia\n\nse nao tiver manda nao");
        return;
    }
    if (estado === "restricoes") {
        dados.restricoes = texto.trim();
        await atualizarUsuario(numero, { restricoes: dados.restricoes, estado: "rotina", estado_dados: JSON.stringify(dados) });
        await enviarMensagem(numero, "como e sua rotina\n\n1 trabalho sentado\n2 trabalho em pe\n3 faco exercicio\n4 combinacao");
        return;
    }
    if (estado === "rotina") {
        dados.rotina = texto.trim();
        await atualizarUsuario(numero, { rotina: dados.rotina, estado: "orcamento", estado_dados: JSON.stringify(dados) });
        await enviarMensagem(numero, "quanto tem pra gastar com alimentacao\n\nex: 300 por semana ou 800 por mes");
        return;
    }
    if (estado === "orcamento") {
        const match = texto.match(/[\d.,]+/);
        dados.orcamento = match ? parseFloat(match[0].replace(",", ".")) : 300;
        await atualizarUsuario(numero, { orcamento: dados.orcamento, estado: "frequencia_compras", estado_dados: JSON.stringify(dados) });
        await enviarMensagem(numero, "faz compras\n\n1 semanal\n2 mensal");
        return;
    }
    if (estado === "frequencia_compras") {
        dados.frequencia_compras = (texto.toLowerCase().includes("1") || texto.toLowerCase().includes("semana")) ? "semanal" : "mensal";
        const calorias = calcularCalorias(dados.peso || 70, dados.altura || 170, dados.objetivo || "manter");
        await atualizarUsuario(numero, { frequencia_compras: dados.frequencia_compras, calorias_diarias: calorias, estado: "ativo", estado_dados: null });
        await enviarMensagem(numero, "perfeito montando seu plano...");
        const usuarioAtualizado = await buscarUsuario(numero);
        const mensagens = await gerarPlano(usuarioAtualizado);
        for (const msg of mensagens) { if (msg) { await enviarDigitando(numero, 2); await enviarMensagem(numero, msg); } }
        await enviarMensagem(numero, "pronto\n\nmanda foto das refeicoes que eu analiso\npode mandar audio tambem descrevendo o que comeu\n\nduvidas e so perguntar");
        return;
    }
}

// ==================== NOTIFICACOES ====================

async function enviarNotificacoes() {
    try {
        const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
        const hora = agora.getHours();
        const minuto = agora.getMinutes();

        const usuarios = await db.query("SELECT * FROM usuarios WHERE estado = 'ativo' AND (plano = 'premium' OR trial_inicio > NOW() - INTERVAL '4 days')");

        for (const usuario of usuarios.rows) {
            const diario = await buscarDiarioHoje(usuario.numero);
            const total = diario.reduce((acc, r) => acc + (r.calorias || 0), 0);
            const restante = Math.max(0, usuario.calorias_diarias - total);
            const nome = usuario.nome || "voce";

            // 8h - bom dia e pergunta que horas acordou
            if (hora === 8 && minuto < 2) {
                await enviarMensagem(usuario.numero, "bom dia " + nome + "\n\nque horas voce acordou hoje");
            }

            // 12h - lembrete almoco
            if (hora === 12 && minuto < 2) {
                await enviarMensagem(usuario.numero, "ta na hora do almoco " + nome + "\n\nta pensando em comer o que\n\nmanda foto quando fizer");
            }

            // 15h - lanche da tarde
            if (hora === 15 && minuto < 2 && total < usuario.calorias_diarias * 0.6) {
                await enviarMensagem(usuario.numero, "lembrete do lanche " + nome + "\n\nvocê consumiu " + total + " kcal\nfaltam " + restante + " kcal\n\njá fez algum lanche hoje");
            }

            // 20h - resumo do dia
            if (hora === 20 && minuto < 2) {
                if (total > 0) {
                    const msg = total < usuario.calorias_diarias * 0.7
                        ? "oi " + nome + "\n\nconsumistecomeu pouco hoje\n" + total + " de " + usuario.calorias_diarias + " kcal\n\nfaltam " + restante + " kcal\n\npode comer mais ainda ta no horario"
                        : "resumo do dia " + nome + "\n\n" + total + " de " + usuario.calorias_diarias + " kcal\nfaltam " + restante + " kcal\n\nboa noite";
                    await enviarMensagem(usuario.numero, msg);
                } else {
                    await enviarMensagem(usuario.numero, nome + " nao registrou nada hoje\n\ncomeu alguma coisa ou passou em branco\n\nmanda o que comeu que eu calculo tudo");
                }
            }

            // 21h - cobrar quem sumiu
            if (hora === 21 && minuto < 2 && total === 0) {
                await enviarMensagem(usuario.numero, nome + " sumiu o dia todo\n\ncomeu o que hoje\n\nnao precisa ter vergonha manda tudo que eu calculo");
            }

            // cobrar intervalo longo sem registro
            const ultimaRefeicao = diario.length > 0 ? new Date(diario[diario.length - 1].criado_em) : null;
            if (ultimaRefeicao && hora >= 14 && hora <= 19) {
                const horasSemComer = (agora - ultimaRefeicao) / (1000 * 60 * 60);
                if (horasSemComer >= 5 && minuto < 2) {
                    await enviarMensagem(usuario.numero, "faz " + Math.round(horasSemComer) + "h que voce nao registra nada " + nome + "\n\ncomeu alguma coisa nesse intervalo\n\nmanda foto ou me conta o que foi");
                }
            }
        }
    } catch (e) {
        console.error("Erro notificacoes:", e.message);
    }
}

setInterval(enviarNotificacoes, 2 * 60 * 1000);

// ==================== WEBHOOK ====================

app.post("/webhook", async (req, res) => {
    try {
        res.sendStatus(200);
        const body = req.body;
        if (body?.data?.key?.fromMe) return;
        if (body?.event !== "messages.upsert") return;
        const data = body.data;
        const numero = data?.key?.remoteJid;
        const texto = data?.message?.conversation || data?.message?.extendedTextMessage?.text;
        const temImagem = data?.message?.imageMessage;
        const temAudio = data?.message?.audioMessage || data?.message?.pttMessage;

        if (!numero) return;
        if (numero.endsWith("@g.us")) return;

        if (!global.debounceTimers) global.debounceTimers = {};
        if (global.debounceTimers[numero]) clearTimeout(global.debounceTimers[numero]);
        await new Promise(resolve => { global.debounceTimers[numero] = setTimeout(resolve, 6000); });
        delete global.debounceTimers[numero];

        console.log("📩 " + numero + ": " + (texto || (temImagem ? "[imagem]" : temAudio ? "[audio]" : "[outro]")));

        await atualizarUsuario(numero, { ultima_mensagem: new Date() }).catch(() => {});

        let usuario = await buscarUsuario(numero);

        // COMANDO ADMIN
        if (texto && texto.toLowerCase().startsWith("admin#trial#")) {
            const dias = parseInt(texto.split("#")[2]) || 4;
            const novaData = new Date(Date.now() - (4 - dias) * 24 * 60 * 60 * 1000);
            await db.query("UPDATE usuarios SET trial_inicio = $1, plano = 'trial' WHERE numero = $2", [novaData, numero]);
            await enviarMensagem(numero, "trial estendido por " + dias + " dias");
            return;
        }

        // RESET
        if (texto && ["resetar", "recomecar", "resetar dados"].includes(texto.toLowerCase().trim())) {
            await db.query("DELETE FROM diario WHERE numero = $1", [numero]);
            await db.query("DELETE FROM usuarios WHERE numero = $1", [numero]);
            await enviarMensagem(numero, "tudo limpo\npode comecar do zero");
            return;
        }

        // USUARIO NOVO
        if (!usuario) {
            usuario = await criarUsuario(numero);
            await enviarDigitando(numero, 2);
            await enviarMensagem(numero, "oi sou seu assistente de nutricao\n\nnos proximos 4 dias vou te ajudar a\n\n1 analisar refeicoes por foto ou audio\n2 montar plano alimentar personalizado\n3 calcular lista de compras\n4 criar treino baseado na sua rotina\n5 acompanhar suas calorias\n\ne so seguir e ver o resultado\n\ndigita comecar");
            return;
        }

        // ONBOARDING
        if (usuario.estado && usuario.estado !== "ativo") {
            if (!texto) return;
            await processarOnboarding(numero, usuario, texto);
            return;
        }

        // TRIAL EXPIRADO
        if (!verificarTrialAtivo(usuario)) {
            await enviarDigitando(numero, 1);
            await enviarMensagem(numero, "seu teste encerrou\n\ngostou do resultado\n\ndigita assinar pra continuar");
            return;
        }

        // ASSINAR
        if (texto && texto.toLowerCase().trim() === "assinar") {
            await enviarDigitando(numero, 1);
            await enviarMensagem(numero, "plano mensal\n\n1 analise ilimitada de fotos e audios\n2 plano alimentar semanal\n3 treino progressivo\n4 resumo diario automatico\n5 lista de compras detalhada\n6 suporte ilimitado\n\n[LINK DO PAGAMENTO AQUI]\n\naps pagar manda o comprovante");
            return;
        }

        const diario = await buscarDiarioHoje(numero);

        // AUDIO
        if (temAudio) {
            console.log("🎤 Audio recebido...");
            await enviarDigitando(numero, 3);
            const mediaResponse = await axios.post("http://localhost:8080/chat/getBase64FromMediaMessage/" + INSTANCE, { message: { key: data.key, message: data.message } }, { headers: { apikey: API_KEY, "Content-Type": "application/json" } }).catch(() => null);

            if (mediaResponse?.data?.base64) {
                const transcricao = await transcreverAudio(mediaResponse.data.base64, mediaResponse.data.mimetype);
                if (transcricao) {
                    console.log("Transcricao:", transcricao);
                    usuario = await buscarUsuario(numero);
                    const resposta = await responderTexto(transcricao, usuario, diario);
                    await enviarMensagem(numero, resposta);
                    return;
                }
            }
            await enviarMensagem(numero, "nao consegui entender o audio\n\npode digitar ou mandar foto");
            return;
        }

        // IMAGEM
        if (temImagem) {
            console.log("📸 Imagem recebida...");
            await enviarDigitando(numero, 3);
            const mediaResponse = await axios.post("http://localhost:8080/chat/getBase64FromMediaMessage/" + INSTANCE, { message: { key: data.key, message: data.message } }, { headers: { apikey: API_KEY, "Content-Type": "application/json" } });
            const base64 = mediaResponse.data.base64;
            const mimeType = mediaResponse.data.mimetype || "image/jpeg";
            usuario = await buscarUsuario(numero);
            const analise = await analisarImagem(base64, mimeType, usuario, diario);
            await salvarRefeicao(numero, analise.refeicao, analise.calorias, analise.proteina, analise.carboidratos, analise.gordura);
            const diarioAtualizado = await buscarDiarioHoje(numero);
            const total = diarioAtualizado.reduce((acc, r) => acc + (r.calorias || 0), 0);
            const restante = Math.max(0, usuario.calorias_diarias - total);
            const macroMsg = "P: " + analise.proteina + "g | C: " + analise.carboidratos + "g | G: " + analise.gordura + "g";
            await enviarMensagem(numero, analise.mensagem + "\n\n" + macroMsg + "\n\ndia: " + total + "/" + usuario.calorias_diarias + " kcal | falta: " + restante + " kcal");
            return;
        }

        // TEXTO
        if (texto) {
            // detecta horario que acordou
            if (texto.toLowerCase().includes("acordei") || texto.toLowerCase().includes("acordou")) {
                const horaMatch = texto.match(/(\d{1,2})[h:]/i);
                if (horaMatch) {
                    await db.query("UPDATE usuarios SET hora_acordou = $1 WHERE numero = $2", [horaMatch[1] + ":00", numero]);
                }
            }

            await enviarDigitando(numero, 2);
            usuario = await buscarUsuario(numero);
            const resposta = await responderTexto(texto, usuario, diario);
            await enviarMensagem(numero, resposta);
            return;
        }

    } catch (error) { console.error("ERRO:", error.response?.data || error.message); }
});

app.get("/", (req, res) => res.send("NutriBot rodando"));
app.listen(process.env.PORT || 3000, () => { console.log("NutriBot rodando"); });