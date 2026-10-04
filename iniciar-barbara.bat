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
echo  Para detener a Bárbara presione Ctrl+C.
echo.

call npm start

echo.
echo  Bárbara se detuvo. Si hubo un error, puede leerlo arriba.
pause
