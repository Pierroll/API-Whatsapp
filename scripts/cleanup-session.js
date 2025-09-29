// scripts/cleanup-session.js
const fs = require('fs');

const paths = [
  './auth_info_baileys',
  './qr-code.png'
];

function rmSafe(p) {
  try {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`🧹 eliminado: ${p}`);
    }
  } catch (e) {
    console.error(`⚠️ no pude eliminar ${p}:`, e.message);
  }
}

(async () => {
  try {
    // mata procesos locales (opcional, no hace nada si no existen)
    try { require('child_process').execSync('pkill -f "node src/app.js" 2>/dev/null || true'); } catch {}

    // logs *.log en raíz
    const root = fs.readdirSync('.');
    root.filter(f => f.endsWith('.log')).forEach(f => paths.push(`./${f}`));

    // carpeta logs (descomenta si la usas)
    // paths.push('./logs');

    paths.forEach(rmSafe);

    console.log('✅ Limpieza completada. Vuelve a iniciar tu app y escanea el QR.');
    process.exit(0);
  } catch (e) {
    console.error('❌ Error en cleanup:', e);
    process.exit(1);
  }
})();
