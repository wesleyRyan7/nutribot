const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const db = new Pool({
    connectionString: 'postgresql://postgres:nutribot123@localhost:5432/evolution_api'
});

// ==================== BANCO ====================

async function enviarMensagem(numero, mensagem) {
    await axios.post(
        'http://localhost:8080/message/sendText/nutribot-teste',
        { number: numero, text: mensagem },
        { headers: { apikey: process.env.EVOLUTION_API_KEY || 'intelbraS12', 'Content-Type': 'application/json' } }
    );
}

async function buscarUsuario(numero) {
    const r = await db.query('SELECT * FROM usuarios WHERE numero = $1', [numero]);
    return r.rows[0] || null;
}

async function criarUsuario(numero) {
    const r = await db.query('INSERT INTO usuarios (numero) VALUES ($1) RETURNING *', [numero]);
    return r.rows[0];
}

async function atualizarUsuario(numero, dados) {
    const campos = Object.keys(dados).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await db.query(`UPDATE usuarios SET ${campos} WHERE numero = $1`, [numero, ...Object.values(dados)]);
}

async function salvarRefeicao(numero, refeicao, calorias, proteina, carboidratos, gordura) {
    await db.query(
        'INSERT INTO diario (numero, refeicao, calorias, proteina, carboidratos, gordura) VALUES ($1,$2,$3,$4,$5,$6)',
        [numero, refeicao, calorias, proteina, carboidratos, gordura]
    );
}

async function buscarDiarioHoje(numero) {
    const r = await db.query(
        'SELECT * FROM diario WHERE numero = $1 AND data = CURRENT_DATE ORDER BY criado_em',
        [numero]
    );
    return r.rows;
}

function calcularCalorias(peso, altura, objetivo) {
    const tmb = 10 * peso + 6.25 * altura - 5 * 30 + 5;
    const get = tmb * 1.4;
    if (objetivo === 'emagrecer') return Math.round(get - 400);
    if (objetivo === 'ganhar') return Math.round(get + 300);
    return Math.round(get);
}

function verificarTrialAtivo(usuario) {
    if (usuario.plano === 'premium') return true;
    if (!usuario.trial_inicio) return false;
    const dias = (Date.now() - new Date(usuario.trial_inicio).getTime()) / (1000 * 60 * 60 * 24);
    return dias <= 4;
}

// ==================== IA ====================

async function gerarPlanoCompleto(estado) {
    const prompt = `Você é ${estado.apelido_bot}, assistente de nutrição direto e humano.

Dados do usuário:
- Nome: ${estado.nome}
- Objetivo: ${estado.objetivo}
- Peso: ${estado.peso}kg / Altura: ${estado.altura}cm
- Meta calórica: ${estado.calorias} kcal/dia
- Come em: ${estado.alimentacao_local}
- Gosta de comer: ${estado.comida}
- Restrições: ${estado.restricoes}
- Rotina: ${estado.rotina}
- Orçamento: R$${estado.orcamento} ${estado.frequencia_compras}
- Frequência de compras: ${estado.frequencia_compras}

Escreva em 3 mensagens separadas por ---SEPARADOR---

Mensagem 1: boas vindas com nome, confirma objetivo e meta calórica de forma simples

Mensagem 2: plano alimentar do dia com café, almoço, lanche e janta usando alimentos simples e acessíveis baseados no que a pessoa gosta e na realidade dela (empresa, casa, etc). Inclua lista de compras estimada pro orçamento informado

Mensagem 3: plano de treino básico baseado na rotina e objetivo. Se trabalha em pé já conta como atividade. Seja realista e simples

Regras de escrita:
- linguagem humana e direta
- use pq no lugar de porque
- sem pontuação exagerada
- blocos curtos
- sem textos gigantes`;

    const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }] },
        { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    return response.data.choices[0].message.content.split('---SEPARADOR---').map(m => m.trim());
}

