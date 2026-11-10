@echo off
chcp 65001 >nul
title Onyx WhatsApp PC - Motor Open Source Gratuito
cd /d "%~dp0"

echo ====================================================================
echo   ONYX / BARBERFLOW - PUENTE GRATUITO DE WHATSAPP DESDE TU PC
echo ====================================================================
echo.

if not exist "node_modules" (
    echo [1/2] Instalando librerias open-source locales por unica vez...
    call npm.cmd install
    echo.
)

echo [2/2] Iniciando servidor y abriendo Panel de Control en http://localhost:3005 ...
start "" "http://localhost:3005"
node src/index.mjs
pause
