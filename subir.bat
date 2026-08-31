@echo off
chcp 65001 >nul
title Automação GitHub - DiscordScreen-Railway

echo [1/6] Verificando dependencias...

REM Verifica se o Git esta instalado
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Git nao encontrado. Baixando e instalando o Git automaticamente...
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/git-for-windows/git/releases/download/v2.44.0.windows.1/Git-2.44.0-64-bit.exe' -OutFile '%TEMP%\git_installer.exe'"
    echo [i] Instalando o Git (isso pode levar alguns segundos)...
    start /wait "" "%TEMP%\git_installer.exe" /VERYSILENT /NORESTART
    REM Atualiza o PATH da sessao atual
    set "PATH=%PATH%;C:\Program Files\Git\cmd"
) else (
    echo [+] Git ja esta instalado.
)

REM Verifica se o GitHub CLI (gh) esta instalado (necessario para criar o repositorio via linha de comando)
where gh >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] GitHub CLI (gh) nao encontrado. Baixando e instalando...
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cli/cli/releases/download/v2.45.0/gh_2.45.0_windows_amd64.msi' -OutFile '%TEMP%\gh_installer.msi'"
    echo [i] Instalando o GitHub CLI...
    msiexec /i "%TEMP%\gh_installer.msi" /quiet /norestart
    set "PATH=%PATH%;C:\Program Files\GitHub CLI\"
) else (
    echo [+] GitHub CLI ja esta instalado.
)

REM Verifica se o usuario esta autenticado no GitHub CLI
gh auth status >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [?] Voce precisa fazer login no GitHub. Uma janela/instrucao sera aberta.
    gh auth login
)

echo.
echo [2/6] Inicializando repositorio Git local...
if not exist ".git" (
    git init
) else (
    echo [+] Repositorio Git ja inicializado.
)

echo [3/6] Configurando arquivo .gitignore padrao...
if not exist ".gitignore" (
    (
        echo node_modules/
        echo .env
        echo __pycache__/
        echo venv/
        echo .DS_Store
    ) > .gitignore
    echo [+] Arquivo .gitignore criado.
)

echo [4/6] Adicionando arquivos e fazendo commit...
git add .
git diff --cached --quiet
if %errorlevel% neq 0 (
    git commit -m "Commit automatico via script .bat"
) else (
    echo [+] Nenhum arquivo novo para commitar.
)

echo [5/6] Criando repositorio no GitHub...
set /p repo_name="Digite o nome que deseja para o repositorio no GitHub (ex: DiscordScreen-Railway): "
if "%repo_name%"=="" set repo_name=DiscordScreen-Railway

set /p visibilidade="O repositorio deve ser Publico ou Privado? (digite public ou private): "
if "%visibilidade%"=="" set visibilidade=private

gh repo create %repo_name% --%visibilidade% --source=. --remote=origin --push

echo.
echo ==========================================
echo [6/6] Projeto enviado com sucesso para o GitHub!
echo ==========================================
pause