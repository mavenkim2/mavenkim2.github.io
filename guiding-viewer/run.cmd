@echo off
setlocal
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
    if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
        set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    ) else (
        echo Node.js is required. Install Node.js or add node.exe to PATH.
        pause
        exit /b 1
    )
)
"%NODE_EXE%" "%~dp0serve.mjs" --open %*
if errorlevel 1 pause
