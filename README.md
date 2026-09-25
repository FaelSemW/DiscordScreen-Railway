# DC Screen Sharing

Aplicativo de transmissão de tela para Windows, com servidor local, acesso pelo navegador e integração com Discord Activity. Código aberto sob a [licença MIT](LICENSE).

## Baixar

Os executáveis estão em [Releases](https://github.com/FaelSemW/DiscordScreen-Railway/releases/latest):

- **DC-Screen-Sharing-Setup-1.1.0.exe**: instalador com atalhos.
- **DC-Screen-Sharing-Portable-1.1.0.exe**: abra diretamente, sem instalar.

Ambos são para Windows x64 e incluem o auxiliar de áudio e o cloudflared. A versão portátil extrai os arquivos temporariamente ao abrir; configurações e logs permanecem em `%APPDATA%\DC Screen Sharing`, como na versão instalada. Ela não precisa de Node.js ou .NET previamente instalados. Encerre a versão anterior pela bandeja antes de abrir outra versão.

## Usar

1. Abra o aplicativo e siga a configuração apresentada na interface. A integração com o Discord requer uma aplicação própria no Discord Developer Portal.
2. Escolha a tela ou janela, a qualidade e a captura de áudio.
3. Inicie a transmissão e compartilhe o acesso à sala.
4. Você pode minimizar o aplicativo enquanto transmite. Para encerrar, use o botão de parar ou saia pela bandeja.

A qualidade se adapta à carga do computador e da conexão, inclusive com vídeo integrado. O aplicativo tenta recuperar quedas de conexão e falhas do capturador. Suspensão do Windows, perda de internet e limitações do navegador ainda podem interromper a sessão. Quick Tunnels podem mudar de endereço ao reiniciar.

No iPhone, abra a transmissão no Safari e toque no botão PiP. Se aparecer “Preparando o vídeo”, aguarde o carregamento e toque novamente. O suporte depende da versão do iOS e do navegador incorporado.

## Compilar a partir do código

Requisitos para o desktop: Windows x64, Git, Node.js 22.12+ com npm e .NET SDK 10. O .NET é necessário para compilar o auxiliar de captura de áudio.

```powershell
git clone https://github.com/FaelSemW/DiscordScreen-Railway.git
cd DiscordScreen-Railway
npm ci
npm run desktop:prepare
npm run build
npm run desktop
```

`desktop:prepare` compila o auxiliar a partir de `desktop/native/DCSS.AudioCapture` e baixa o cloudflared 2026.9.1 da distribuição oficial, verificando o SHA256. Binários gerados ficam fora do Git.

```powershell
npm run desktop:build     # instalador
npm run desktop:portable  # executável sem instalação
npm run desktop:release   # ambos em dist/
```

## Servidor separado / Railway

O desktop inicia seu próprio servidor local. Para hospedar o servidor separadamente:

```powershell
npm ci
npm run build
Copy-Item .env.example .env
# Preencha .env antes de iniciar.
npm start
```

Em produção, configure `NODE_ENV=production`, `PUBLIC_ORIGIN` com a URL HTTPS pública e um `SESSION_SECRET` aleatório. As variáveis opcionais de integração estão em `.env.example`. Nunca publique seus tokens. O `Dockerfile` permite construir o serviço para Railway; a verificação de saúde está em `/api/health`.

## Desenvolvimento e testes

```powershell
npm test
npm run test:soak
# Teste sintético prolongado, opcional:
node tests/run-native-soak.js --seconds=7200
```

A suíte inclui testes do player, reconexão, adaptação de qualidade e Electron. O teste sintético usa vídeo gerado; não substitui testes com jogos, áudio real, internet ou um iPhone físico.

Estrutura: `desktop/` contém o aplicativo Electron e a captura; `client/`, o player; `server/`, as salas e o relay WebSocket; `shared/`, o protocolo; `tests/`, os testes de integração.

Leia [CONTRIBUTING.md](CONTRIBUTING.md) para contribuir e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) para as licenças dos componentes distribuídos. O projeto não tem vínculo oficial com o Discord.
