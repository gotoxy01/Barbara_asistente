@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Configurar Bárbara

echo.
echo  Este paso crea el archivo .env y la base de datos en esta PC.
echo  Si se abre el Bloc de notas, complete los datos, guarde y cierre esa ventana.
echo.

where npm >nul 2>&1
if errorlevel 1 (
  echo  No está Node.js. Instálelo desde https://nodejs.org ^(versión 22^) y vuelva a intentar.
  echo.
  pause
  exit /b 1
)

call npm run setup
echo.
if errorlevel 1 (
  echo  No se pudo terminar. Lea el mensaje de arriba, corrija .env y vuelva a ejecutar este archivo.
) else (
  echo  Configuración lista. Ahora puede abrir iniciar-barbara.bat
)
echo.
pause
