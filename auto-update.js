const { execSync } = require('child_process');

function update() {
    try {
        const result = execSync('git pull origin main', { cwd: 'C:\\nutribot' }).toString();
        if (result.includes('Already up to date')) return;
        console.log('Atualizacao detectada, reiniciando...');
        execSync('pm2 restart nutribot');
        console.log('Bot reiniciado com sucesso');
    } catch (e) {
        console.error('Erro no auto-update:', e.message);
    }
}

update();
setInterval(update, 60000);