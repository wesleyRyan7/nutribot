const fs = require("fs");

const image = fs.readFileSync("sua-imagem.png");
const base64 = image.toString("base64");

console.log(base64);