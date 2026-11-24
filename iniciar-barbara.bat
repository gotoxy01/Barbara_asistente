@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Bárbara - Abasto Los Cuchos
color 0A

echo.
echo  ==================================================
echo.
echo        INICIANDO BÁRBARA - ABASTO LOS CUCHOS
echo.
echo  ==================================================
echo.
echo  Carpeta: %cd%
echo  Modo: WhatsApp Cloud API en esta PC
echo  Hace falta PostgreSQL local y DATABASE_URL en .env
echo  El tunel (cloudflared) debe apuntar a http://127.0.0.1:3000
echo  Para dejarla siempre encendida use NSSM o: npx pm2 start src/server.js --name barbara
echo  Respaldo con codigo QR: npm run start:qr
echo  Para detener a Bárbara presione Ctrl+C.
echo.

call npm start

echo.
echo  Bárbara se detuvo. Si hubo un error, puede leerlo arriba.
pause
