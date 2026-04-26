const axios = require('axios');
require('dotenv').config();

async function listarModelos() {
    try {
        const key = process.env.GEMINI_API_KEY;
        const res = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        console.log("MODELOS DISPONÍVEIS PARA VOCÊ:");
        res.data.models.forEach(m => console.log("- " + m.name));
    } catch (e) {
        console.error("Erro ao listar:", e.response ? e.response.data : e.message);
    }
}
listarModelos();