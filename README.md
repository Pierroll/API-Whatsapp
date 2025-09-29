# API-Whatsapp
API_WHATSAPP


1) Preparar e iniciar en local (dev)
# 1.1 Instalar dependencias
pnpm install

# 1.2 Iniciar el servidor (usa PORT del .env si existe; si no, 3000)
pnpm run dev

# 1.3 Probar health (no requiere API key)
curl http://localhost:3000/health

# 1.4 Ver estado (requiere API key)
curl -H "X-API-Key: TU_API_KEY" http://localhost:3000/api/status

# 1.5 Obtener QR en JSON (para escanear con WhatsApp)
curl -H "X-API-Key: TU_API_KEY" http://localhost:3000/api/qr

# 1.6 Obtener QR como imagen (descarga un PNG)
curl -H "X-API-Key: TU_API_KEY" "http://localhost:3000/api/qr?format=image" --output qr.png

# 1.7 Enviar un mensaje (formato internacional SIN +)
curl -X POST http://localhost:3000/api/send \
  -H "X-API-Key: TU_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"51907690125","message":"Hola!"}'

# 1.8 Ver últimos mensajes que recibió el bot
curl -H "X-API-Key: TU_API_KEY" "http://localhost:3000/api/messages?limit=50"


Cambia localhost:3000 por tu puerto real si usas otro (por ejemplo 3002).

2) Limpiar sesión y archivos (local)
# 2.1 Limpiar por script (borra auth_info_baileys, qr, *.log)
pnpm run cleanup

# 2.2 (Opcional) Cerrar sesión por API
curl -X POST http://localhost:3000/api/logout \
  -H "X-API-Key: TU_API_KEY"


3) Preparar y correr en producción con PM2 (VPS)
# 3.1 Instalar dependencias en el VPS
pnpm install

# 3.2 Iniciar con PM2 usando tu ecosystem.config.js (ya define PORT=3002 y API_KEY)
pm2 start ecosystem.config.js

# 3.3 Ver estado y logs
pm2 status
pm2 logs whatsapp-api

# 3.4 Reiniciar / detener / borrar
pm2 restart whatsapp-api
pm2 stop whatsapp-api
pm2 delete whatsapp-api

# 3.5 Persistir tras reinicio del VPS
pm2 save
pm2 startup   # sigue las instrucciones que imprime

4) Probar la API en el VPS (PM2 en 3002 según tu ecosystem)
# 4.1 Health (sin API key)
curl http://TU_IP_O_DOMINIO:3002/health

# 4.2 Estado
curl -H "X-API-Key: TU_API_KEY" http://TU_IP_O_DOMINIO:3002/api/status

# 4.3 QR en JSON
curl -H "X-API-Key: TU_API_KEY" http://TU_IP_O_DOMINIO:3002/api/qr

# 4.4 Enviar mensaje
curl -X POST http://TU_IP_O_DOMINIO:3002/api/send \
  -H "X-API-Key: TU_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"51907690125","message":"Hola desde VPS!"}'

5) Limpieza en producción (VPS)
# 5.1 Parar y borrar en PM2 (libera puerto y memoria)
pm2 stop whatsapp-api 2>/dev/null || true
pm2 delete whatsapp-api 2>/dev/null || true
pm2 flush

# 5.2 Borrar sesión y archivos (nuevo QR al iniciar)
rm -rf ./auth_info_baileys
rm -f ./qr-code.png
find . -maxdepth 1 -type f -name "*.log" -delete

# 5.3 Volver a levantar
pm2 start ecosystem.config.js
pm2 logs whatsapp-api

6) Puertos ocupados (debug)
# Ver quién usa el puerto (ej: 3000 o 3002)
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:3002 -sTCP:LISTEN

# Matar por PID
kill -9 <PID>

7) Enviar varios mensajes (mini bulk desde bash)
for n in 51911111111 51922222222 51933333333; do
  curl -s -X POST http://localhost:3000/api/send \
    -H "X-API-Key: TU_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"to\":\"$n\",\"message\":\"Promo 🔥\"}"
  echo
done

8) Recordatorios rápidos
# No mezcles PM2 y pnpm run dev al mismo tiempo sobre el mismo archivo
# Asegura .gitignore:
#   node_modules/
#   .env
#   auth_info_baileys/
#   qr-code.png
#   *.log