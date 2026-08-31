@echo off
chcp 65001 >nul
title Automacao GitHub - DiscordScreen-Railway
cd /d D:\DiscordScreen-Railway

echo [1/5] Verificando Git e GitHub CLI...
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Git nao encontrado. Por favor, instale o Git manualmente em https://git-scm.com/
    pause
    exit
)

where gh >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] GitHub CLI nao encontrado. Por favor, instale o GitHub CLI em https://cli.github.com/
    pause
    exit
)

echo [2/5] Inicializando repositorio Git...
if not exist ".git" (
    git init
) else (
    echo [+] Repositorio Git ja inicializado.
)

echo [3/5] Criando .gitignore padrao...
if not exist ".gitignore" (
    echo node_modules/> .gitignore
    echo .env>> .gitignore
    echo __pycache__/>> .gitignore
    echo venv/>> .gitignore
)

echo [4/5] Adicionando arquivos e fazendo commit...
git add .
git commit -m "Commit automatico via script .bat" 2>nul

echo [5/5] Criando repositorio no GitHub e enviando...
set /p repo_name="Digite o nome do repositorio (ex: DiscordScreen-Railway): "
if "%repo_name%"=="" set repo_name=DiscordScreen-Railway

set /p visibilidade="Deseja repositorio Publico ou Privado? (digite public ou private): "
if "%visibilidade%"=="" set visibilidade=private

gh auth status >nul 2>&1
if %errorlevel% neq 0 (
    echo Voce precisa fazer login no GitHub. Siga as instrucoes abaixo:
    gh auth login
)

gh repo create %repo_name% --%visibilidade% --source=. --remote=origin --push

echo.
echo ==========================================
echo Processo concluido com sucesso!
echo ==========================================
pause