async function analisarImagem(base64, mimeType, usuario) {
    const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
            model: 'gpt-4o-mini',
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Você é ${usuario.apelido_bot || 'Wesley Nutricionista'}. Analise a refeição.
Usuário: ${usuario.nome}, objetivo: ${usuario.objetivo}, meta: ${usuario.calorias_diarias} kcal/dia.

Responda APENAS este JSON sem texto adicional:
{
  "refeicao": "descrição breve",
  "calorias": numero,
  "proteina": numero,
  "carboidratos": numero,
  "gordura": numero,
  "mensagem": "análise curta e humana, use pq, sem pontuação exagerada"
}`
                    },
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
                ]
            }]
        },
        { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    return JSON.parse(response.data.choices[0].message.content.replace(/```json|```/g, '').trim());
}

async function responderTexto(mensagem, usuario) {
    const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `Você é ${usuario.apelido_bot || 'Wesley Nutricionista'}, direto e humano.
Usuário: ${usuario.nome}, objetivo: ${usuario.objetivo}, meta: ${usuario.calorias_diarias} kcal/dia.
Resposta curta. Use pq no lugar de porque. Sem pontuação exagerada.`
                },
                { role: 'user', content: mensagem }
            ]
        },
        { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    return response.data.choices[0].message.content;
}

// ==================== ESTADOS ====================

const estados = {};

// ==================== WEBHOOK ====================

app.post('/webhook', async (req, res) => {
    try {
        res.sendStatus(200);

        const body = req.body;
        if (body?.data?.key?.fromMe) return;
        if (body?.event !== 'messages.upsert') return;

        const data = body.data;
        const numero = data?.key?.remoteJid;
        const texto = data?.message?.conversation || data?.message?.extendedTextMessage?.text;
        const temImagem = data?.message?.imageMessage;

        if (!numero) return;
        console.log(`📩 ${numero}: ${texto || '[imagem]'}`);

        let usuario = await buscarUsuario(numero);

        // RESET
        if (texto && ['resetar', 'recomeçar', 'resetar dados', 'recomecar'].includes(texto.toLowerCase().trim())) {
            await db.query('DELETE FROM diario WHERE numero = $1', [numero]);
            await db.query('DELETE FROM usuarios WHERE numero = $1', [numero]);
            delete estados[numero];
            await enviarMensagem(numero, `tudo limpo ✅\n\npode começar do zero`);
            return;
        }

        // USUÁRIO NOVO
        if (!usuario) {
            await criarUsuario(numero);
            estados[numero] = { etapa: 'apresentacao' };
            await enviarMensagem(numero,
                `oi 👋 eu sou seu assistente de nutrição pessoal\n\nnos próximos 4 dias vou te ajudar a:\n\n✅ analisar suas refeições por foto\n✅ montar um plano alimentar do seu jeito\n✅ calcular sua lista de compras pelo seu orçamento\n✅ criar um treino baseado na sua rotina\n✅ acompanhar suas calorias no dia a dia\n\né só seguir e ver o resultado\n\ndigita *começar* pra iniciar`
            );
            return;
        }

        // AGUARDANDO CONFIRMAÇÃO DE INÍCIO
        if (estados[numero]?.etapa === 'apresentacao') {
            if (texto && texto.toLowerCase().includes('come')) {
                estados[numero] = { etapa: 'nome' };
                await enviarMensagem(numero, `boa 💪\n\nprimeiro me diz seu nome`);
            } else {
                await enviarMensagem(numero, `digita *começar* pra iniciar`);
            }
            return;
        }

        // ONBOARDING
        if (estados[numero]) {
            const estado = estados[numero];
            if (!texto) return;
            const txt = texto.trim();

            if (estado.etapa === 'nome') {
                estado.nome = txt;
                estado.etapa = 'apelido_bot';
                await enviarMensagem(numero, `prazer ${txt} 👋\n\ncomo você quer me chamar\n\npode ser um nome, apelido, o que preferir`);
                return;
            }

            if (estado.etapa === 'apelido_bot') {
                estado.apelido_bot = txt;
                estado.etapa = 'objetivo';
                await enviarMensagem(numero, `combinado, pode me chamar de ${txt} 😄\n\nqual seu objetivo\n\n1 emagrecer\n2 ganhar massa\n3 manter o peso`);
                return;
            }

            if (estado.etapa === 'objetivo') {
                const t = txt.toLowerCase();
                if (t.includes('1') || t.includes('emagrec')) estado.objetivo = 'emagrecer';
                else if (t.includes('2') || t.includes('ganhar') || t.includes('massa')) estado.objetivo = 'ganhar';
                else estado.objetivo = 'manter';
                estado.etapa = 'peso';
                await enviarMensagem(numero, `qual seu peso atual em kg\n\nex: 75`);
                return;
            }

            if (estado.etapa === 'peso') {
                const peso = parseFloat(txt.replace(',', '.'));
                if (isNaN(peso) || peso < 30 || peso > 300) {
                    await enviarMensagem(numero, `manda só o número do peso\n\nex: 75`);
                    return;
                }
                estado.peso = peso;
                estado.etapa = 'altura';
                await enviarMensagem(numero, `e sua altura em cm\n\nex: 175`);
                return;
            }

            if (estado.etapa === 'altura') {
                let altura = parseFloat(txt.replace(',', '.'));
                if (isNaN(altura)) {
                    await enviarMensagem(numero, `manda só o número da altura\n\nex: 175`);
                    return;
                }
                if (altura < 3) altura = Math.round(altura * 100);
                estado.altura = altura;
                estado.etapa = 'alimentacao_local';
                await enviarMensagem(numero, `onde você costuma fazer suas refeições\n\nexemplo: em casa, refeitório da empresa, restaurante, como o que tiver`);
                return;
            }

            if (estado.etapa === 'alimentacao_local') {
                estado.alimentacao_local = txt;
                estado.etapa = 'comida';
                await enviarMensagem(numero, `o que você costuma comer no dia a dia\n\nme conta sua alimentação atual`);
                return;
            }

            if (estado.etapa === 'comida') {
                estado.comida = txt;
                estado.etapa = 'restricoes';
                await enviarMensagem(numero, `tem algum alimento que não gosta ou alergia a algo`);
                return;
            }

            if (estado.etapa === 'restricoes') {
                estado.restricoes = txt;
                estado.etapa = 'rotina';
                await enviarMensagem(numero, `como é sua rotina\n\ntrabalha sentado, em pé, faz exercício, pratica algum esporte`);
                return;
            }

            if (estado.etapa === 'rotina') {
                estado.rotina = txt;
                estado.etapa = 'orcamento';
                await enviarMensagem(numero, `quanto você tem pra gastar com alimentação\n\nex: R$300 por semana ou R$800 por mês`);
                return;
            }

            if (estado.etapa === 'orcamento') {
                const match = txt.match(/[\d.,]+/);
                estado.orcamento = match ? parseFloat(match[0].replace(',', '.')) : 0;
                estado.etapa = 'frequencia_compras';
                await enviarMensagem(numero, `você faz compras semanal ou mensal`);
                return;
            }

            if (estado.etapa === 'frequencia_compras') {
                estado.frequencia_compras = txt.toLowerCase().includes('semana') ? 'semanal' : 'mensal';
                estado.calorias = calcularCalorias(estado.peso, estado.altura, estado.objetivo);

                await atualizarUsuario(numero, {
                    nome: estado.nome,
                    apelido_bot: estado.apelido_bot,
                    objetivo: estado.objetivo,
                    peso: estado.peso,
                    altura: estado.altura,
                    calorias_diarias: estado.calorias,
                    alimentacao_local: estado.alimentacao_local,
                    comida: estado.comida,
                    restricoes: estado.restricoes,
                    rotina: estado.rotina,
                    orcamento: estado.orcamento,
                    frequencia_compras: estado.frequencia_compras
                });

                delete estados[numero];

                await enviarMensagem(numero, `perfeito ${estado.nome} ✅\n\ndeixa eu montar teu plano completo`);

                const mensagens = await gerarPlanoCompleto(estado);
                for (const msg of mensagens) {
                    if (msg) await enviarMensagem(numero, msg);
                    await new Promise(r => setTimeout(r, 1500));
                }

                await enviarMensagem(numero,
                    `pronto 🎯\n\nagora é só mandar foto das suas refeições que eu analiso na hora\n\nqualquer dúvida é só perguntar\n\ne se quiser assinar o plano mensal pra ter acesso completo é só digitar *assinar*`
                );
                return;
            }
        }

        // ASSINAR
        if (texto && texto.toLowerCase().trim() === 'assinar') {
            await enviarMensagem(numero,
                `plano mensal 💳\n\ncom a assinatura você tem:\n\n✅ análise ilimitada de fotos\n✅ plano alimentar atualizado toda semana\n✅ treino progressivo semana a semana\n✅ resumo automático no final do dia\n✅ lista de compras detalhada\n✅ suporte ilimitado\n\nclique no link pra assinar:\n\n[LINK DO MERCADO PAGO AQUI]\n\naps o pagamento me manda o comprovante que libero seu acesso na hora`
            );
            return;
        }

        // COMPROVANTE
        if (texto && texto.toLowerCase().includes('comprovante')) {
            // Aqui futuramente vai a verificação automática do Mercado Pago
            await enviarMensagem(numero,
                `recebi o comprovante ✅\n\nvou verificar e liberar seu acesso em instantes`
            );
            return;
        }

        // TRIAL EXPIRADO
        if (!verificarTrialAtivo(usuario)) {
            await enviarMensagem(numero,
                `seu teste de 4 dias encerrou 😊\n\ngostou do que viu\n\ndigita *assinar* pra continuar com acesso completo`
            );
            return;
        }

        // IMAGEM
        if (temImagem) {
            console.log('📸 Baixando imagem...');
            const mediaResponse = await axios.post(
                'http://localhost:8080/chat/getBase64FromMediaMessage/nutribot-teste',
                { message: { key: data.key, message: data.message } },
                { headers: { apikey: process.env.EVOLUTION_API_KEY || 'intelbraS12', 'Content-Type': 'application/json' } }
            );

            const base64 = mediaResponse.data.base64;
            const mimeType = mediaResponse.data.mimetype || 'image/jpeg';

            usuario = await buscarUsuario(numero);
            console.log('🧠 Analisando...');
            const analise = await analisarImagem(base64, mimeType, usuario);

            await salvarRefeicao(numero, analise.refeicao, analise.calorias, analise.proteina, analise.carboidratos, analise.gordura);

            const diario = await buscarDiarioHoje(numero);
            const total = diario.reduce((acc, r) => acc + (r.calorias || 0), 0);
            const restante = Math.max(0, usuario.calorias_diarias - total);

            await enviarMensagem(numero, `${analise.mensagem}\n\n📊 *resumo do dia*\nconsumido: ${total} kcal\nmeta: ${usuario.calorias_diarias} kcal\nrestante: ${restante} kcal`);
            console.log('✅ Análise enviada');
            return;
        }

        // TEXTO LIVRE
        if (texto) {
            usuario = await buscarUsuario(numero);
            const resposta = await responderTexto(texto, usuario);
            await enviarMensagem(numero, resposta);
            return;
        }

    } catch (error) {
        console.error('❌ ERRO:', error.response?.data || error.message);
    }
});

app.get('/', (req, res) => res.send('NutriBot rodando 🚀'));

app.listen(process.env.PORT || 3000, () => {
    console.log('✅ NutriBot rodando');
});